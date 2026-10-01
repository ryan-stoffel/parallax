# 0031: Claude Code's permission requests reach the app over stdio

- Status: accepted; supersedes in part [0027](0027-claude-permission-modes.md) (headless Manual denies every request that would prompt), for runs whose client asks for the channel
- Date: 2026-10-01
- Issue: RYA-222

## Context

wispd runs Claude Code headless: `-p` with stream-json on stdin and stdout (0004, 0027). With nobody to ask, Claude Code denies every tool call that would prompt. That makes Manual (`--permission-mode default`) unable to approve anything, and Auto denies whatever its classifier won't decide. RYA-196 shows these requests in the app as approval cards. wispd has to forward them and take the answers.

Headless Claude Code has two ways to ask a host, both behind the hidden `--permission-prompt-tool` flag:

- `stdio`, which the Agent SDK passes for its `canUseTool` callback. Claude Code writes a `control_request` with `subtype: "can_use_tool"` on stdout and waits for a `control_response` on stdin.
- `mcp__<server>__<tool>`, an MCP tool that Claude Code calls with the tool's name and input, and whose text result is the answer.

The shapes below come from reading Claude Code 2.1.286's bundled source, its `--help`, and the Agent SDK 0.3.286's `sdk.d.ts` and `sdk.mjs`. Claude Code 2.1.283, CI's pin, sends and takes the same ones ([Evidence](#evidence)).

## Decision

### Only when the client answers

A run uses the channel only when the client that started it asks for it with `approvals: true` on `agent/start`, `thread/start`, or `project/start` (a coordinator's start-over is `project/start` too). A client sets it only when it can show and answer permission requests. Without it, a run's arguments and behavior are exactly what they were before this record: Manual and Auto deny what would prompt. Without the flag, every Manual run would wait up to 30 minutes on a client that can't answer, such as an app from before RYA-196, or an older app against a newer `wispd` on an SSH host, which updates separately.

- wispd stores the flag with the run, so every launch keeps it: `agent/send` resuming a run whose CLI exited, a coordinator's wake-up (0025), and a resume after a restart. It is part of the start methods' idempotent params, and a retry without it gets `idConflict`. `AgentRun.approvals` reports it, absent when false, so a client can tell whether a run asks, and repeat the flag on a retry.
- A run a coordinator spawns (`agent/start` with its `coordinatorThread`, as `wispd mcp` sends it) gets its coordinator's flag, as it gets its coordinator's mode (0027). Claude Code's own subagents inside a coordinator's CLI share its channel.
- `agent/approve` on a run without the flag finds no request, so it fails with `approvalNotFound`, as for any id the run never had.

### The channel: stdio

A worker, a normal thread, or a coordinator in Manual, Auto, or Plan, started with `approvals`, starts with `--permission-prompt-tool stdio` right after its `--permission-mode`. Accept Edits and Bypass Permissions don't, and neither does a plain no-write run (`dontAsk`), so their CLIs run exactly as before.

Why stdio rather than an MCP tool:

- wispd already owns both pipes, so nothing new listens, and no server or credential is added.
- A worker connects no MCP servers (`--strict-mcp-config`, 0013), and its `system/init` may list only its fixed tools. A prompt tool would put an MCP server in the sandboxed worker and a tool in that check.
- Claude Code refuses to send a tool whose approval is the interaction itself, such as `ExitPlanMode`, to an MCP prompt tool: "MCP tool requires user interaction; not supported via --permission-prompt-tool". Over stdio it sends it with `requires_user_interaction: true`.

What Claude Code writes, with the fields wispd reads:

```json
{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool",
 "tool_name":"Bash","input":{"command":"pnpm test"},"tool_use_id":"toolu_...",
 "permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"pnpm test:*"}],"behavior":"allow","destination":"localSettings"}],
 "decision_reason":"...","blocked_path":"...","agent_id":"...",
 "suppress_always_allow_rule":false,"requires_user_interaction":false}}
```

What wispd answers, as the SDK does:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":
 {"behavior":"allow","updatedInput":{...},"updatedPermissions":[...],"toolUseID":"toolu_..."}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":
 {"behavior":"deny","message":"...","interrupt":false,"toolUseID":"toolu_..."}}}
