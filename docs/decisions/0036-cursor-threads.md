# 0036: A thread can run on Cursor as full Cursor Agent

- Status: superseded for Cursor by [0053](0053-cursor-sdk.md); the ACP driver still runs every other ACP agent since [0040](0040-provider-instances.md). Supersedes in part [0004](0004-subscription-providers.md) (Cursor waits for Cursor's written OK, and its headless `-p` integration); Cursor runs a Project's children, in Bypass until 0053, since [0042](0042-project-children-are-threads.md)
- Date: 2026-10-01
- Issue: PLX-283 (replaces PLX-40)

## Context

0004 held Cursor back until Cursor confirmed in writing that its Acceptable Use Policy allows a third-party app to launch the user's own signed-in CLI. On 2026-10-01 Ryan asked to add full Cursor support now, the way Claude threads run full Claude Code (0034): the user's own login and configuration, the user's message as the first one, and permission requests answered in the app.

Cursor Agent 2026.10.01-14929f9 has `agent acp`, hidden from `--help`, which serves the Agent Client Protocol (ACP) over stdio: JSON-RPC 2.0, one message per line. Unlike `agent -p`, it keeps a session open for more messages, and it asks its client before a tool call instead of denying it.

## Decision

- **Backend `cursor`**, registered for `Provider::Cursor`, runs `agent [--model <id>] [--force] acp` in the thread's cwd. It runs threads only (`RunRequest::thread`): Cursor has no worker sandbox, and 0004 keeps the coordinator off it, so a coordinator and its subagents never route to it. `agents::prepare` skips the worker-sandbox check for a thread on Cursor only.
- **Credentials.** Only the signed-in subscription runs; 0004's rule that `CURSOR_API_KEY` is no fallback stands, so a Cursor key account never starts a run. Inherited `CURSOR_*` variables are dropped. Nothing else is scrubbed: `~/.cursor` (login, allowlist, skills, plugins, MCP servers) and the user's shell load as in a terminal.
- **Session.** `initialize`, then `session/new`, or `session/load` for a resumed thread, whose replayed history plxd drops because the run's log already has it. The first `session/prompt` is the user's message as written, with images as ACP image blocks. A follow-up sent during a turn waits for that turn's response and goes into the same session. Once nothing is outstanding, stdin closes, `agent` exits, and the run ends; the next message resumes the session in a new run.
- **Permissions.** Edit is Cursor's `agent` mode: edits run without asking, and a command outside the allowlist asks. Plan is `session/set_mode plan`. Bypass is `--force`. There is no Manual, and Auto isn't offered: `--auto-review` still asked before `echo hi` over ACP. Effort is part of Cursor's model ids, so `cursor` maps no efforts and the app shows no effort menu for it.
- **Asking.** With `approvals`, `session/request_permission` becomes `approvalRequested`, and the answer selects its allow-once or reject-once option. ACP has no field for a denial's message or an edited input, so neither reaches Cursor, and "always allow" isn't offered. Without `approvals`, plxd rejects each request at once, as headless Claude Code denies (0031).
- **Plans.** Cursor hands a plan over as `cursor/create_plan`. plxd reports it as an interactive `ExitPlanMode` request with the plan's Markdown as `plan`, so the app's proposed-plan card shows it. Denying rejects it with the user's message, and Cursor keeps planning. Approving accepts it, switches the session to `agent`, and sends "The user approved the plan. Build it." as the same turn, since Cursor ends its turn on acceptance where Claude Code goes on to build. Without `approvals`, plxd declines the request and Cursor saves the plan itself.
- **Events.** Message chunks are text deltas; a run of thinking chunks is one `reasoning`; tool calls are named for the Claude Code tools the app already draws (`execute` → `Bash`, `read` → `Read`, `edit` → `Edit`, `search` → `Grep`, `fetch` → `WebFetch`, others by Cursor's own name); `cursor/update_todos` and `plan` updates are todo lists. `cursor/ask_question` is answered "skipped", asking the agent to ask in its reply. ACP reports no token usage, so a Cursor run has none.
- **Cancel** sends `SIGINT`, which ends `agent acp` at once, and closes stdin.
- **App.** A `Cursor` provider lists a model of each family from `agent models` on 2026-10-01, by the ids `--model` takes. A new thread may pick any provider's model, which starts it on that provider's subscription.

## Consequences

- A Cursor thread can do anything Cursor Agent can on the host as the user, as 0034 records for Claude threads.
- The plan's build message is the one thing plxd writes into a Cursor conversation that the user didn't.
- Usage pages show no tokens for Cursor runs until Cursor reports them over ACP.
- The terms question in 0004 stays open: Cursor's AUP still bars "automated or non-human" access with no CLI carve-out. Ryan chose to ship it anyway.

## Evidence

On 2026-10-01, on macOS 27.0 with Cursor Agent 2026.10.01-14929f9 and Ryan's Cursor Pro+ login, `plxd serve` with a fresh data folder ran threads on `composer-2.5-fast` started over `plxd attach` with `approvals: true`:

| Thread | Asked | Result |
| --- | --- | --- |
| Edit, new worktree | Run `ls`, then `git log --oneline -1` | `ls` (in Ryan's `Shell(ls)` allowlist) ran without asking, through his `eza` alias; `git log` arrived as an approval request with "Not in allowlist: git log", and the allow reached Cursor |
| The same thread, a follow-up | Create `notes.txt` and commit it | The session resumed with `session/load`; three commands asked and were allowed; commit `bdd84ca` is on the worktree's branch |
| Plan | Plan a `CONTRIBUTING.md` | The plan arrived as an `ExitPlanMode` request; approving it built the file in the same turn |
| Edit | Run `git log`, denied | The call ended `denied`, and the agent said it was rejected |
| Bypass | Run `git log` | Ran without asking |

`~/.cursor/rules/shared/RULE.md` isn't a rule Cursor Agent loads: plain `agent -p` in a terminal also said its rules give no name for Ryan.

The same day, the built app against that `plxd` started a thread on Cursor's Composer 2.5 Fast, picked in New Thread's model menu; its three commands came as approval cards, two of them waiting at once, and it committed in its worktree.

The ACP shapes come from recorded runs, which `daemon/src/backend/cursor/fixtures/` replays through a fake `agent` in `cursor/tests.rs`.
