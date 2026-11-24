# opencode-pr-watch

An [OpenCode](https://opencode.ai) plugin that keeps a session attached to its GitHub pull request.

- **Auto-fix.** With auto-fix on, the session wakes up by itself when its PR gets a failing CI check, a new review thread or reply, a new comment or changes-requested review, or a merge conflict. The wake-up message lists what happened and asks the agent to fix it and push.
- **PR status in OpenCode Desktop.** A pill above the composer shows the session's PRs: failing, conflict, changes requested, checks running, open, draft, ready to merge, merged or closed. Its menu opens the PR, toggles auto-fix and auto-archive, refreshes, or dismisses a PR. Desktop also notifies you when a PR becomes ready, merges, closes, starts failing or conflicts.

## Requirements

- OpenCode 2.4 or later. The status pill needs OpenCode Desktop.
- The [GitHub CLI](https://cli.github.com), signed in (`gh auth status`).

## Install

Clone it into your OpenCode config directory and install its dependencies:

```sh
git clone https://github.com/malachibazar/opencode-pr-watch ~/.config/opencode/pr-watch
cd ~/.config/opencode/pr-watch && bun install
```

Then add it to your **global** `~/.config/opencode/opencode.json`. OpenCode Desktop only loads plugin UIs from the global config.

```jsonc
{
  "plugins": ["./pr-watch"],
}
```

OpenCode picks up the change without a restart.

## Use

| Command | Effect |
| --- | --- |
| `/autofix` | Toggle auto-fix for the session. |
| `/autofix on` / `/autofix off` | Turn auto-fix on or off. |
| `/autofix <PR URL or number>` | Watch that PR in this session and turn auto-fix on. |

When auto-fix turns on, the session gets everything still outstanding: failing checks, unresolved review threads and merge conflicts. After that, only new activity wakes it. Comments have no resolved state, so they count only when they are new.

The session finds its PR in three ways:

- a PR the agent opens with `gh pr create` in that session;
- the PR for the branch checked out in the session's worktree (sessions in the main checkout skip this, since they share one branch);
- `/autofix <PR>`.

## How it works

- Each OpenCode location polls the PRs of its own sessions once a minute through `gh api graphql`.
- Wake-ups are queued user messages, so they never interrupt a turn in progress.
- Auto-fix turns itself off after 10 wake-ups on one PR without the PR becoming ready, so a broken CI loop can't run forever.
- Confirmations appear as Desktop toasts, never as session messages, so they never become the agent's input.
- With auto-archive on, the session is archived once all its PRs are merged or closed.

## Limits

- The OpenCode plugin API has no slot in the sidebar's session list, so status shows above the composer instead of next to each session.
- After the OpenCode service restarts, a session's PRs are polled again once its location loads, for example when you open the session.
- The GUI plugin API is experimental and may change between OpenCode releases.

## Develop

```sh
bun install
bun run typecheck
bun run build   # rebuilds dist/gui-experimental.cjs, the Desktop UI
```

OpenCode reloads the server part when `src/` changes, and the Desktop UI when `dist/` changes.