```

- An allow always carries `updatedInput`: the input the tool asked with, or the user's edit. Older CLIs require it.
- No `initialize` control request is needed. Claude Code waits for one only with `--await-initialize`, and sends `can_use_tool` without it.
- Claude Code fails a request once its stdin closes, so wispd keeps stdin open while one waits, even after the last turn's result.
- `control_cancel_request {request_id}` from Claude Code means it no longer waits, for example because its turn was interrupted. The request is withdrawn.
- Any other `control_request` subtype gets an error `control_response`, as the SDK answers one it doesn't serve, so the CLI never waits on wispd.
- "Always allow": wispd keeps only the `addRules` suggestions that allow, and sends them back with `destination: "session"`. They last as long as the CLI process, and never write the user's or the worktree's settings files. `setMode`, `addDirectories`, and rule removals are dropped: an added directory would let a worker's file tools out of its worktree. A request with `suppress_always_allow_rule` offers none. Only the rules the `approvalRequested` item shows whole are kept, at most 16 and none longer than 1 KiB, so `always` adds exactly what the user saw.
- `decision_reason` may hold terminal escapes; wispd strips them.

### Protocol, behind the `approvals` capability

`initialize` advertises `approvals: {}`: this wispd takes the `approvals` flag on the start methods. Requests and their resolutions are two new `agent.output` items, so they are in the event log that `agent/events` and `events/subscribe` read, in transcript order:

```json
{"kind":"approvalRequested","approvalId":"<UUIDv7>","toolName":"Bash",
 "input":{"command":"pnpm test"},"callId":"toolu_...","reason":"...","blockedPath":"...",
 "subagent":"...","alwaysAllow":["Bash(pnpm test:*)"],"interactive":true,
 "expiresAt":"2026-10-01T12:30:00Z"}
{"kind":"approvalResolved","approvalId":"<UUIDv7>","decision":"allowed","by":"user",
 "always":true,"message":"..."}
