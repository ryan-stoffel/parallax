# 0035: A Codex thread is full Codex on `codex app-server`

- Status: accepted; extends [0034](0034-threads-are-full-claude-code.md) to Codex, and supersedes in part [0013](0013-worker-sandbox.md), [0027](0027-claude-permission-modes.md) (Codex maps `edit` only), and [0031](0031-permission-requests.md#codex) (Codex never asks) for a Codex thread; a coordinator's Codex children are threads since [0042](0042-project-children-are-threads.md), and `codex exec` is gone since PLX-396
- Date: 2026-10-02
- Issue: PLX-282

## Context

A Codex thread ran through the worker backend: `codex exec` with `--ignore-user-config`, `--ignore-rules`, and the `parallax_worker` profile, one turn per process, approval policy `never`, and Accept Edits only (0013). plxd then refused it with every other Codex worker (PLX-153). 0034 made a Claude thread full Claude Code. Ryan wants a Codex thread to work the same way: the user's own CLI, configuration, and login, with approvals reaching the app.

`codex exec` can't ask its host anything during a run (0031). `codex app-server`, the interface the Codex IDE extension and T3 Code drive, can: it speaks JSON-RPC over stdio, keeps a thread live across turns, and sends approval requests as server requests. The shapes below are codex-cli 0.159.3's, from `codex app-server generate-ts` and real runs.

## Decision

### The process

A run with `RunRequest.thread` on the Codex backend runs `codex app-server` in the run's cwd, with no arguments beyond `app-server`. It loads the user's `config.toml`, rules, `AGENTS.md` files, skills, hooks, plugins, and MCP servers, as `codex` in a terminal does. Workers that a coordinator spawns keep `codex exec` and 0013 unchanged, and stay refused until PLX-145.

The driver sends `initialize` and `initialized`, then `thread/start`, or `thread/resume {threadId, excludeTurns: true}` for a run that resumes an earlier one's thread id. Either carries only the cwd, the mode's `approvalPolicy`, `sandbox`, and `approvalsReviewer` ([Modes](#modes)), the model, the context window as `config.model_context_window`, and fast mode as `serviceTier` `priority`, as exec takes them (PLX-281). The prompt is the first `turn/start`, as the user wrote it, with its images as `localImage` files and the effort. Each follow-up `Run::send` takes is a later `turn/start` in the same process, sent once the turn before it has completed. Once no turn and no approval request is outstanding, stdin closes and app-server exits, which ends the run, and `agent/send` resumes the thread in a new run.

### Modes

| Parallax | `approvalPolicy` | `sandbox` | `approvalsReviewer` |
| --- | --- | --- | --- |
| Manual | `untrusted` | `workspace-write` | |
| Accept Edits (the default) | `on-request` | `workspace-write` | |
| Auto | `on-request` | `workspace-write` | `auto_review` |
| Bypass Permissions | `never` | `danger-full-access` | |

The Codex backend reports these four from `permissions()`, and the app's `backends.codex.permissions` lists them. Plan is Codex's `collaborationMode`, which only app-server's experimental API takes, and whose plan isn't an approval request, so a Codex thread has no Plan yet (PLX-303). A Claude thread moved to Codex in Plan gets Accept Edits, as before.

In `workspace-write`, Codex keeps a worktree's git metadata, which lives in the repository's own `.git`, read-only, so a commit in Manual, Accept Edits, or Auto asks to run outside the sandbox first.

### Approval requests

With `approvals` (0031), each request is an `approvalRequested` item:

| app-server request | `toolName` | `input` | Allow | Allow with `always` | Deny | Deny with interrupt |
| --- | --- | --- | --- | --- | --- | --- |
| `item/commandExecution/requestApproval` | `command_execution` | `command`, `cwd` | `accept` | `acceptForSession` | `decline` | `cancel` |
| `item/fileChange/requestApproval` | `file_change` | the item's `changes` | `accept` | | `decline` | `cancel` |
| `item/permissions/requestApproval` | `permissions` | `permissions`, `cwd` | the requested permissions, for the turn | | none, for the turn | |
| `mcpServer/elicitation/request` | `mcp_elicitation`, interactive | the request | `accept` | | `decline` | `cancel` |

- `callId` is the item's id, which its `toolCall` carries. A file change's request names only its item, so its input is the changes from that item's `item/started`.
- `alwaysAllow` is the command, and `always` answers `acceptForSession`, which lasts as long as the app-server process. plxd never answers `acceptWithExecpolicyAmendment`, which Codex offers and which writes a rule to the user's rules file.
- Codex takes no edited input, so an allow whose input differs from the request's is sent as `decline`.
- `serverRequest/resolved` for a request still waiting, or app-server exiting, withdraws it.
- Without `approvals`, a thread runs with approval policy `never` inside its mode's sandbox, as a Claude thread without them keeps its sandbox (0034): its commands run sandboxed without asking, and plxd answers `decline` to any request that still comes, so a client that can't answer never leaves Codex waiting. Codex's other requests (`item/tool/requestUserInput`, `item/tool/call`, token refreshes, and the legacy v1 approvals) get a JSON-RPC error.

### Events

`item/agentMessage/delta` is `textDelta`, and a completed `agentMessage` is `text`, both with the item's id. A completed `reasoning` item is `reasoning`. `commandExecution`, `fileChange`, `webSearch`, and `mcpToolCall` items are `toolCall` and `toolResult`, named as exec names them (`command_execution`, `file_change`, `web_search`) and an MCP tool as `mcp__<server>__<tool>`. `turn/plan/updated` is `todoList`. `thread/tokenUsage/updated`'s `total` is the thread's running total, which a resumed thread carries over, so it becomes usage deltas as exec's `turn.completed.usage` does. `turn/completed` is `turnFinished`, with the last agent message as its result. A failed turn fails the run: `codexErrorInfo` `unauthorized` is `notSignedIn`, `usageLimitExceeded` and `rateLimitExceeded` are `rateLimited`, and anything else is classified from its message as exec's is. `warning`, `configWarning`, `guardianWarning` (Auto's reviewer), and a retried `error` are notices.

### Credentials and cancel

- The run drops the same inherited variables as exec (`OPENAI_*`, `CODEX_*`), and a subscription gets only its account's `CODEX_HOME`. app-server reads no API key from the environment: with `CODEX_API_KEY` or `OPENAI_API_KEY` set and an empty `CODEX_HOME`, `account/read` finds no account. So a Codex thread on an API key account is refused rather than billed to the login (PLX-304).
- app-server ignores `SIGINT`: a running `sleep 30` turn completed after one. `SIGTERM` ends it at once, so cancel sends `SIGTERM`, then kills the process group after the grace period. The thread keeps what it had written, so a later run resumes it.

## Consequences

- A Codex thread can do anything Codex can on the host as the user, as 0034 records for a Claude thread. Manual, Accept Edits, and Auto ask through the app for what Codex would ask about. Bypass Permissions asks about nothing and has no sandbox.
- plxd still commits what a thread leaves uncommitted in its worktree when app-server exits (0034).
- A Codex thread on an API key account doesn't start, and a Codex thread has no Plan, until PLX-304 and PLX-303.
- The app shows a Codex request with its generic fields, since its card knows Claude Code's tool names.

## Evidence

On 2026-10-01 and 2026-10-02, on macOS 27.0 with codex-cli 0.159.3 and Ryan's own ChatGPT Plus login, `plxd serve` with a fresh data folder ran Codex threads that a client started over `plxd attach` with `approvals: true`, in new worktrees of a scratch repository, and allowed every request:

| Thread | Asked | Result |
| --- | --- | --- |
| Manual | Name from the instructions; list skills; append a line to `README.md` and commit | "Ryan Thomas Stoffel" from the global `AGENTS.md`; the user's own skills, plugins' included; every command arrived as a `command_execution` request, each allow reached Codex, and the commit landed in the worktree |
| The same thread, a follow-up sent while the first request waited | The commit's short hash | Ran as the next turn in the same process, with its own `turnStarted` and `turnFinished`: "`dc6d557`" |
| The same thread, a follow-up after the run finished | The last commit's message | Resumed the same Codex thread id: "e2e manual" |
| Accept Edits | Append a line with `apply_patch` and commit | The reads and the patch ran without asking; the commit asked to leave the sandbox, with Codex's reason, and the allow committed it |

Hand probes of `codex app-server` in the same way showed the rest of the user's configuration loading: `mcpServer/startupStatus/updated` for the user's MCP servers from `config.toml` (`node_repl` ready), and `hook/started` for the user's `hooks.json` and a plugin's hooks. The first plxd attempt, after those probes used up the Plus 5-hour window, failed its turn with "You've hit your usage limit", which the run reported as `rateLimited`.

`daemon/src/backend/codex/app_server/translate.rs` replays turns and approval requests trimmed from real runs, and `daemon/src/backend/codex/app_server/tests.rs` runs a fake `codex app-server` process through the backend: a Manual thread's approval round trip and a follow-up in the live process, and a resumed thread without `approvals` that never asks and declines what Codex does.
