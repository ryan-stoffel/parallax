# 0060: Provider sessions live across turns, and a restart holds the queue

- Status: accepted; supersedes in part [0014](0014-agent-runs.md) (a CLI process per run that exits when its turn ends, and resuming interrupted runs after a restart), [0035](0035-codex-threads.md) (an app-server per run), [0048](0048-durable-queue-and-steer.md) (a restart sends what waits, and `Run::hold`), and [0049](0049-auto-resume-usage-limits.md) (on by default)
- Date: 2026-10-09
- Issue: PLX-636, for PLX-645

## Context

Ryan chose, on 2026-10-09, to make threads work like T3 Code's (PLX-635). Today each Parallax run spawns its own CLI or sidecar, and that process exits when its turn ends unless the actor holds it for a queued message (`close_when_idle` in `daemon/src/backend/claude.rs`, `Run::hold` in `daemon/src/backend/mod.rs`, the hold in `daemon/src/agents/actor.rs`). Codex runs one `codex app-server` per run (`daemon/src/backend/codex/app_server.rs`), and so do ACP, OpenCode (`opencode serve` per run), and Cursor (a sidecar per run, `daemon/src/backend/cursor_sdk.rs`). A follow-up after a turn ends pays a process start and a session resume. After a restart, `agents::recover` marks running runs `interrupted` and `agents::deliver_queued` sends every stored message at once (`daemon/src/server/mod.rs`, `daemon/src/agents/mod.rs`), and 0049 resumes usage-limited runs on a timer, on by default.

How T3 Code does it (`apps/server/src/orchestration-v2/`, `ov2/` below):

