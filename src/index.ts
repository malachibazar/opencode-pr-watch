import { Option, Schema } from "effect"
import { Plugin } from "@opencode/plugin"
import { branchPull, fetchPull, pullUrls, resolvePull, type Snapshot } from "./github.ts"
import { Pull, PrWatch, type Watch } from "./rpc.ts"

const POLL_MS = 60_000
const BRANCH_RECHECK_MS = 5 * 60_000
/** Auto-fix turns itself off after this many wake-ups on one PR without the PR becoming ready. */
const MAX_WAKES = 10

const Tracked = Schema.Struct({
  pull: Pull,
  /** Item ids present at the last poll; anything missing from here next time is new. */
  seen: Schema.Array(Schema.String),
  wakes: Schema.Number,
})
type Tracked = typeof Tracked.Type

const Entry = Schema.Struct({
  directory: Schema.String,
  autofix: Schema.Boolean,
  archiveOnMerge: Schema.Boolean,
  pulls: Schema.Record(Schema.String, Tracked),
  dismissed: Schema.Array(Schema.String),
  branchChecked: Schema.Number,
})
type Entry = typeof Entry.Type

const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodeShellInput = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }))
// In-process calls fail with the core error; the HTTP client's `isSessionNotFoundError` only knows the API's name for it.
const isSessionNotFound = Schema.is(Schema.Struct({ _tag: Schema.Literal("Session.NotFoundError") }))

const PREFIX = "watch/"
const terminal = (pull: Pull) => pull.status === "merged" || pull.status === "closed"

/** Work that stays open until someone acts on it. Comments and reviews have no resolved state, so they only count when new. */
const outstanding = (snapshot: Snapshot) => [
  ...snapshot.failed,
  ...snapshot.threads,
  ...(snapshot.conflict ? [{ id: "conflict", text: "The PR has merge conflicts with its base branch." }] : []),
]

const items = (snapshot: Snapshot) => [...outstanding(snapshot), ...snapshot.comments, ...snapshot.reviews]

const view = (sessionID: string, entry: Entry | undefined): Watch => ({
  sessionID,
  autofix: entry?.autofix ?? false,
  archiveOnMerge: entry?.archiveOnMerge ?? false,
  pulls: Object.values(entry?.pulls ?? {}).map((tracked) => tracked.pull),
})

const wakeText = (pull: Pull, lines: readonly string[]) =>
  [
    `GitHub activity on PR #${pull.number} (${pull.url}), branch \`${pull.branch}\`:`,
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "Auto-fix is on for this PR. Work through each item: check that review feedback is correct before changing code, fix what is actionable, run the relevant checks, then commit and push to the PR branch. Reply to review threads with what you changed or why you disagree, and resolve the ones you addressed. If an item needs a human decision, stop and say so instead of guessing.",
  ].join("\n")

