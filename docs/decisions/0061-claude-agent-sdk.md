# 0061: Claude runs through the Agent SDK in a Node sidecar

- Status: accepted; supersedes in part [0014](0014-agent-runs.md) and [0031](0031-permission-requests.md) (Claude Code as `claude -p` with `--permission-prompt-tool stdio`), and [0048](0048-durable-queue-and-steer.md)'s Claude steer on stdin
- Date: 2026-10-09
- Issue: PLX-636, for PLX-646

## Context

plxd runs Claude Code as `claude -p --output-format stream-json --input-format stream-json` per run (`BASE_ARGS` in `daemon/src/backend/claude.rs`, 1,693 lines, plus `claude/stream.rs` and `claude/linux_sandbox.rs`). Permission prompts come back as `can_use_tool` control requests over stdio (`PROMPT_TOOL_ARGS`), a steer is a user message on stdin, a fork is `--resume <session> --fork-session`, and the CLI exits when stdin closes. There is no rewind and no in-session mode change.

T3 Code runs Claude through `@anthropic-ai/claude-agent-sdk` 0.3.276 (`apps/server/package.json`), in its own Node server process (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`):

- One live `query()` per thread across turns. Its prompt is an async iterable over an unbounded queue of `SDKUserMessage`s, and follow-ups are offered onto it. `startTurn` reuses the live query when the native id, policy, and model match, calls `setPermissionMode` when Claude drifted into another mode, and otherwise closes it and opens a new one, unless background work is running.
- A steer is a user message with `priority: "now"` offered into the live query (`supportsActiveSteering: true`).
- Resume is `resume: <session id>` plus `resumeSessionAt`. Rollback makes no SDK call: it moves the thread's head ref, and the next query resumes at that message. Fork is the SDK's `forkSession` with `dir` and `upToMessageId`.
- Permissions go through `canUseTool`, installed only for approval-required and auto-accept-edits. Modes map: plan → `plan`, read-only → `dontAsk`, approval-required → `default`, auto-accept-edits → `acceptEdits`, auto → `auto`, full access → `bypassPermissions` with `allowDangerouslySkipPermissions`.
- `/compact` is a turn with the text `/compact`. `compact_boundary` becomes a compaction item and updates token usage.
- The binary path setting is passed as `pathToClaudeCodeExecutable`. The system prompt is the `claude_code` preset with an append. T3's MCP server is an HTTP server with a bearer token.

Ryan chose the same for Parallax on 2026-10-09, accepting Node 22 or newer for Claude.

## Decision

- **A sidecar, `sidecar/claude`,** like Cursor's (0053): Node, line-delimited JSON on stdio, with the files that ship beside plxd in `claude-agent-sdk/` (`package.json`, `package-lock.json`, `src/`). It is the adapter runtime that [0060](0060-provider-sessions.md) calls: `open_session`, `start_turn`, `steer_turn`, `interrupt_turn`, `respond_to_request`, `rollback_thread`, `fork_thread`, `compact_thread`, `set_mode`, `close`, and the event stream.
- **One sidecar per plxd,** not per thread. It holds every Claude thread's live query, keyed by session id, as T3's server process does. plxd starts it with the first Claude session and stops it when the session manager releases the last one. Thirty Claude threads cost one Node process plus thirty Claude Code processes, not sixty processes.
- **Install on first use,** as PLX-626 does for Cursor: `npm ci --omit=dev` of the pinned SDK into `<data>/tools/claude-agent-sdk/<version>/`, in the background, reported `installing` and then installed or failed in `providers/list`. A host where Claude was already used installs it at the next probe or run.
- **Node 22 or newer** is required for Claude. Without it, `providers/list` reports Claude with the note "Node.js 22 or newer is required", and Claude threads can't start. Native Windows still refuses Claude workers (0023).
- **The CLI is still the user's.** `pathToClaudeCodeExecutable` is the `claude` that detection finds today, or the instance's binary path setting, so 0004 holds: plxd runs Anthropic's own CLI, signed in by the user, and never sees a credential. Each session's `env` carries the account's `CLAUDE_CONFIG_DIR` (0012), or its API key for a key account, as `apply_credential` sets today.
- **Full Claude Code** (0034): `settingSources` is `user`, `project`, `local`, and the system prompt is the `claude_code` preset. T3 leaves `settingSources` unset; Parallax sets it so a thread keeps the user's settings, `CLAUDE.md`, skills, plugins, hooks, and MCP servers. `plxd mcp --thread <id>` stays the Parallax tool server, as a stdio entry in `mcpServers`.
- **Access levels** (0054) map as T3's: Supervised → `default`, Auto-accept edits → `acceptEdits`, Auto → `auto`, Full access → `bypassPermissions` with `allowDangerouslySkipPermissions`, Plan → `plan`, and a coordinator's no-write mode → `dontAsk` with read-only tools. `canUseTool` is installed for Supervised and Auto-accept edits when the client answers approvals (0031), and each call is a runtime request ([0059](0059-orchestration-rewrite.md)). A mode change on a live query is `setPermissionMode`, so it doesn't detach the session.
- **The worker sandbox** (0013) keeps its flags and settings, passed through the SDK's `extraArgs` and `settings`, including the Linux wrapper. PLX-646 checks each.
- **Steer, resume, fork, rewind, compact** are T3's: `priority: "now"`; `resume` with `resumeSessionAt`; `forkSession` for 0050's forks; rewind by moving the head ref ([0062](0062-checkpoints-and-revert.md)); `/compact` with `compact_boundary` as a compaction item (PLX-638).
- **Tests.** The recorded Claude fixtures move from raw stream-json to the SDK's message stream, which has the same shapes. A fake SDK runner in the sidecar replays them, and the Rust tests replay the sidecar's line protocol. Fixtures are scrubbed before they're committed.
- `backend/claude.rs`, `claude/stream.rs`, and the stdin control protocol go once PLX-646 lands, except what 0058's one-shot naming call (`backend/namer`) needs.

## Consequences

- Claude gets T3's behavior: a live session across turns, steering into the running turn, mode changes without a restart, rewind, and SDK forks.
- A host needs Node 22 or newer for Claude, as for Cursor. A Claude-only user who never needed Node now does.
- The SDK isn't shipped, so the app stays the same size. The first Claude thread on a host waits for one npm install.
- One sidecar crash ends every live Claude turn on the host. Each is recorded as failed, and the next message starts the sidecar again and resumes by session.
- The SDK's pin moves with T3's tested version, and Claude Code's own updates still come from the user's `claude`.
