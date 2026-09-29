# 0024: A project's coordinator chat is a no-write run in the project's repository

- Status: accepted
- Date: 2026-09-29
- Issue: RYA-41

## Context

The coordinator's pieces existed before RYA-41: routing forces `Role::Coordinator` to no-write (0012), `routing::snapshot` and `routing::check` are 0004's second check, and `wispd mcp` gives the coordinator its tools, bound to a project and a coordinator thread (0019). Nothing started a coordinator or sent it a message, so a project couldn't be driven. 0007 sketched `coordinator/send`, `coordinator/stop`, and `coordinator.*` events. Since then, runs gained everything a chat needs: messages, Stop, a stored transcript, and resuming after a restart (0014, 0017).

## Decision

### The coordinator is a run

- A project's coordinator chat is one agent run: policy `noWrite`, scope the project's id, and `coordinatorThread` set to its own run id. The runs it spawns through `wispd mcp` carry that same id, so a client can tell them from runs it started itself.
- The same actor runs it as a worker. Messages, Stop, and the transcript go through `agent/send`, `agent/cancel`, and `agent/events`, and its events are the project's `agent.*` events. So 0007's `coordinator/send`, `coordinator/stop`, and `coordinator.*` events aren't needed. `plan/approve` is still RYA-72's.
- Only Claude Code runs it for now. A backend whose `capabilities().coordinator` is false, such as Codex until RYA-39, fails with `workerUnavailable` before anything is created.

### Protocol, behind the `coordinator` capability

| Method | Params | Result |
| --- | --- | --- |
| `project/start` | `{project, runId, prompt, account?, model?, effort?}` | `{run}` |

- `project/start` is idempotent on `runId`, like `agent/start`. The same params return the run, and different ones fail with `idConflict`.
- A project's coordinator is its newest `noWrite` run, and there is only ever one live. A new `runId` starts over: it replaces the coordinator unless that one is starting or running, in which case it fails with `idConflict`, naming the running coordinator. The check and the insert run in one store job, which the store's thread runs alone, so two racing starts can't both succeed.
- A coordinator whose session can't be resumed never locks its project. That happens when Claude Code prunes its transcript after `cleanupPeriodDays` (30 idle days by default), when its account is removed, or when the account now runs on another backend. `agent/send` then fails, and `project/start` with a new `runId` starts over. The same goes for one that ended before its CLI reported a session, such as a CLI that wasn't signed in.
- `account` absent means the coordinator role's default (0012). `model` and `effort` are `agent/start`'s (RYA-97). A no-write run's permission is fixed (0004), so `project/start` takes none, and `agent/send` refuses one with `unsupportedOption`.
- `Project.coordinator` (optional) is the coordinator's run id, from `project/list` and `project/create`. `AgentPolicy` gains `noWrite`.
- The run has no worktree. `agent/diff` and `agent/file` refuse it with `invalidParams`, and `agent/accept` refuses it because it has no commit.

### It runs in the project's repository

- The coordinator's CLI runs in the project's repository itself, the user's checkout, with 0004's no-write arguments, no worker sandbox, and 0019's tools and allowlist.
- It loads the user's settings (`--setting-sources user`, not a worker's `--restricted`), so user-level `additionalDirectories` or `Read(...)` allow rules widen what it can read.
- It reads the code as the user has it, uncommitted work included. It needs no worktree, commit, or cleanup. And 0004's rule, "stops the turn and shows the diff without reverting it", is about the user's own tree.
- A never-committed worktree in wispd's data folder was rejected. Nothing but the coordinator would write there, so the check would be exact. But it would miss the user's uncommitted work, and it would need refreshing to see merged work. wispd would also have to create it, refresh it, and remove it.

### 0004's check around every turn

- Before each CLI process starts, wispd takes `routing::snapshot` of the repository. After every `TurnFinished`, and again when the CLI exits, it runs `routing::check` against that snapshot.
- On a change, wispd cancels the CLI, and the run fails with `policyViolation`. The message lists the changed paths from `git status`, and wispd reverts nothing. A check that can't run at all also stops the run, as `internal`. The next message resumes the session, and the next process takes a new snapshot, which includes the change.
- A tree that was already dirty when the turn started, and stays exactly as dirty, is not a change (0012).
- The coordinator is never committed.

### Its first message

`daemon/src/agents/coordinator.md` is the coordinator's instructions: plan, delegate with `spawn_agent`, check on subagents, and keep shared notes. They go ahead of the user's first message and the repository's path, as a worker's limits do (0013). RYA-43 refines them.

### It never sees itself

`wispd mcp`'s tools skip the project's `noWrite` run. So `list_agents` doesn't list the coordinator, and `message_agent` or `cancel_agent` on its own id gets the same answer as an unknown run. Otherwise it could message itself and queue a turn on its own running CLI.

## Consequences

- An edit the user makes in the checkout during a coordinator turn also trips the check: an editor save, a `git pull`, or `agent/accept` merging a subagent. The turn stops, says which files changed, and the next message resumes it. If this happens often, move the coordinator to a worktree of its own.
- The check misses writes to ignored files and outside the repository, as 0004 and 0012 accept.
- Nothing wakes the coordinator when a subagent finishes (RYA-42), and the app has no coordinator chat yet (RYA-46).
- `Project.coordinator` is filled by scanning the project's runs. If that gets slow, move it to a column on `projects`.
- No event announces a new coordinator on the host-level subscription. The project's subscription gets `agent.started` with `policy: noWrite`, and `project/list` names it.
