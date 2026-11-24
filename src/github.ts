import { execFile } from "node:child_process"
import { Schema } from "effect"
import type { Pull, PullStatus } from "./rpc.ts"

// The OpenCode service is started by launchd, so its PATH usually lacks Homebrew.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":")

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, PATH, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} ${args[0]} failed: ${stderr.trim() || error.message}`))
        else resolve(stdout)
      },
    )
  })
}

const PULL_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

export function pullUrls(text: string): string[] {
  return [...new Set([...text.matchAll(PULL_URL)].map((match) => `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`))]
}

export function parsePull(url: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(url)
  if (!match) return undefined
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

/** Resolves a PR URL, or a PR number in the repository checked out at `directory`. */
export async function resolvePull(ref: string, directory: string): Promise<string | undefined> {
  const [url] = pullUrls(ref)
  if (url) return url
  if (!/^#?\d+$/.test(ref.trim())) return undefined
  const output = await run("gh", ["pr", "view", ref.trim().replace("#", ""), "--json", "url", "--jq", ".url"], directory)
  return pullUrls(output)[0]
}

/** The PR for the branch checked out at `directory`, preferring an open one. Default branches have none. */
export async function branchPull(directory: string): Promise<string | undefined> {
  const branch = (await run("git", ["-C", directory, "branch", "--show-current"]).catch(() => "")).trim()
  if (!branch || branch === "main" || branch === "master") return undefined
  const base = (await run("git", ["-C", directory, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => ""))
    .trim()
    .replace(/^origin\//, "")
  if (branch === base) return undefined
  const output = await run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "all", "--limit", "5", "--json", "url,state"],
    directory,
  )
  const pulls = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ url: Schema.String, state: Schema.String })))(
    JSON.parse(output),
  )
  return (pulls.find((pull) => pull.state === "OPEN") ?? pulls[0])?.url
}

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title url state isDraft mergeable mergeStateStatus reviewDecision headRefName headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated
        opener: comments(first: 1) { nodes { author { login __typename } body path line url } }
        latest: comments(last: 1) { nodes { id author { login __typename } body url } }
      } }
      comments(last: 30) { nodes { id author { login __typename } body url } }
      reviews(last: 30) { nodes { id author { login __typename } state body url } }
    }
  }
}`

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String, __typename: Schema.String }))
const Nodes = <S extends Schema.Top>(node: S) => Schema.Struct({ nodes: Schema.Array(node) })

