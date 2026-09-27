# 0021: Scheduling subagents: one task, `queued` runs, threads exempt, `Config`-only limits

- Status: accepted
- Date: 2026-09-27
- Issue: #197, #272

## Context

#197 needed wispd to admit only so many workers at once, host-wide and per project, queueing the
rest and promoting them as slots free up. The first version (PR #269) worked for the acceptance
tests it shipped with, but review turned up a real deadlock and three gaps against the acceptance
criteria: a rate-limited account only paused runs that happened to queue first, a queued run
skipped `prepare`'s validation and could retry a dead end forever, and a fresh `agent/start` could
start ahead of an older queued one. Review also found #272 (a resumed run's CLI took no slot at
all) and #273 (nothing woke the coordinator when a queued run ended without going through
`Actor::finish`) as separate, dependency-ordered issues; this record is #197's and #272's, not
#273's, which is #196's (PR #265) to close once it lands after this.

Four things about the design span more than #197 itself — 0014's status list, a shared exemption
with 0017's threads, and how `Config` already treats settings — so they get a record here rather
than living only in issue comments.

## Decision

### One scheduler task, not a recursive `tick`

wispd runs exactly one scheduler task (`agents::scheduler::run`, spawned once on `Agents`'s own
tracker, right after `agents::recover`). It runs one pass immediately, then again on every wake —
`Scheduler::wake` (a `tokio::sync::Notify::notify_one`, called whenever a run stops occupying a
slot or a run is freshly queued) or a periodic timer (`Config::scheduler_tick_interval`, 30 s by
default, so a run waiting only on an account's rate limit resumes once it resets even with nothing
else finishing to trigger a retry) — until wispd shuts down.

The first version instead had `tick` call itself: `Actor::release_slot` awaited `tick` directly,
guarded by a `tokio::sync::Mutex` so only one pass ran at a time. That deadlocks, because `pass` can
promote a run whose `Actor::launch` fails immediately, and `failed_to_start` calls `release_slot`,
which tried to take the very mutex the outer `pass` was still holding — tokio's `Mutex` isn't
reentrant. Every later `release_slot` then hung too, wedging that run's `agent/send`,
`agent/cancel`, and `agent/accept` forever, and since the periodic retry ran inline in the server's
accept loop, the same hang stopped wispd from accepting connections at all. The one-task design
removes the recursion entirely: nothing but the scheduler task itself ever calls `pass`, and
`Scheduler::wake` is synchronous and non-blocking, safe to call from anywhere, including from
inside an actor's own event loop.

### `agent/start` always validates before it decides whether to queue

`prepare` (routing, the CLI check, sandbox paths) runs once, up front, for every non-thread
request, before any reserve-or-queue decision. A bad project, account, or backend fails the same
way whether or not the host happens to be full, matching 0014's "wispd refuses these before
anything is created" for the direct-start path. The same validation runs again when a queued run
is actually promoted — the account or repository it needs may have stopped existing in the
meantime — and a failure there fails the run outright (`agent.finished {failed}`), not "leave it
queued and retry the same dead end every 30 s." Only a rate-limited account leaves a run queued
without failing it, since that one *is* expected to resolve on its own once the window resets.

### A rate-limited account is checked before reserving, not only when promoting

