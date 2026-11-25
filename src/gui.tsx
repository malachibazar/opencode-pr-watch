import { onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  ComposerPill,
  createKeyed,
  Plugin,
  type ComposerPillRow,
  type ComposerPillTone,
  type IconName,
} from "@opencode/plugin/gui"
import { PrWatch, type Pull, type PullStatus, type Watch } from "./rpc.ts"

// Most urgent first: the pill shows the most urgent open PR.
const ORDER: readonly PullStatus[] = ["failing", "conflict", "changes", "pending", "open", "draft", "ready", "merged", "closed"]

const TONE: Record<PullStatus, ComposerPillTone | undefined> = {
  failing: "danger",
  conflict: "danger",
  changes: "warning",
  pending: "warning",
  open: undefined,
  draft: undefined,
  ready: "success",
  merged: "success",
  closed: undefined,
}

const ICON: Record<PullStatus, IconName> = {
  failing: "circle-x",
  conflict: "warning",
  changes: "comment",
  pending: "status-active",
  open: "branch",
  draft: "edit",
  ready: "circle-check",
  merged: "check",
  closed: "circle-ban-sign",
}

// The host sizes the pill's menu to its widest row, so long PR titles would stretch it across the window.
const clip = (text: string, max = 50) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

const NOTIFY: Partial<Record<PullStatus, (pull: Pull) => { title: string; variant?: "error" }>> = {
  ready: (pull) => ({ title: `PR #${pull.number} is ready to merge` }),
  merged: (pull) => ({ title: `PR #${pull.number} merged` }),
  closed: (pull) => ({ title: `PR #${pull.number} closed` }),
  failing: (pull) => ({ title: `PR #${pull.number}: ${pull.detail}`, variant: "error" }),
  conflict: (pull) => ({ title: `PR #${pull.number} has merge conflicts`, variant: "error" }),
}

export default Plugin.define({
  setup(ctx) {
    const [watches, setWatches] = createStore<Record<string, Watch>>({})
    const save = (watch: Watch) => setWatches(watch.sessionID, reconcile(watch))
    const server = () => ctx.servers.get("sidecar")

    // Live updates from every location's plugin instance, resubscribed when the server restarts.
    createKeyed(
      () => server()?.client,
      (client) => {
        const api = client.rpc(PrWatch)
        onCleanup(api.events.on("updated", (event) => save(event.data)))
        onCleanup(api.events.on("notice", (event) => void ctx.toast.show({ title: "Auto-fix", description: event.data.text })))
        onCleanup(
          api.events.on("changed", (event) => {
            const message = NOTIFY[event.data.pull.status]?.(event.data.pull)
            if (!message) return
            void ctx.attention.notify({
              ...message,
              message: event.data.pull.title,
              session: { server: "sidecar", id: event.data.sessionID },
              id: event.data.id,
            })
          }),
        )
      },
    )

    // Ask the session's own location for its PRs whenever another session is routed. A location that has not booted
    // yet answers `rpc.unavailable` until its plugins finish loading, so retry a few times.
    createKeyed(
      () => {
        const session = ctx.sessions.current()
        return session?.server.builtin ? { id: session.id, directory: session.directory } : undefined
      },
      (session) => {
        let cancelled = false
        onCleanup(() => (cancelled = true))
        const attempt = (left: number): void => {
          server()
            ?.client.rpc(PrWatch)
            .status({ sessionID: session.id }, { location: { directory: session.directory } })
            .then(save)
            .catch((error: unknown) => {
              if (cancelled) return
              if (left > 0) setTimeout(() => !cancelled && attempt(left - 1), 2_000)
              else console.error("[pr-watch] status failed", error)
            })
        }
        attempt(3)
      },
      { equals: (a, b) => a.id === b.id && a.directory === b.directory },
    )

    ctx.add(ComposerPill, {
      id: "pulls",
      show: (input) => {
        if (!input.session.server.builtin) return undefined
        const watch = watches[input.session.id]
        if (!watch || watch.pulls.length === 0) return undefined
        const sessionID = input.session.id
        const location = { location: { directory: input.session.directory } }
        const rank = (pull: Pull) => ORDER.indexOf(pull.status)
        const pulls = [...watch.pulls].sort((a, b) => rank(a) - rank(b))
        const lead = pulls[0]!
        const api = () => server()!.client.rpc(PrWatch)
        const run = (fn: () => Promise<Watch>) => () =>
          void fn().then(save).catch((error: unknown) =>
            ctx.toast.show({ variant: "error", title: "PR watch failed", description: String(error) }),
          )

        const rows: ComposerPillRow[] = [
          ...pulls.map((pull) => ({
            id: pull.url,
            label: `#${pull.number} ${clip(pull.title)}`,
            icon: ICON[pull.status],
            tone: TONE[pull.status],
            detail: pull.detail,
            run: () => ctx.system.openExternal(pull.url),
          })),
          {
            id: "autofix",
            label: watch.autofix ? "Auto-fix is on" : "Turn on auto-fix",
            icon: watch.autofix ? "check" : "refresh",
            tone: watch.autofix ? "success" : undefined,
            run: run(() => api().configure({ sessionID, autofix: !watch.autofix }, location)),
          },
          {
            id: "archive",
            label: "Auto-archive on merge or close",
            icon: watch.archiveOnMerge ? "check" : "archive",
            run: run(() => api().configure({ sessionID, archiveOnMerge: !watch.archiveOnMerge }, location)),
          },
          { id: "refresh", label: "Refresh now", icon: "refresh", run: run(() => api().refresh({ sessionID }, location)) },
          ...pulls.map((pull) => ({
            id: `dismiss:${pull.url}`,
            label: `Dismiss #${pull.number}`,
            icon: "close-small" as const,
            run: run(() => api().dismiss({ sessionID, url: pull.url }, location)),
          })),
        ]

        return {
          icon: ICON[lead.status],
          tone: TONE[lead.status],
          label: pulls.length === 1 ? `#${lead.number} · ${lead.detail}` : `${pulls.length} PRs · ${lead.detail}`,
          title: pulls.length === 1 ? lead.title : "Pull requests",
          rows,
        }
      },
    })
  },
})
