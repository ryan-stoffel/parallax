# 0024: A project's coordinator chat is a no-write run in the project's repository

- Status: accepted; where it runs amended by RYA-171; wake-ups are in [0025](0025-coordinator-wake-ups.md); where it runs, its per-turn check, and its fixed permission superseded by [0027](0027-claude-permission-modes.md)
- Date: 2026-09-29
- Issue: RYA-41

## Context

The coordinator's pieces existed before RYA-41: routing forces `Role::Coordinator` to no-write (0012), `routing::snapshot` and `routing::check` are 0004's second check, and `plxd mcp` gives the coordinator its tools, bound to a project and a coordinator thread (0019). Nothing started a coordinator or sent it a message, so a project couldn't be driven. 0007 sketched `coordinator/send`, `coordinator/stop`, and `coordinator.*` events. Since then, runs gained everything a chat needs: messages, Stop, a stored transcript, and resuming after a restart (0014, 0017).

## Decision

### The coordinator is a run

- A project's coordinator chat is one agent run: policy `noWrite`, scope the project's id, and `coordinatorThread` set to its own run id. The runs it spawns through `plxd mcp` carry that same id, so a client can tell them from runs it started itself.
- The same actor runs it as a worker. Messages, Stop, and the transcript go through `agent/send`, `agent/cancel`, and `agent/events`, and its events are the project's `agent.*` events. So 0007's `coordinator/send`, `coordinator/stop`, and `coordinator.*` events aren't needed. `plan/approve` is still RYA-72's.
- Only Claude Code runs it for now. A backend whose `capabilities().coordinator` is false, such as Codex until RYA-39, fails with `workerUnavailable` before anything is created.

### Protocol, behind the `coordinator` capability

| Method | Params | Result |
| --- | --- | --- |
| `project/start` | `{project, runId, prompt, account?, model?, effort?}` | `{run}` |

- `project/start` is idempotent on `runId`, like `agent/start`. The same params return the run, and different ones fail with `idConflict`.
- A project's coordinator is its newest `noWrite` run, and there is only ever one live. A new `runId` starts over: it replaces the coordinator unless that one is starting or running, in which case it fails with `idConflict`, naming the running coordinator. The check and the insert run in one store job, which the store's thread runs alone, so two racing starts can't both succeed.
- A replaced coordinator can't be resumed: `agent/send` fails with `runNotResumable`, naming its successor, so a project never has two live coordinators sharing its worktree (RYA-171).
- A coordinator whose session can't be resumed never locks its project. That happens when Claude Code prunes its transcript after `cleanupPeriodDays` (30 idle days by default), when its account is removed, or when the account now runs on another backend. `agent/send` then fails, and `project/start` with a new `runId` starts over. The same goes for one that ended before its CLI reported a session, such as a CLI that wasn't signed in.
- `account` absent means the coordinator role's default (0012). `model` and `effort` are `agent/start`'s (RYA-97). A no-write run's permission is fixed (0004), so `project/start` takes none, and `agent/send` refuses one with `unsupportedOption`. Since [0027](0027-claude-permission-modes.md), both take a coordinator's permission mode.
- `Project.coordinator` (optional) is the coordinator's run id, from `project/list` and `project/create`. `AgentPolicy` gains `noWrite`.
- The run records no worktree, and `AgentRun.worktreePath` is absent. `agent/diff` and `agent/file` refuse it with `invalidParams`, and `agent/accept` refuses it because it has no commit.

### It runs in a worktree of its own (RYA-171)

> Superseded by [0027](0027-claude-permission-modes.md): the coordinator runs in the project's repository, as Claude Code does, and the detached worktree is gone.

- The coordinator's CLI runs in a detached worktree of the project's repository, `coordinators/<project id>` in plxd's data folder, with 0004's no-write arguments, no worker sandbox, and 0019's tools and allowlist. It is never committed and never on a branch.
- Before each CLI process starts, the first and every resume, including after a restart, plxd moves it to the repository's current `HEAD`. It adds the worktree if it is missing. Otherwise it checks the commit out with `--force` and removes every untracked and ignored file. If that fails, or the folder has no `.git` file, plxd removes the folder and adds it again. Hooks stay off, as for every git call plxd makes (0014).
- Only the coordinator writes there, so the check is exact. The user's edits, commits, stray files such as `.DS_Store`, `agent/accept`, and the sidebar's Update button change the checkout, not this worktree, and never stop a turn. The first version ran in the user's checkout, where all of those tripped the check.
- It reads committed `HEAD` as of when its CLI process started, not the user's uncommitted work. A commit made while a process runs is seen from the next one. Its first message says so.
- One worktree per project. A new `project/start` takes it over, so nothing is left to remove, and a replaced coordinator can't be resumed.
- It loads the user's settings (`--setting-sources user`, not a worker's `--restricted`), so user-level `additionalDirectories` or `Read(...)` allow rules widen what it can read.
- On macOS and Linux, its `--settings` deny `Read` under Claude Code's shared temp folder, `/tmp/claude-<uid>` in both spellings, which Claude Code otherwise lets it read outside its worktree and which holds other sessions' files, as 0013 hides it from workers (RYA-176). Claude Code 2.1.283 applies the rule to `Glob` and `Grep` too, checked by hand.
- Subagents still branch from the repository's `HEAD`, not from the coordinator's worktree.

### 0004's check around every turn

> Superseded by [0027](0027-claude-permission-modes.md): a coordinator in an editing mode may change files, so plxd no longer checks its tree.

- Before each CLI process starts, right after the refresh, plxd takes `routing::snapshot` of the coordinator's worktree. After every `TurnFinished`, and again when the CLI exits, it runs `routing::check` against that snapshot.
- On a change, plxd cancels the CLI, and the run fails with `policyViolation`. The message lists the changed paths from `git status`, and plxd reverts nothing then. A check that can't run at all also stops the run, as `internal`. The next message resumes the session, and the next process's refresh discards the change: it was the coordinator's own, never the user's.
- The coordinator is never committed.

### Its first message

`daemon/src/agents/coordinator.md` is the coordinator's instructions: plan, delegate with `spawn_agent`, check on subagents, and keep shared notes. They go ahead of the user's first message, the repository's path, and a note that its working directory is a copy of the latest commit, as a worker's limits do (0013).

### It never sees itself

`plxd mcp`'s tools skip the project's `noWrite` run. So `list_agents` doesn't list the coordinator, and `message_agent` or `cancel_agent` on its own id gets the same answer as an unknown run. Otherwise it could message itself and queue a turn on its own running CLI.

## Consequences

- The coordinator doesn't see the user's uncommitted work (RYA-171). To show it something, commit it, or describe it in the message.
- A repository with no commits has nothing to check out, so its coordinator fails to start until the first commit, as its subagents do.
- The check misses writes to ignored files and outside its worktree, including the user's checkout, as 0004 and 0012 accept.
- Runs the coordinator started wake it when they finish ([0025](0025-coordinator-wake-ups.md)). The app has no coordinator chat yet (RYA-46).
- `Project.coordinator` is filled by scanning the project's runs. If that gets slow, move it to a column on `projects`.
- No event announces a new coordinator on the host-level subscription. The project's subscription gets `agent.started` with `policy: noWrite`, and `project/list` names it.