export default Plugin.define({
  id: "pr-watch",
  async setup(ctx) {
    const directory = ctx.location.directory
    // Branch discovery only makes sense where one session owns the checkout.
    const isWorktree = directory !== ctx.location.project.canonical
    const log = (message: string, error?: unknown) =>
      console.error(`[pr-watch] ${message}`, error instanceof Error ? error.message : (error ?? ""))

    const blank = (): Entry => ({ directory, autofix: false, archiveOnMerge: false, pulls: {}, dismissed: [], branchChecked: 0 })
    const load = async (sessionID: string) => Option.getOrUndefined(decodeEntry(await ctx.storage.get(PREFIX + sessionID)))

    // Every read-modify-write of one session's entry goes through here, so polls, commands and the UI never lose updates.
    const locks = new Map<string, Promise<unknown>>()
    const update = (sessionID: string, fn: (entry: Entry | undefined) => Promise<Entry | undefined>) => {
      const next = (locks.get(sessionID) ?? Promise.resolve()).then(async () => {
        const entry = await fn(await load(sessionID))
        if (entry) await ctx.storage.set(PREFIX + sessionID, entry)
        return entry
      })
      locks.set(sessionID, next.catch(() => undefined))
      return next.then((entry) => {
        if (entry) void registration.events.emit("updated", view(sessionID, entry)).catch((error) => log("emit failed", error))
        return entry
      })
    }

    // Never a session message: an idle session holds a synthetic one until its next turn and then hands it to the
    // agent, and beside a wake-up it races to become the turn's input.
    const notify = (sessionID: string, text: string) =>
      registration.events
        .emit("notice", { id: `${sessionID}:${Date.now()}`, sessionID, text })
        .catch((error) => log("notice failed", error))

    /** Wakes the session with the new items, counting toward the runaway limit. */
    const wake = async (sessionID: string, entry: Entry, tracked: Tracked, lines: readonly string[]): Promise<Entry> => {
      if (!entry.autofix || lines.length === 0) return entry
      if (tracked.wakes >= MAX_WAKES) {
        await notify(
          sessionID,
          `Auto-fix paused: it woke the session ${MAX_WAKES} times for PR #${tracked.pull.number} without the PR becoming ready. Run /autofix on to resume.`,
        )
        return { ...entry, autofix: false }
      }
      await ctx.session.prompt({
        sessionID,
        text: wakeText(tracked.pull, lines),
        delivery: "queue",
        metadata: { source: "pr-watch", pull: tracked.pull.url },
      })
      return { ...entry, pulls: { ...entry.pulls, [tracked.pull.url]: { ...tracked, wakes: tracked.wakes + 1 } } }
    }

    /**
     * Fetches one PR and folds it into the entry: status-change events, auto-fix wake-ups and auto-archive.
     * `handOver` wakes for everything outstanding instead of only what is new since the last poll.
     */
    const sync = async (sessionID: string, entry: Entry, url: string, handOver: boolean): Promise<Entry> => {
      const snapshot = await fetchPull(url)
      const previous = entry.pulls[url]
      const current = items(snapshot)
      const seen = new Set(previous?.seen ?? current.map((item) => item.id))
      const tracked: Tracked = {
        pull: snapshot.pull,
        seen: current.map((item) => item.id),
        wakes: snapshot.pull.status === "ready" ? 0 : (previous?.wakes ?? 0),
      }
      let next: Entry = { ...entry, pulls: { ...entry.pulls, [url]: tracked } }
      if (previous && previous.pull.status !== snapshot.pull.status) {
        await registration.events.emit("changed", {
          id: `${url}:${snapshot.pull.status}:${Date.now()}`,
          sessionID,
          previous: previous.pull.status,
          pull: snapshot.pull,
        })
      }
      if (!snapshot.terminal) {
        const incoming = (handOver ? outstanding(snapshot) : current.filter((item) => !seen.has(item.id))).map((item) => item.text)
        next = await wake(sessionID, next, tracked, incoming)
      }
      const finished = Object.values(next.pulls).every((other) => terminal(other.pull))
      if (snapshot.terminal && previous && !terminal(previous.pull) && finished && next.archiveOnMerge)
        await ctx.session.update({ sessionID, archived: true })
      return next
    }

    const track = (sessionID: string, url: string) =>
      update(sessionID, async (entry) => {
        const base = entry ?? blank()
        if (base.pulls[url]) return base
        // With auto-fix already on, a newly tracked PR's existing feedback is handed over too.
        return sync(sessionID, { ...base, dismissed: base.dismissed.filter((item) => item !== url) }, url, base.autofix)
      })

    const discover = async (sessionID: string) => {
      if (!isWorktree) return
      const session = await ctx.session.get({ sessionID })
      if (session.parentID || session.location.directory !== directory) return
      const url = await branchPull(directory)
      const entry = await update(sessionID, async (entry) => ({ ...(entry ?? blank()), branchChecked: Date.now() }))
      if (url && entry && !entry.dismissed.includes(url) && !entry.pulls[url]) await track(sessionID, url)
    }

    const needsDiscovery = (entry: Entry | undefined) =>
      !entry || (Object.keys(entry.pulls).length === 0 && Date.now() - entry.branchChecked > BRANCH_RECHECK_MS)

    const status = async (sessionID: string) => {
      if (needsDiscovery(await load(sessionID)))
        await discover(sessionID).catch((error) => log(`branch lookup failed for ${sessionID}`, error))
      return view(sessionID, await load(sessionID))
    }

    const configure = async (sessionID: string, patch: { autofix?: boolean; archiveOnMerge?: boolean }) =>
      view(
        sessionID,
        await update(sessionID, async (entry) => {
          const base = entry ?? blank()
          let next: Entry = { ...base, ...patch }
          // Turning auto-fix on hands the session everything outstanding, not just what arrives later.
          if (patch.autofix && !base.autofix) {
            for (const tracked of Object.values(next.pulls)) {
              if (terminal(tracked.pull)) continue
              const reset = { ...next, pulls: { ...next.pulls, [tracked.pull.url]: { ...tracked, wakes: 0 } } }
              next = await sync(sessionID, reset, tracked.pull.url, true)
            }
          }
          return next
        }),
      )

    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        let after: string | undefined
        do {
          const page = await ctx.storage.scan({ prefix: PREFIX, after, limit: 100 })
          for (const { key, value } of page.entries) {
            const entry = Option.getOrUndefined(decodeEntry(value))
            if (!entry || entry.directory !== directory) continue
            const sessionID = key.slice(PREFIX.length)
            const deleted = await ctx.session.get({ sessionID }).then(() => false, isSessionNotFound)
            if (deleted) {
              await ctx.storage.remove(key)
              continue
            }
            if (needsDiscovery(entry)) await discover(sessionID).catch((error) => log(`branch lookup failed for ${sessionID}`, error))
            for (const tracked of Object.values(entry.pulls)) {
              if (terminal(tracked.pull)) continue
              await update(sessionID, async (current) =>
                current?.pulls[tracked.pull.url] ? sync(sessionID, current, tracked.pull.url, false) : undefined,
              ).catch((error) => log(`poll failed for ${tracked.pull.url}`, error))
            }
          }
          after = page.next
        } while (after)
      } finally {
        polling = false
      }
    }

    const registration = await ctx.rpc.register(PrWatch, {
      status: async ({ sessionID }) => status(sessionID),
      refresh: async ({ sessionID }) =>
        view(
          sessionID,
          await update(sessionID, async (entry) => {
            if (!entry) return undefined
            let next = entry
            for (const url of Object.keys(entry.pulls)) next = await sync(sessionID, next, url, false)
            return next
          }),
        ),
      configure: async ({ sessionID, ...patch }) => configure(sessionID, patch),
      track: async ({ sessionID, pull }, context) => {
        const session = await ctx.session.get({ sessionID })
        const url = await resolvePull(pull, session.location.directory).catch(() => undefined)
        if (!url) return context.error("invalid_pull", `Not a pull request: ${pull}`, { pull })
        return view(sessionID, await track(sessionID, url))
      },
      dismiss: async ({ sessionID, url }) =>
        view(
          sessionID,
          await update(sessionID, async (entry) => {
            if (!entry) return undefined
            const { [url]: _, ...pulls } = entry.pulls
            return { ...entry, pulls, dismissed: [...new Set([...entry.dismissed, url])] }
          }),
        ),
    })

    // Pick up PRs the agent opens with `gh pr create`.
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const command = Option.getOrUndefined(decodeShellInput(event.input))?.command
      if (!command?.includes("gh pr create")) return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.location.directory !== directory) return
      for (const url of pullUrls(JSON.stringify(event.result)))
        await track(event.sessionID, url).catch((error) => log(`track failed for ${url}`, error))
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "autofix",
        description: "Wake this session when its PR fails CI, gets review feedback, or conflicts. /autofix [on|off|<PR URL or number>]",
        execute: async ({ sessionID, prompt }) => {
          const argument = prompt.text.trim()
          if (argument && argument !== "on" && argument !== "off") {
            const session = await ctx.session.get({ sessionID })
            const url = await resolvePull(argument, session.location.directory).catch(() => undefined)
            if (!url) return void (await notify(sessionID, `"${argument}" is not a pull request URL or number.`))
            await track(sessionID, url)
          }
          const before = await status(sessionID)
          const enable = argument === "off" ? false : argument ? true : !before.autofix
          const watch = await configure(sessionID, { autofix: enable })
          if (!enable) return void (await notify(sessionID, "Auto-fix is off for this session."))
          const open = watch.pulls.filter((pull) => !terminal(pull))
          if (open.length === 0) {
            const done = watch.pulls.map((pull) => `#${pull.number} is ${pull.status}`).join(", ")
            return void (await notify(
              sessionID,
              done
                ? `Auto-fix is on, but ${done}, so there is nothing to watch.`
                : "Auto-fix is on, but this session has no pull request yet. Watching starts when the agent runs `gh pr create`.",
            ))
          }
          const names = open.map((pull) => `#${pull.number} (${pull.detail})`).join(", ")
          await notify(sessionID, `Auto-fix is on for ${names}. The session wakes up when CI fails, review feedback arrives, or a merge conflict appears.`)
        },
      })
    })

    void poll().catch((error) => log("poll failed", error))
    const timer = setInterval(() => void poll().catch((error) => log("poll failed", error)), POLL_MS)
    return () => clearInterval(timer)
  },
})