- **Long-lived sessions.** `ov2/ProviderSessionManager.ts` keeps a session open after its turn. A session with no busy turns is released after `DEFAULT_IDLE_TIMEOUT_MS`, 30 minutes. If the adapter reports `hasPendingBackgroundWork`, release is deferred one idle window at a time, up to `DEFAULT_MAX_IDLE_PIN_MS`, 4 hours. A generation counter stops a stale timer from releasing a session that became busy again. The manager never resurrects a session: a later command opens one lazily.
- **Detach.** `provider-session.detach` is an outbox effect. `thread.archive`, `thread.settle`, a changed worktree, a runtime-mode change the provider can't make in session, a provider switch, and thread deletion enqueue it (`ov2/Orchestrator.ts`, `ov2/ThreadDeletion.ts`). Archive and delete also revoke the thread's MCP credential.
- **One Codex app-server per instance.** `ov2/Adapters/CodexAdapterV2.ts` declares `supportsMultipleProviderThreadsPerSession`, so `providerSessionIdFor` in `ov2/Orchestrator.ts` derives one session per provider instance, and every thread on that instance shares its app-server. A thread with no turn for 30 minutes is unloaded with `thread/unsubscribe`, which lets the app-server stop its MCP servers. Claude, Cursor, and the rest are one session per thread.
- **No resurrection after a restart.** `ov2/ProviderRuntimeRecoveryService.ts` `reconcile("startup")` cancels every nonterminal run with "Cancelled because the server restarted", with its attempts, nodes, and provider turns; expires pending runtime requests; marks sessions `stopped`; cancels process-bound effects (`PROCESS_BOUND_EFFECT_TYPES` in `ov2/EffectOutbox.ts`) and returns replay-safe ones to `pending`; records lost background work so the next turn is told (`ov2/RestartBackgroundNote.ts`); and sets `queueHeld: true` on every queued run. `queue.resume` clears it and starts the next run.
- **Continue after restart.** `continueThreadsAfterServerUpdate`, default off (`packages/contracts/src/settings.ts`), enqueues `provider-runtime.continue`, which sends "Continue where you left off." to a run that was mid-turn on a strong native thread (`ov2/RestartContinuation.ts`).
- **Usage limits.** `ov2/UsageLimitRecoveryWorker.ts` sends the same continue message once the reset passes, behind `autoResumeLimitedThreads`, default off.
- **The adapter contract** is `ProviderAdapterV2SessionRuntime` in `packages/provider-core/src/server/ProviderAdapter.ts`: `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `unloadThread`, `respondToRuntimeRequest`, `rollbackThread`, `forkThread`, `compactThread`, `readThreadSnapshot`, `hasPendingBackgroundWork`, with capability flags from `docs/orchestration-v2/provider-capability-system.md`.

## Decision

plxd does the same, on [0059](0059-orchestration-rewrite.md)'s orchestrator.

### Adapters

- Each backend (`daemon/src/backend/`) becomes an adapter with T3's runtime contract as a Rust trait: `open_session`, `ensure_thread`, `resume_thread`, `start_turn`, `steer_turn`, `interrupt_turn`, `unload_thread`, `respond_to_request`, `rollback_thread`, `fork_thread`, `compact_thread`, `has_pending_background_work`, and an event stream. Unsupported operations come from capability flags, not provider names. The flags are T3's session and turn flags: `multipleThreadsPerSession`, `modelSwitchInSession`, `runtimeModeSwitchInSession`, `activeSteering`, `steeringByInterruptRestart`, `rollback`, `fork`, `compact`.
- The orchestrator's effects call them: `provider-turn.start`, `.steer`, `.interrupt`, `.restart`, `runtime-request.respond`, `provider-session.detach`, `provider-thread.rollback`. Adapter output goes back through the event ingestor as 0059 describes. The actor, its hold, and `close_when_idle` go.

### The session manager

- One session manager in plxd owns live sessions, keyed by session id. A session is released 30 minutes after its last busy turn ends. With background work pending (a Claude background task, a Codex subagent or running command), release is deferred one window at a time, at most 4 hours. Each session has one timer, set when it goes idle and cancelled when it gets busy, so an idle host has no sweep.
- Codex runs one `codex app-server` per provider instance (an account, 0040), shared by every thread on it, with `thread/unsubscribe` after a thread's 30 idle minutes. The app-server is released when its last thread unloads and the idle window passes. ACP, OpenCode, Cursor, and Claude ([0061](0061-claude-agent-sdk.md)) are one session per thread. OpenCode with a configured `OPENCODE_SERVER_URL` shares that server, as 0055 already does.
- `provider-session.detach` is enqueued by archive, settle, delete, a worktree change, a mode change the provider can't make in session, a provider or account switch (0046's move), and Accept. Archive and delete revoke the thread's `plxd mcp` binding.
- The worker sandbox (0013) and account routing (`CLAUDE_CONFIG_DIR` per account, 0012) apply when a session opens, as they apply to a CLI start today. A thread whose account or sandbox would change gets a new session.

### Restart

- No session survives a plxd restart, and none is reopened at start. Recovery at start, before the effect worker runs, follows `reconcile("startup")`: nonterminal runs become `cancelled` ("plxd restarted"), with their attempts, nodes, and provider turns; pending runtime requests become `expired`; sessions become `stopped`; process-bound effects are cancelled and replay-safe ones go back to `pending`; lost background work is noted for the next turn; queued runs get `queueHeld`.
- A held queue waits for the user. The composer shows "Queue paused after restart" with Resume, which sends `queue.resume`. The coordinator's and wake-ups' messages queue behind it the same way.
- "Continue threads after restarts" is a host setting, off by default, as T3's. When on, a run that was mid-turn gets "Continue where you left off." on its native thread once plxd is up.
- 0049 becomes T3's usage-limit recovery: the same reset times and backoff, the same "continue" message, behind a host setting that is now off by default. A Project's children keep 0046's behavior (wait for the reset or move), which doesn't depend on this setting.

## Consequences

- A follow-up on a thread that ran in the last 30 minutes goes to a live process: no spawn, no resume, no MCP server start. PLX-645 measures the latency before and after.
- Idle hosts hold more processes: one app-server per Codex account and one session per recently used thread, for up to 30 minutes. A host with 30 active Claude threads keeps 30 Claude processes alive between turns. PLX-645 checks memory under the load harness.
- A restart no longer resumes anything on its own. A user who expected queued messages to go out after an update has to press Resume, or turn on the restart setting for mid-turn runs.
- Usage-limit auto-resume is off by default for plain threads, which changes 0049's default.
- A Codex app-server crash ends every thread's live turn on that account at once. Each is recorded as failed, and the next message opens a new app-server.