`create` checks `Scheduler::paused_until` for the resolved account right after `prepare`, before
it ever reserves a host or project slot. Without this, a fresh `agent/start` on a paused account
would launch immediately whenever a slot happened to be free, and the acceptance criterion ("a
rate-limited account pauses new starts on it until its reset") only held for requests that queued
for an unrelated reason first.

### Once anything is queued host-wide, every later non-thread start joins the queue too

`create` checks `Store::any_run_queued` alongside `Scheduler::reserve`: if anything is queued
anywhere on the host, a fresh request queues as well, even for a project that on its own would
have room. The scheduler task is then the only thing that ever promotes a run, always oldest
first, which is what "start as slots free up, in order" needs — a fresh request that grabbed a
newly freed slot on its own would otherwise cut ahead of an older queued run. This is stricter than
strictly necessary (a run queued only on its own project's limit doesn't block an unrelated,
uncongested project), traded for a rule simple enough to state and verify: once the queue is
non-empty, admission is the scheduler task's job and nobody else's. Upgrade, if this measurably
hurts throughput under real use: distinguish a queued run's binding constraint (host vs. project)
and only block a fresh request that would contend for the same one.

### Normal threads are exempt from both limits, and from the rate-limit pause

0017's normal threads are the user's own interactive chat, not a coordinator's parallel workers,
and a quick chat shouldn't wait behind subagents. Neither a thread's first `launch` nor a later
`agent/send` resume ever reserves a slot or checks an account's pause. This does mean a thread
still spends the same subscription and host resources a counted run does; if that proves a problem
in practice (many threads open at once starving workers of capacity), the fix is to give threads
their own, separate limit, not to fold them into the worker limits this record is about.

### A resumed run's CLI takes a slot, and a busy resume is refused, not queued (#272)

`Actor::resume` reserves the same host and project slot a fresh `agent/start` does, right before
`launch` — after every other check has already passed, so a resume that was never going to succeed
doesn't take a slot from a run that could use it — and releases it the same way `create` and
`scheduler::promote`'s runs do, through the existing `slot_reserved`/`release_slot` mechanism (one
boolean on the actor, already built for #197's own runs). Unlike a fresh start, a busy resume is
refused outright with a new error kind, `hostBusy`, rather than queued: the run already has a live
actor, and `agent/send`'s caller (0011: Ryan messaging a subagent directly, or #196's coordinator
resuming one to continue its work) expects an answer now, not an unknown wait for a slot with no
run object to show for it in the meantime. `host/health`'s `running` count and the scheduler's
`host_active` count now agree for every worker CLI, first start or resume alike; they can still
differ from each other when a thread's CLI is live, since `running` counts every CLI and the
scheduler counts only what it limits.

### The `""` sentinel stays internal-and-on-the-wire, but a client must not read it as a name

A queued run's `backend` and `accountId` are the empty string — nothing is resolved until it
starts — the same "not set" convention `usage_deltas.model` already uses in the store. This stays
on the wire rather than becoming `null`/absent, to avoid a second optionality question on fields
that are otherwise always present; `AgentRun`'s doc comments say so. The one place this bit a
client: Retry Agent on a run cancelled while still queued read `backend === accountId` (both `""`)
as "the same subscription," and resent `{kind: 'subscription', backend: ''}`. Fixed in
`wispStartSubagent.ts`: an empty `backend` reads as no account at all, so Retry falls back to the
worker role's default, the same as a fresh start with none specified.

### A queued run must never be promoted while wispd is stopping

`pass` checks `Agents`'s shutdown token before it starts, and again before each promotion:
shutdown cancels every running CLI, which frees that run's own slot and is exactly what would
otherwise wake `pass` right back up through `Actor::release_slot`, starting a fresh worktree and
CLI only to have the newly spawned actor notice shutdown and kill it again a moment later — leaving
the run recorded `starting` (recovered as `interrupted` on the next start) instead of still
`queued`. This check closes the window between "shutdown begins" and "the next `pass` starts," not
every window: a `pass` already past the check when shutdown begins can still finish promoting the
run it's on, which then also ends `interrupted` rather than `queued`. Accepted rather than fixed
further: closing it completely would mean `pass` polling the shutdown token between every single
await point inside `promote`, for a race that only matters in the narrow moment wispd is already on
its way down.

## Consequences

- #196 (PR #265) resumes queued/failed-while-queued/cancelled-while-queued runs into its own
  wake-up path once it lands (#273): none of those three transitions go through `Actor::finish`,
  which is the only thing #265 currently wakes a coordinator from.
- 0014's status list gains `queued`, and its protocol table should eventually mention the
  `Config`-only scheduler settings alongside the `agents` capability's methods.
- A thread that turns out to need its own resource limit (not this record's problem to solve) can
  reuse `Scheduler::reserve`/`release` under a second pair of counters without touching how workers
  are limited.