```

- `approvalId` is wispd's, generated when the CLI asks. Every field after `input` is optional. `callId` matches the `toolCall` item. `subagent` is Claude Code's id for one of the agent's own subagents. `alwaysAllow` lists the rules `always` adds and is absent when none are offered. `interactive` marks a question for the user rather than one action to allow, such as `ExitPlanMode`'s plan.
- `input` is capped at 256 KiB of JSON, not a tool call's 32 KiB, so a long plan shows whole. Past that it is `{"truncated": true, "bytes": n}`, and an allow still runs the full input the CLI asked with.
- `decision` is `allowed`, `denied`, `expired`, or `withdrawn`. `by` is `user`, `timeout`, `cancel` (`agent/cancel` or `thread/delete`), `stop` (wispd stopping), or `agent` (the CLI). `message` is the user's own message with a denial.
- A request is pending until its `approvalResolved`, or until the run's next `agent.finished`, whichever comes first. wispd logs a resolution for every request it can, but a crash leaves none; the `agent.finished {interrupted}` that the next start logs ends it.

`agent/approve` answers one:

```json
{"runId":"...","approvalId":"...","decision":"allow","input":{...},"always":true}
{"runId":"...","approvalId":"...","decision":"deny","message":"..."}
```

- `input` (a JSON object, at most 1 MiB) and `always` go only with `allow`, and `always` only to a request whose `alwaysAllow` isn't empty. `message` (at most 64 KiB) goes only with `deny`. Anything else is `invalidParams`.
- In a worker or a normal thread (`workspaceWrite`), an edited `input` must keep the request's `file_path`, `notebook_path`, and `path` as they were, none added or dropped, or the answer is `invalidParams`. No test shows that Claude Code holds an edited input to `--restricted`'s confinement to the worktree, so wispd doesn't rely on it: an edit can change what a file tool does, never which file.
- The result is the resolution, `{"decision","by","always"?,"message"?}`. It is idempotent: answering a request that already ended changes nothing and returns how it ended, which may be another answer, a timeout, or a cancel.
- A request this wispd never saw, including one from before it started or any for a run without `approvals`, is the new error kind `approvalNotFound`.

### Compatibility

- **An older app, a newer `wispd`.** The app never sends `approvals`, so its runs behave as before this record: no prompt channel, and Manual and Auto deny what would prompt. Nothing waits on an answer it can't give.
- **A newer app, an older `wispd`.** The older `wispd` doesn't advertise `approvals`, so the app doesn't send the flag, and its runs behave as before. A `wispd` from before the flag ignores the unknown field anyway (0007).
- **Both newer.** The app sends `approvals: true` once it can show the request card (RYA-196), and its runs ask.

### When nobody answers

- **A timeout of 30 minutes.** wispd then denies the request, telling the agent that nobody answered in time, to carry on without it if it can, and to say what it needed. The turn goes on, so the agent can finish or ask in its reply. It's `Config::approval_timeout`, which tests shorten.
- **`agent/cancel`, `thread/delete`, or wispd stopping** deny every waiting request with `interrupt: true` before the CLI is stopped, logged `by: cancel` or `by: stop`.
- **The CLI exiting** with a request waiting resolves it `withdrawn`, `by: agent`. The backend withdraws what waits before its run's `Finished`, so after an account fallback (#119) each attempt's requests end before the next attempt runs. An answer that finds the CLI that asked already exited withdraws the request at once.

### Plan mode and `ExitPlanMode`

Without a prompt host, headless Claude Code doesn't offer `ExitPlanMode` at all. With one, a coordinator in Plan gets it, and its plan arrives as an `interactive` request whose input holds `plan`. Allowing it is "approve the plan": Claude Code leaves plan mode for the mode it was in before, `default` (Manual) when it started in plan mode, and asks through the same channel from then on. A later turn of that CLI process reports `default` in its `system/init`, so once an `ExitPlanMode` is allowed, wispd accepts `default` there besides the requested mode, and `acceptEdits` should a newer CLI pick it. Any other mode, or none, still fails the run. A denial with a message is "keep planning". The run's stored permission stays `plan`, so a resumed CLI starts planning again. A worker's `--tools` leaves `ExitPlanMode` out, so a plan worker still only plans.

### Codex

Out of scope. `codex exec` runs with approval policy `never` (0004, 0013) and has no way to ask its host during a run; only Codex's app-server protocol does, which wispd doesn't run.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| An MCP prompt tool served by `wispd mcp` | An MCP server inside every sandboxed worker and its tool in the `system/init` check; it can't carry `ExitPlanMode` or other questions; and the answer would need a path from the app to that server's process. |
| `approval.*` events instead of `agent.output` items | The transcript already reads `agent.output` in order; a separate kind would need the app to merge two streams, and the samples to cover two more event kinds. |
| The backend keeps the timeout | Each backend would repeat it, and the actor already owns the run's log and its commands. |
| No timeout, only a pending state | A Manual coordinator woken at night (0025) would hold its turn until someone looks. |

## Consequences

- Manual, Auto's undecided calls, and Plan's plan approval work in every Claude thread a client starts with `approvals`, coordinators and their subagents included. RYA-196 builds the card from `approvalRequested`, pins it while it is pending, and turns the flag on. Until then, no run asks.
- A person can now approve what headless Claude Code used to deny for a worker: writes to its own settings, git, and tool-configuration files inside its worktree, which `--restricted` lets only a person or the permission handler approve. Paths outside the worktree stay a hard deny under `--restricted`, no approval adds a directory, and no edited input moves a request to another path. Sandboxed commands still can't reach other hosts' ask: the worker's `strictAllowlist` denies them without asking.
- A run in Manual waits on the user between tool calls, up to 30 minutes each.
- After approving a plan, a coordinator's later turns in the same CLI process run in Manual; a resumed one plans again. Moving the run's stored mode on approval is a follow-up for the plan card (RYA-220).
- A Manual worker asks before it edits a file, but runs Bash without asking: its settings allow `Bash`, which the sandbox confines (0013). A Manual coordinator has no sandbox, so it asks before Bash too.

## Evidence

`daemon/tests/permission_requests.rs` runs a real Claude Code, 2.1.283 on CI's Linux legs, through wispd's own Claude backend, with the arguments, the translator, and the driver a real run uses, against a fake Messages API on 127.0.0.1 that asks for tool calls:

- A Manual coordinator's Bash arrives as a `can_use_tool` request with its `tool_use_id` and an `addRules` suggestion. wispd's allow with `always` runs it, and the same command then runs again without asking, so the session rule took.
- wispd's denial skips the call, the tool result the model gets carries the user's message, and the turn goes on.
- The same coordinator without `approvals` gets no prompt channel, and Claude Code denies its Bash without asking, as before this record.
- A Manual worker's sandboxed Bash runs without asking, and its `Write` in its worktree asks; wispd's allow writes the file.

The other cases (withdrawn requests, other control requests, `ExitPlanMode`) replay synthetic transcripts in `daemon/src/backend/claude/tests.rs`.
