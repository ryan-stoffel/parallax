# 0020: The coordinator's turns run in wispd, one CLI process each, and finished runs wake it

- Status: accepted
- Date: 2026-09-26
- Issue: #196

## Context

M4 is done when the coordinator plans and runs two subagents in parallel. 0012 left the coordinator's routing and 0004's no-write check to M4, and 0019 gave the coordinator its tools as `wispd mcp`. The coordinator's turns have to run in wispd, not the editor, so they keep going when the editor disconnects. The editor's coordinator chat (#198), the scheduler (#197), and later triggers build on what this record settles.

## Decision

### Protocol, behind a `coordinator` capability

| Method | Params | Result |
| --- | --- | --- |
| `coordinator/get` | `{project}` | `{thread}`, making the project's one thread on first use |
| `coordinator/send` | `{project, turnId, text}` | `{thread}`; idempotent on `turnId` |
| `coordinator/cancel` | `{project}` | `{thread}` |
| `coordinator/events` | `{project, after, limit?}` | `agent/events`'s `{events, more}` |

- **A thread** is `{id, project, status: idle | running, backend?, accountId?, sessionId?, error?, createdAt, updatedAt}`. It is a row of `coordinator_threads` (migration 12), one per project. Only a project has one: a repo entry (0017) is `projectNotFound`.
- **Events**, project-scoped and mirroring `agent.*`: `coordinator.started {threadId, thread}`, `coordinator.updated {threadId, state}`, `coordinator.output {threadId, items}` (the same `AgentOutputItem`s, coalesced every 50 ms), `coordinator.accountFallback`, and `coordinator.finished {threadId, outcome}`, once per CLI process. `coordinator.turnStarted {threadId, turnIds, runIds, text}` says what each turn was told: the user messages it delivers, the runs whose finish it reports, and the text without the planning instructions. With it, an editor can rebuild the whole chat after a restart.
- **Storage.** The event log puts the thread's id in `events.run_id`, so `coordinator/events` pages it exactly as `agent/events` pages a run, and 0016 never prunes it. Delivered turn ids go in `turns`, keyed by the thread's id. Usage is recorded with the thread's id as its run.
- **`coordinatorThread` on `agent/start`** must name the project's own thread; anything else is `invalidParams`. #195's `wispd mcp` sets it from the arguments wispd wrote, but any client can call `agent/start`.

### Turns

- **One actor per thread**, like a run's (0014). Each turn is one CLI process of the coordinator role's account, a `NoWrite` run with 0019's `CoordinatorTools`: wispd's own executable (`Config::wispd_program` in tests), its data folder, the project, and the thread. The process's cwd is the project's checkout.
- **Messages don't reach a live process.** What arrives during a turn is queued and goes out as the next turn, all at once. Each process is then exactly one turn, which is what `routing::snapshot` before and `routing::check` after bracket.
- **Routing.** Every turn calls `routing::resolve(Role::Coordinator, None, NoWrite)` and refuses a backend without `Capabilities::coordinator`. The session resumes only while the role resolves to the same backend and account. Otherwise a new session starts.
- **0004's second check.** A change to the checkout's `git status`, diff, or untracked files fails the turn with `policyViolation`, naming the paths, and so does a check that can't run. So does the backend's own `system/init` check. After either, the thread is *paused*: no turn starts on its own until the user's next `coordinator/send`. `coordinator/cancel` pauses it too.
- **A turn that can't start** (no coordinator default, a backend that can't coordinate, a checkout git can't read) reports `coordinator.finished` with `spawnFailed`, sets the thread's `error`, keeps what was queued, and pauses.
- **The planning instructions** open the first message of every new session: plan first; split the work into independent tasks with specs and done-criteria; record the plan in shared context with `write_context`; start the tasks together with `spawn_agent`; end the turn and wait to be woken; review with `agent_status` and `agent_diff`; ask for changes with `message_agent`; report back; leave accepting to the user. A resumed session gets only the new message.

### Wake-ups

- **What wakes it.** When a run with `coordinatorThread` finishes a CLI process, after wispd commits it, the runner hands the thread the run's id, its prompt, its outcome, and its latest diff stats. A run that wispd stops on shutdown sends none.
- **The message** says, for each run, `- Run <id>: completed, saying: <last result> | failed (<kind>): <message> | cancelled. Its branch changes <n> files, +<a> -<d>, at commit <sha> | It has committed no changes. Its task began: <first line>`, then asks the coordinator to review, message, start more, and report.
- **Batching.** Wake-ups with no user message waiting wait `Config::coordinator_wake_batch` (1 s) before their turn starts, whether they arrive while the thread is idle or during a turn. Everything that arrives meanwhile goes out as one turn. A user message starts its turn at once and carries any waiting wake-ups with it.
- **The scheduler's boundary (#197).** The wake hangs off a run's *finish*, never its start or its queueing. A run the scheduler holds `queued` finishes later and wakes the coordinator later, with nothing else to coordinate between the two.
- **In memory only.** Queued messages and wake-ups aren't stored: a restart loses those not yet delivered (#261). `coordinator/send` stays idempotent across a restart for delivered turns only, so a client's retry re-queues a lost one.

### Checked with the real CLI

The installed Claude Code 2.1.267, run with 0019's exact coordinator flags and `wispd mcp` attached to a running wispd, with a real subscription login, reported `tools` as `Glob`, `Grep`, `Read`, and exactly the eight `mcp__wispd__*` tools, with the server `connected`. No MCP resource tools appeared, so 0019's `system/init` check lets a real coordinator through. A unit test replays that line.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Messages as follow-ups into a live coordinator process | The snapshot and check would no longer bracket one turn, so a violation couldn't be pinned on the message that caused it. |
| `--append-system-prompt` for the planning instructions | Claude only; Codex's coordinator (#122) has no equivalent, and every backend's first message already carries its role, as 0013's worker limits do. |
| Coordinator turns as `runs` rows | `agent/list`, the Agents panel, and review would show them as subagents with no worktree. |
| Waking on every finish at once | Two runs finishing a moment apart would cost two turns, and the second would interrupt the coordinator's review of the first. |

## Consequences

- #198's chat drives `coordinator/*` and rebuilds from `coordinator/events`; `coordinator.turnStarted` gives it the wake-ups as well as the user's messages.
- A user who edits the checkout, or accepts a run into it, during a coordinator turn trips the check. 0004 accepts this; the turn fails with the paths named, and the next message resumes.
- #197 schedules runs without knowing the coordinator exists.
- Codex's coordinator (#122) needs only its `mcp_servers` config (0019); the loop is backend-agnostic.