const Response = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            number: Schema.Number,
            title: Schema.String,
            url: Schema.String,
            state: Schema.String,
            isDraft: Schema.Boolean,
            mergeable: Schema.String,
            mergeStateStatus: Schema.String,
            reviewDecision: Schema.NullOr(Schema.String),
            headRefName: Schema.String,
            headRefOid: Schema.String,
            commits: Nodes(
              Schema.Struct({
                commit: Schema.Struct({
                  statusCheckRollup: Schema.NullOr(
                    Schema.Struct({
                      contexts: Nodes(
                        Schema.Union([
                          Schema.Struct({
                            __typename: Schema.Literal("CheckRun"),
                            name: Schema.String,
                            status: Schema.String,
                            conclusion: Schema.NullOr(Schema.String),
                            detailsUrl: Schema.NullOr(Schema.String),
                          }),
                          Schema.Struct({
                            __typename: Schema.Literal("StatusContext"),
                            context: Schema.String,
                            state: Schema.String,
                            targetUrl: Schema.NullOr(Schema.String),
                          }),
                        ]),
                      ),
                    }),
                  ),
                }),
              }),
            ),
            reviewThreads: Nodes(
              Schema.Struct({
                id: Schema.String,
                isResolved: Schema.Boolean,
                isOutdated: Schema.Boolean,
                opener: Nodes(
                  Schema.Struct({
                    author: Author,
                    body: Schema.String,
                    path: Schema.String,
                    line: Schema.NullOr(Schema.Number),
                    url: Schema.String,
                  }),
                ),
                latest: Nodes(Schema.Struct({ id: Schema.String, author: Author, body: Schema.String, url: Schema.String })),
              }),
            ),
            comments: Nodes(Schema.Struct({ id: Schema.String, author: Author, body: Schema.String, url: Schema.String })),
            reviews: Nodes(
              Schema.Struct({
                id: Schema.String,
                author: Author,
                state: Schema.String,
                body: Schema.String,
                url: Schema.String,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
})

const decodeResponse = Schema.decodeUnknownSync(Response)

export interface Item {
  readonly id: string
  readonly text: string
}

/** Everything one poll learns about a PR: what the UI shows and what auto-fix compares between polls. */
export interface Snapshot {
  readonly pull: Pull
  readonly terminal: boolean
  /** Failing checks on the head commit, keyed by commit and check name. */
  readonly failed: readonly Item[]
  /** Unresolved, current review threads started by someone else whose latest comment is not the viewer's. */
  readonly threads: readonly Item[]
  /** Top-level comments from people other than the viewer. Bots are left out: their actionable feedback arrives as threads. */
  readonly comments: readonly Item[]
  /** Reviews from others that ask for changes, or that a person left with a message. */
  readonly reviews: readonly Item[]
  readonly conflict: boolean
}

const excerpt = (body: string) => {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > 280 ? `${text.slice(0, 277)}...` : text
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"])

export async function fetchPull(url: string): Promise<Snapshot> {
  const ref = parsePull(url)
  if (!ref) throw new Error(`Not a GitHub pull request URL: ${url}`)
  const output = await run("gh", [
    "api",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-f",
    `owner=${ref.owner}`,
    "-f",
    `repo=${ref.repo}`,
    "-F",
    `number=${ref.number}`,
  ])
  const { data } = decodeResponse(JSON.parse(output))
  const pr = data.repository?.pullRequest
  if (!pr) throw new Error(`Pull request not found: ${url}`)
  const viewer = data.viewer.login
  const other = (author: typeof Author.Type) => author?.login !== viewer

  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  const checks = contexts.map((context) =>
    context.__typename === "CheckRun"
      ? {
          name: context.name,
          url: context.detailsUrl,
          failed: FAILED.has(context.conclusion ?? ""),
          pending: context.status !== "COMPLETED",
        }
      : {
          name: context.context,
          url: context.targetUrl,
          failed: FAILED.has(context.state),
          pending: context.state === "PENDING" || context.state === "EXPECTED",
        },
  )
  const failed = checks
    .filter((check) => check.failed)
    .map((check) => ({
      id: `${pr.headRefOid}:${check.name}`,
      text: `CI check "${check.name}" failed on ${pr.headRefOid.slice(0, 7)}${check.url ? ` (${check.url})` : ""}`,
    }))
  const pending = checks.filter((check) => check.pending).length

  const unresolved = pr.reviewThreads.nodes.filter((thread) => {
    const opener = thread.opener.nodes[0]
    return !thread.isResolved && !thread.isOutdated && opener !== undefined && other(opener.author)
  })
  // Keyed by the latest comment, so a reviewer's reply to an answered thread counts as new. Threads whose last word is
  // the viewer's are waiting on the reviewer.
  const threads = unresolved.flatMap((thread) => {
    const opener = thread.opener.nodes[0]
    const latest = thread.latest.nodes[0]
    if (!opener || !latest || !other(latest.author)) return []
    const where = opener.line ? `${opener.path}:${opener.line}` : opener.path
    const reply = latest.url === opener.url ? "" : ` Latest reply from ${latest.author?.login ?? "unknown"}: "${excerpt(latest.body)}"`
    return [
      {
        id: `${thread.id}:${latest.id}`,
        text: `Review thread from ${opener.author?.login ?? "unknown"} on ${where}: "${excerpt(opener.body)}"${reply} (${latest.url})`,
      },
    ]
  })
  const comments = pr.comments.nodes.flatMap((comment) =>
    other(comment.author) && comment.author?.__typename !== "Bot"
      ? [{ id: comment.id, text: `Comment from ${comment.author?.login ?? "unknown"}: "${excerpt(comment.body)}" (${comment.url})` }]
      : [],
  )
  const reviews = pr.reviews.nodes.flatMap((review) => {
    const human = review.author?.__typename !== "Bot"
    const asks = review.state === "CHANGES_REQUESTED" || (human && review.state === "COMMENTED" && excerpt(review.body))
    if (!other(review.author) || !asks) return []
    const verdict = review.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed"
    const body = excerpt(review.body)
    return [{ id: review.id, text: `${review.author?.login ?? "unknown"} ${verdict}${body ? `: "${body}"` : ""} (${review.url})` }]
  })
  const conflict = pr.state === "OPEN" && pr.mergeable === "CONFLICTING"

  const [status, detail] = ((): [PullStatus, string] => {
    if (pr.state === "MERGED") return ["merged", "Merged"]
    if (pr.state === "CLOSED") return ["closed", "Closed"]
    if (failed.length > 0) return ["failing", failed.length === 1 ? "1 check failing" : `${failed.length} checks failing`]
    if (conflict) return ["conflict", "Merge conflict"]
    if (pr.isDraft) return ["draft", "Draft"]
    if (pr.reviewDecision === "CHANGES_REQUESTED") return ["changes", "Changes requested"]
    if (unresolved.length > 0)
      return ["changes", unresolved.length === 1 ? "1 unresolved thread" : `${unresolved.length} unresolved threads`]
    if (pending > 0) return ["pending", "Checks running"]
    if (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "HAS_HOOKS") return ["ready", "Ready to merge"]
    if (pr.mergeStateStatus === "BEHIND") return ["open", "Behind base branch"]
    if (pr.reviewDecision === "REVIEW_REQUIRED") return ["open", "Review required"]
    return ["open", "Open"]
  })()

  return {
    pull: {
      url: pr.url,
      repo: `${ref.owner}/${ref.repo}`,
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      status,
      detail,
    },
    terminal: status === "merged" || status === "closed",
    failed,
    threads,
    comments,
    reviews,
    conflict,
  }
}
