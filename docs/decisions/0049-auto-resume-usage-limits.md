# 0049: A run a usage limit stopped resumes when the limit resets

- Status: accepted
- Date: 2026-10-03
- Issue: PLX-371 (part of PLX-368)

## Context

A run that hits a subscription's usage limit fails `rateLimited` and stays stopped until the user writes again. 0012's fallback to a key account runs first, inside `routing::start`, but most users have no key account. Ryan wants the work to continue by itself once the limit resets, including on a host with no client connected.

The CLIs report resets differently. Claude Code's `rate_limit_event` carries `resetsAt` per window, already parsed into `Event::RateLimit`. `codex app-server` sends `account/rateLimits/updated` with `primary` and `secondary` windows, each with `usedPercent` and `resetsAt`. Cursor's ACP reports no reset time at all.

## Decision

### The waiting state

- A run whose CLI ends `rateLimited`, with auto-resume on, becomes `waiting` (a new `AgentStatus`) instead of `failed`. Its `error` keeps the limit's message, and `resumeAt` says when plxd resumes it. Both reach clients on `AgentRun` and `agent.updated`.
- Only a `rateLimited` end waits. Any other end, and every CLI launch, clears `resumeAt`.

### When it resumes

- While a CLI runs, its actor keeps the newest `resetsAt` among the windows reported as refused: Claude's `rejected` status, and a Codex window at 100% used.
- A reset still ahead of now is waited for, plus 0 to 60 s of jitter, so runs on the same account don't resume in the same second.
- A reset that has already passed was either waited for already or is stale, so it is never scheduled again. The run backs off instead, as it does with no reset at all (Cursor): 15 minutes, doubling with each resume in a row that finds the limit still on, capped at 4 hours. This is how "at most once per reset" holds without storing which resets were used.
- At `resumeAt`, the actor resumes the session through the same path as `agent/send`, with "Your usage limit has reset. Continue where you left off." Its `turnStarted` has `wake: true`, the existing "sent by Parallax, not the user" flag (0025).

### Storage and restarts

- `runs` stores `resume_at`, `resume_tries` (the backoff count), and `auto_resume` (the run's override), in migration 24. A host setting lives in a new `host_settings (key, value)` table.
- When plxd starts, after 0014's recovery and 0025's catch-up, it spawns the actor of every `waiting` run, so its timer runs. A timer that came due while plxd was stopped fires at once. Shutting down leaves waiting runs as they are.

### Control

- `host/settings/get` and `host/settings/set {autoResume?}` read and change the host setting, which is on by default. `agent/autoResume {runId, autoResume?}` sets the run's override, and leaving out `autoResume` clears it. All of these, the `waiting` status, and the new fields sit behind the `autoResume` capability.
- `agent/resumeNow {runId}` resumes a waiting run now, and fails with `runNotResumable` for a run that isn't waiting.
- `agent/cancel` on a waiting run clears the timer and leaves the run `cancelled`. A successful `agent/send` resumes the session, which clears the timer.
- Turning the override off for a waiting run clears its timer at once and leaves it `failed`. Turning the host setting off doesn't touch runs already waiting. Each timer re-checks the setting when it fires and leaves its run `failed`.

## Consequences

- A thread on a limited subscription keeps working overnight with nobody at the keyboard, and each resume costs one short turn.
- A Cursor run on a monthly limit retries every 4 hours until the month resets or the user stops it. Each retry fails at once.
- A run that waits for days keeps its worktree and session as any stopped run does.
- Turning the host setting off leaves runs that already wait showing `waiting` until their timer fires. The app can read the setting to show them as off.
- The timer counts down on the monotonic clock from the stored wall-clock time, and the actor recomputes it each time its loop runs. A host that sleeps can resume late by up to the time it slept, unless something else reaches the actor first.
