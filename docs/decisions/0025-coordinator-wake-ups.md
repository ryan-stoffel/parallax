# 0025: Runs a coordinator started wake it when they finish

- Status: accepted
- Date: 2026-09-29
- Issue: RYA-42

## Context

A project's coordinator is a run (0024), and the runs it starts through `wispd mcp` carry its id as `coordinatorThread` (0019). Nothing told it when they finished, so it did nothing until the user wrote again. With an external host, a project should keep going while the laptop is closed.

## Decision

### What wakes it

- When a worker whose run has a `coordinatorThread` ends a CLI process, completed, failed, or cancelled, wispd hands a summary to the coordinator's actor, after committing the run. A run wispd interrupts on shutdown sends none, and neither does a CLI that fails to start, since its caller gets that answer directly.
- The summary is one line per run: its id, its task's first line, how it ended with its last result or failure message (each cut short), and its branch's diff stats. The turn's message opens with "wisp, not the user", lists the summaries, and asks the coordinator to review, act, and report. The wording lives in `daemon/src/agents/wake.rs`, not in the coordinator's instructions.
- Everything happens in wispd's actors, so no client needs to be connected.

### Batching

- The coordinator's actor keeps the summaries and sends them as one turn 2 s after the first arrives, through the same resume as `agent/send`.
- It never sends while its own CLI runs. Claude Code's CLI exits once no turn is outstanding (0014), so a running CLI is a turn in progress, and everything that arrives during it goes out together as the next turn.
- A user message doesn't carry waiting wake-ups; they follow as their own turn.

### The cap

- A coordinator takes at most 10 wake-up turns in a row. The next one pauses wake-ups and emits `agent.wakeupsPaused {runId}` on the project's events. Summaries keep collecting while paused.
- The user's next `agent/send` to the coordinator resets the count and ends the pause; what waited goes out after that turn.
- `agent/cancel` on the coordinator pauses wake-ups too, without the event, so a run finishing a moment after Stop doesn't start it again.
- Only the project's current coordinator wakes. A coordinator that `project/start` replaced drops its wake-ups, so a project never has two live (0024).

### How a client recognizes a wake-up

`AgentOutputItem::TurnStarted` gains `wake: true`, left out when false, and its `text` is the whole message. A transcript rebuilt from `agent/events` marks it the same way. RYA-47 renders it.

## Consequences

- Wake-ups are in memory only. A restart loses what is waiting, the count, and a pause. Runs that were running are interrupted on shutdown and wake nothing; the user's next message resumes the coordinator. RYA-178 picks a project back up after a restart.
- A user message the coordinator gets while wake-ups wait costs one more turn than folding them in would.
- The coordinator's instructions still say it isn't told when a subagent finishes; RYA-43 rewrites them.
- A `coordinatorThread` that names no run, which any client can send to `agent/start`, wakes nothing; wispd logs a warning.
