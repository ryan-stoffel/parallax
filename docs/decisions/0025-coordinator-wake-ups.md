# 0025: Runs a coordinator started wake it when they finish

- Status: accepted; restarts added by PLX-178; the cap is 100, and a child's start and its `ask` also wake a Project's coordinator, since [0043](0043-project-inbox-and-autonomy.md#wake-ups); since PLX-380 any parent wakes when a child it launched ends a CLI process, unless `thread_launch` (or `thread/start` and `agent/start`) set `notify: false`, by the same batching, pause, and restart rules ([0041](0041-thread-lineage-and-host-mcp.md)), and a run the user starts in a Project wakes its coordinator; Stop pauses a run's wake-ups only when it has such children
- Date: 2026-09-29
- Issue: PLX-42, PLX-178

## Context

A project's coordinator is a run (0024), and the runs it starts through `plxd mcp` carry its id as `coordinatorThread` (0019). Nothing told it when they finished, so it did nothing until the user wrote again. With an external host, a project should keep going while the laptop is closed.

## Decision

### What wakes it

- When a worker whose run has a `coordinatorThread` ends a CLI process, completed, failed, or cancelled, plxd hands a summary to the coordinator's actor, after committing the run. A run plxd interrupts on shutdown sends none then (the next start names it, below), and neither does a CLI that fails to start, since its caller gets that answer directly.
- The summary is one line per run: its id, its task's first line, how it ended with its last result or failure message (each cut short), and its branch's diff stats. The turn's message opens with "Parallax, not the user", lists the summaries, and asks the coordinator to review, act, and report. The wording lives in `daemon/src/agents/wake.rs`, not in the coordinator's instructions.
- Everything happens in plxd's actors, so no client needs to be connected.

### Batching

- The coordinator's actor keeps the summaries and sends them as one turn 2 s after the first arrives, through the same resume as `agent/send`.
- It never sends while its own CLI runs. Claude Code's CLI exits once no turn is outstanding (0014), so a running CLI is a turn in progress, and everything that arrives during it goes out together as the next turn.
- A user message doesn't carry waiting wake-ups; they follow as their own turn.

### The cap, and other pauses

- A coordinator takes at most 10 wake-up turns in a row. The next one pauses wake-ups and emits `agent.wakeupsPaused {runId}` on the project's events. Summaries keep collecting while paused.
- `agent/cancel` on the coordinator pauses wake-ups too, so a run finishing a moment after Stop doesn't start it again. So does a wake-up that can't start the coordinator, such as one whose session can't resume, or a store error while checking it. Each emits the same event, once per pause. The event carries no reason: whatever paused them, the user's next message is what lets them through.
- The user's next `agent/send` to the coordinator resets the count and ends the pause; what waited goes out after that turn. Summaries are dropped only once a wake-up turn reaches the coordinator's CLI.
- Only the project's current coordinator wakes. A coordinator that `project/start` replaced drops its wake-ups, so a project never has two live (0024).
- The count and a pause are stored per coordinator (the `wakes` table) whenever they change, and its actor takes them up when it starts. So a coordinator at the cap, or one the user stopped, stays paused across a restart, and a looping one can't reset its count by outliving plxd (PLX-178).

### After a restart (PLX-178)

- When plxd starts, after marking runs it finds still running `interrupted` (0014), it wakes each project's current coordinator for what it missed: the runs it started that ended after its last turn began (its newest stored turn, or its creation). That covers the runs the stop interrupted and summaries that were waiting. They go to its actor together, so they make one turn, on the same path as above, cap and pause included. A run a wake-up already named ended before that wake-up's turn, so a later restart doesn't name it again.
- If the coordinator's own turn was interrupted, the wake-up says so too, since nothing else would pick it back up.
- The wake-up also names the project's open questions that no wake-up turn delivered to this coordinator (PLX-469), whenever they were asked. In Ask me it names none: switching to Ask me already moved them to Needs you (PLX-474), so a restart neither drops nor repeats them.
- The coordinator decides what to do with an interrupted run: `message_agent` resumes it. plxd doesn't resume runs itself, which would spend on every one with nobody deciding.
- A rebuilt summary comes from the run's row: its status, error, and branch, but not its last result or its failure's kind.

### How a client recognizes a wake-up

`AgentOutputItem::TurnStarted` gains `wake: true`, left out when false, and its `text` is the whole message. A transcript rebuilt from `agent/events` marks it the same way. PLX-47 renders it.

## Consequences

- What is waiting stays in memory; a restart rebuilds it from the store, only from runs that ended after the coordinator's newest recorded turn of any kind. So a run that ended before the coordinator's last recorded turn, while its wake-up still waited, isn't rebuilt: the coordinator can find it with `list_agents`. That covers one that ended before the user's last message, and, since a wake-up's turn is recorded only once its CLI starts, one that ended in the moment before, if plxd stops before the next wake-up. In that case the coordinator was usually interrupted too, and its own line wakes it.
- A run whose CLI failed to start during the coordinator's last turn is named again after a restart, since recording the failure updates the run after that turn began, though the coordinator's tool already returned the error. It can cost one unattended turn.
- The first start of a plxd with PLX-178 wakes a coordinator once for runs that ended after its last turn and were never named, which an older plxd dropped on restart.
- A user message the coordinator gets while wake-ups wait costs one more turn than folding them in would.
- A wake-up checks that its coordinator is still the project's before resuming it, but the run is recorded `running` only once its CLI starts. A `project/start` that lands in between finds no running coordinator and starts a second. `agent/send` has the same window (0024); a wake-up just opens it with nobody at the keyboard. It is narrow, so it stays.
- A `coordinatorThread` that names no run, which any client can send to `agent/start`, wakes nothing; plxd logs a warning.
