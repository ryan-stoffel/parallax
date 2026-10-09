# 0059: plxd's orchestrator is rewritten after T3 Code's orchestration-v2

- Status: accepted; supersedes [0052](0052-orchestration-kernel.md)'s unbuilt parts (the `effects` table, `attempts`, `nodes`, `agent/timeline`, and `runs.finished_turns`) and its receipt design, and in part [0014](0014-agent-runs.md) (the run actor, and a run as one id across a thread's whole life)
- Date: 2026-10-09
- Issue: PLX-636, for PLX-643, PLX-644, PLX-645, PLX-646, and PLX-647

## Context

Ryan chose on 2026-10-09 (PLX-635) to rewrite plxd's orchestration as T3 Code's orchestration-v2, keeping PLX-609's performance work.

### Parallax today (develop 944b0847)

- **An actor per run.** `daemon/src/agents/actor.rs` (3,709 lines) and `agents/mod.rs` (2,388) run one task per run. The task spawns the CLI, batches output every 50 ms, stores rows and events, runs the queue and steers, wakes parents, and runs push and Open PR as an in-actor task. When the CLI exits it commits (`commit_all`). The actor does its own I/O, so nothing durable records an effect between a decision and its result. A run id is the thread's id for its whole life. There is no record of each turn as a unit.
- **One writer.** `daemon/src/store.rs` owns the only write connection on the `plxd-store` thread. Each job is one `BEGIN IMMEDIATE` transaction. `Tx::stage` assigns `seq`, serializes the event, and inserts its row, and the staged events are published to the in-memory window after `COMMIT` (0052, PLX-481). Only four statements use `prepare_cached`.
- **Reads.** A `query_only` reader thread (`plxd-store-read`, PLX-614) serves search, `agent/list`, and other pure reads. The event log keeps its own read connection for `agent/events` paging (`after`, and `before` from PLX-490).
- **The log.** `daemon/src/event_log.rs` keeps an in-memory window of 10,000 events or 64 MiB (0016). `events/subscribe` replays from it, with `resyncRequired` below its floor, and has `shell` and `run` filters (PLX-454). Finished turns are compacted to one row once they leave the window (`agents/compact.rs`, PLX-491). Delivery clones each event per subscriber and serializes it again per connection (`methods/events.rs`, `server/connection.rs`), so the stored JSON is not reused.
- **0052, partly built.** `command_receipts` exists (migration 38, `daemon/src/commands.rs`): 16 methods claim a receipt keyed on a hash of their params. `effects`, `attempts`, `nodes`, checkpoints, and `agent/timeline` were never built.
- **Idle.** With no threads running, plxd wakes for a 60 s socket check, a 10 s Connect check, a 15 min worktree sweep, and the hourly compaction. The placement timer runs only while a child waits (PLX-614).
- **Size.** plxd is 16.1 MB on macOS arm64 after PLX-611 (from 31.5 MB), with no HTTP, PTY, or async SQL crates.
- **Load budgets.** `scripts/bench/budgets.json` holds 30 fake-backend threads to delivery p95 50 ms, plxd CPU 8 s (6.5 s filtered), and RSS growth 30 MiB, with byte and event caps per subscription.

### T3 Code (c9fa1367)

`docs/orchestration-v2/*.md` and `apps/server/src/orchestration-v2/` (`ov2/` below):

- **The graph** (`core-graph-and-data-model.md`, `packages/contracts/src/orchestrationV2.ts`): an `AppThread` is the conversation. A `Run` is one counted user turn, with an ordinal. A `RunAttempt` is one provider execution of it: steering by restart, a retry, or recovery each add one. An `ExecutionNode` tree holds the root turn, tool calls, approvals, user-input requests, plans, and subagents, and only the root node completes the run. `ProviderSession`, `ProviderThread`, and `ProviderTurn` hold native refs, so app ids are primary and provider ids are refs. `RuntimeRequest` is a provider callback that needs an answer. `Checkpoint` attaches to a scope. `ContextTransfer` and `ContextHandoff` record forks, provider switches, merge-back, and subagents.
- **Commands.** `ov2/Orchestrator.ts` takes a command with a `commandId` under a per-thread lock (`ov2/ThreadCommandExecutor.ts`, a `KeyedLock<ThreadId>`). A known receipt returns its stored result, or fails if it was rejected or belongs to another thread. Otherwise `dispatchOnce` plans events and effects from the projections with no provider I/O. A failed plan stores a `rejected` receipt.
- **One transaction.** `ov2/EventSink.ts` `commitCommand` inserts the receipt, appends the events, applies them to the projection tables, enqueues effects, and optionally cancels unsettled ones, in one SQLite transaction. It publishes after commit. Because several fibers write, a one-permit "publish lane" keeps publish order equal to commit order. Provider output goes through `writeIfRunCurrent` and `writeIfProviderThreadOwner`, which commit only if the run's attempt still owns the work.
- **Tables** (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts` and `OrchestrationV2/Foundation.ts`): `orchestration_v2_events` (`sequence` autoincrement, `command_id`, `thread_id`, `run_id`, `node_id`, `event_type`, `payload_json`); `command_receipts` (`command_id`, `thread_id`, `command_type`, `result_sequence`, `status`, `error`); `effect_outbox`; and projection tables for threads, runs, run attempts, nodes, messages, turn items, plans, provider sessions, threads, and turns, runtime requests, checkpoints and scopes, context transfers and handoffs, and subagents. Each holds a few indexed columns plus `payload_json`. `projection_metadata` records the last applied sequence and a schema version.
- **Effects** (`ov2/EffectOutbox.ts`, `ov2/EffectWorker.ts`): `provider-turn.start`, `.interrupt`, `.steer`, `.restart`, `runtime-request.respond`, `provider-session.detach`, `provider-runtime.continue`, `provider-thread.rollback`, `checkpoint.capture`, `terminal.cleanup`, `preview.cleanup`, `attachment.cleanup`, `thread-title.generate`, and `delegated-tasks.stop`. Each thread runs its effects one at a time in order. Title generation has its own lane. Four workers claim with a 30 s lease and retry with a backoff of 100 ms × 2ⁿ, capped at 30 s, for at most 5 attempts. A worker wakes on an in-memory notify, or at the next `available_at`, or on a 30 s liveness poll. Succeeded rows are pruned after 7 days, hourly. Process-bound effects can't replay after a restart, and the rest can.
- **Subscriptions** (`packages/contracts/src/orchestrationV2.ts`, `ov2/ThreadStream.ts`, `ov2/LiveStreamBudget.ts`): `orchestration.subscribeShell` sends a shell snapshot, then `thread.updated`, `thread.removed`, `project.updated`, and `project.removed`. `orchestration.subscribeThread` sends a snapshot at `snapshotSequence` with a history cursor, then events after it. A resume replays the gap when it is at most 128 events and 1 MiB (`decideThreadResume`), and otherwise sends a fresh snapshot. Live tool updates are coalesced in 50 ms windows (`ov2/ThreadLiveEventCoalescer.ts`).

## Decision

plxd gets T3's orchestrator, in Rust, on its existing writer.

### Names

In this record, **thread** is T3's `AppThread`, which is today's `runs` row, and **run** is T3's `Run`, one counted turn. A thread keeps today's run id as its id, so links, worktrees, and refs keep their names. Old JSON-RPC methods keep calling it `runId` until the app moves (phase 2).

### Tables

Phase 1's migration extends `events`, replaces `command_receipts`, and adds `effects` and `projection_meta`. Until phase 2, the thread projection is today's `runs` and `threads` rows. Phase 2's migration renames those to `legacy_runs` and `legacy_threads`, for the importer (below), and adds the rest. Projection tables keep T3's form: the columns that are filtered or joined on, plus `payload` JSON for the rest, so a new field needs no migration.

| Table | Key and indexed columns |
| --- | --- |
| `events` (existing, extended) | `seq` primary key; adds `command_id`, `thread_id` (renamed from `run_id`), a new `run_id` (the turn), `node_id`, `type` (renamed from `kind`); indexes `(thread_id, seq)`, `(command_id, seq)` |
| `command_receipts` (replaced) | `command_id` primary key, `thread_id`, `type`, `status` (`accepted`, `rejected`), `result_seq`, `error`, `at`; index `(at)` |
| `effects` | `id` TEXT primary key, derived from the command and its position so a replay can't enqueue twice; `command_id`, `thread_id`, `kind`, `payload`, `status` (`pending`, `running`, `succeeded`, `failed`, `cancelled`), `attempts`, `available_at`, `last_error`, `created_at`, `completed_at`; partial index on open rows `(thread_id, rowid) WHERE status IN ('pending', 'running')` |
| `threads` | the columns of today's `runs` and `threads` rows, plus `queue_held`, `active_provider_thread`, `lineage` (`parent`, `relationship`: `fork`, `subagent`, `child`, `remote`) |
| `runs` | `id`, `thread_id`, `ordinal` (unique per thread), `status` (T3's: `queued`, `preparing`, `starting`, `running`, `waiting`, `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`), `provider_instance`, `provider_thread`, `active_attempt`, `root_node` |
| `run_attempts` | `id`, `run_id`, `ordinal`, `reason` (`initial`, `steering_restart`, `retry`, `provider_recovery`), `status` |
| `nodes` | `id`, `thread_id`, `run_id`, `parent_id`, `kind`, `status` |
| `messages`, `turn_items` | `id`, `thread_id`, `run_id`, `position`; what the transcript renders, in order |
| `provider_sessions`, `provider_threads`, `provider_turns` | app ids with native refs (session id, Codex thread id, Claude message id) in `payload` |
| `runtime_requests` | `id`, `thread_id`, `node_id`, `status` (`pending`, `resolved`, `expired`, `cancelled`) |
| `checkpoints` | `id`, `thread_id`, `run_id`, `ref`, `status` ([0062](0062-checkpoints-and-revert.md)) |
| `context_transfers`, `context_handoffs` | `id`, `type`, `source_thread`, `target_thread`, `status` |
| `projection_meta` | `name`, `schema_version`, `last_seq` |

`legacy_runs`, `legacy_threads`, `queued`, `turns`, `attached_seen`, `wakes`, and the old receipt columns are folded into these and dropped once the import (below) finishes. `projects`, `repos`, `worktrees`, `accounts`, `images`, `inbox`, `questions`, `landings`, `placements`, `host_settings`, and the usage tables stay as they are. A checkpoint's child scopes (T3's `CheckpointScope` for subagents) wait until something needs them.

### The flow

```
request ─► dispatcher: command {commandId, threadId, …}
        ─► thread lane (one at a time per thread)
        ─► receipt hit? return result_seq and its events, or the stored rejection
        ─► decide(command, projections) ─► {events, effects}     no I/O
        ─► writer: BEGIN IMMEDIATE
                   insert receipt · stage events (seq) · apply to projections · insert effects
                   COMMIT
        ─► publish staged events ─► subscribers
        ─► notify the effect worker ─► reply {sequence}
effect worker ─► claim (writer job) ─► adapter / git / tool call ─► ingest: events in one job
```

- **Commands.** Every mutation is a command: the app's, `plxd mcp`'s, a reactor's (a wake-up, a schedule), and the ingestor's internal ones. A JSON-RPC method builds the command and calls `dispatch`. The command types are T3's (`thread.create`, `thread.archive`, `thread.settle`, `thread.metadata.update`, `message.dispatch`, `run.interrupt`, `queued-run.reorder`, `queued-run.edit`, `queued-run.cancel`, `queued-message.promote-to-steer`, `queue.resume`, `runtime-request.respond`, `checkpoint.rollback`, `thread.fork`, `thread.merge_back`, `thread.stop`, `provider.switch`, `delegated_task.*`) plus Parallax's, listed with their features below.
- **Thread lanes.** A map of thread id to an async mutex, as T3's `KeyedLock`, with entries dropped when unused. Commands on different threads decide in parallel, and all of them commit on the one writer. A command that touches two threads (a fork, a wake) takes its own thread's lane and changes the other through a follow-up command or effect, as T3 does for `delegated-tasks.stop`.
- **Receipts.** Every command carries a `commandId`. The receipt is inserted in the command's own transaction, with `result_seq`, as T3's `commitCommand` does. A repeat returns the stored result and events. A repeat aimed at another thread is `idConflict`. A rejected command stores `rejected` with its error. Because the lane holds a thread's commands one at a time, a retry in flight waits on the lane rather than on 0052's in-memory waiters, and the 16-method list, the params hash, and the claim-first design go. Receipts are kept 7 days, pruned on insert. Commands built inside plxd get deterministic ids, so a crash-and-retry reuses them.
- **Decide.** `decide` is a pure function of the command and the thread's projection rows, read from a read connection under the lane. Placement and routing (0012, 0046), which read usage and limits, run before `decide` and put their pick in the command, so `decide` stays pure and testable.
- **Commit and publish.** One writer job per command. `apply(event)` updates projections with `prepare_cached` statements in the same transaction. The writer thread publishes after `COMMIT`, in `seq` order, so T3's publish lane isn't needed. A failed transaction publishes nothing, and the `seq` counter goes back (0052).
- **Ingest.** Adapter output (0060) becomes events through an ingestor on the writer, in 50 ms batches per thread as today, so a streaming turn is one transaction per batch. Ingest writes are conditional, as T3's `writeIfRunCurrent`: a batch for an attempt that is no longer the run's active one commits nothing.
- **Effects.** T3's kinds, plus Parallax's: `git.commit`, `git.push`, `pr.open`, `thread.accept`, `land.step`, and `wake.deliver`. Each thread runs its effects one at a time, oldest first. Title and branch naming (0058) has its own lane. At most 4 effects run at once host-wide, as T3's 4 workers. A failure retries with T3's backoff (100 ms × 2ⁿ, capped at 30 s, 5 attempts). A failure the adapter marks final ends the effect at once. An effect's result and its events commit in one job.
- **No leases and no polling.** `plxd.lock` admits one `serve` per data folder, so a `running` row at start always belongs to a dead process (0052's reasoning). The worker sleeps until a commit notifies it, or until the earliest `available_at` of a row waiting out a backoff. T3's 30 s liveness poll and lease columns are left out. Settled rows are pruned after 7 days on insert, not by an hourly timer.
- **Recovery at start** is T3's `ProviderRuntimeRecoveryService` before the worker starts: running effects that are replay-safe go back to `pending`, and process-bound ones are cancelled. Runs, sessions, requests, and the queue are recovered as [0060](0060-provider-sessions.md) says. `git.commit` and `thread.accept` are not replay-safe, as 0052 said. `git.push` and `pr.open` are.

### Subscriptions

- `orchestration/subscribeShell {afterSeq?}`: a snapshot of projects and thread shells at `snapshotSeq`, then `thread.updated`, `thread.removed`, `project.updated`, and `project.removed`. It replaces the host subscription and PLX-454's `shell` filter. A shell row is what the sidebar shows (title, status, attention, provider, host), so a thread's output never reaches it.
- `orchestration/subscribeThread {threadId, afterSeq?}`: a bounded snapshot (the newest runs' turn items, a `historyCursor`, `hasMoreHistory`), then that thread's events after it. With `afterSeq`, plxd replays the gap when it is at most 128 events and 1 MiB, from the window or else a read connection, and otherwise sends a fresh snapshot, as `decideThreadResume`. `orchestration/threadHistory {threadId, cursor}` pages older turn items, replacing `agent/events`' `before` paging.
- Notifications are `orchestration/event {subscription, seq, event}` on 0007's connection. Streaming text and running-tool updates are coalesced over 50 ms per thread before they're sent, as today and as T3's coalescer.
- `events/subscribe`, `agent/events`, and the `agent.*` events stay until the app has moved to these (end of phase 2), then go.

### PLX-609's performance work

| Work | In the orchestrator |
| --- | --- |
| One writer (PLX-481) | Commands, ingest batches, effect claims and results, and imports are all jobs on the `plxd-store` thread. No other connection writes. |
| Prepared statements | Every hot statement (event insert, each projection upsert, receipt insert, effect claim) uses `prepare_cached`, not just today's four. |
| Staging and serialize once | `Tx::stage` serializes an event once to an `Arc<str>`. The row stores it, the window keeps it, and each subscriber's frame embeds it without cloning or serializing the event again. Today's per-subscriber clone and re-serialize goes. |
| Read connections (PLX-614) | Snapshots, history pages, `decide`'s projection reads, search, and receipt lookups use read connections, never the writer. The single reader thread becomes a small pool, two by default. |
| Bounded window (0016) | Kept: 10,000 events or 64 MiB. Thread replays come from it before the database. |
| Bounded replay | 128 events or 1 MiB, then a snapshot (T3's limits), in place of replaying the whole gap from the window. |
| Compaction (PLX-491) | A finished run's intermediate `turn_item.updated` events collapse into the last one per item, once they're older than the window. The projections already hold the final items, so snapshots never read them. The sweep runs at start and after a run finishes, on idle writer time, rather than hourly. |
| No idle polling (PLX-614) | The effect worker, session release (0060), wake batching, and schedules ([0063](0063-schedules-pr-watches-and-delegation.md)) each set one timer for their next deadline and none when nothing is due. Nothing polls the database. |
| Small binary | No new crates. rusqlite, tokio, and serde_json do all of it. Projection payloads are serde types. |

PLX-643 to PLX-647 each hold the load budgets in `scripts/bench/budgets.json` and the PLX-609 launch, memory, and idle CPU numbers no worse than before.

### Parallax-only features on the graph

| Feature | Where it maps |
| --- | --- |
| Projects and the coordinator (0042 to 0046) | A Project is T3's project, with its settings and integration branch in `projects`. The coordinator is a thread with `role: coordinator`. A child is a thread with lineage `child` to the coordinator. `ask`, `answer`, `escalate`, inbox items, and Project settings are commands on the coordinator's or child's lane. |
| Wake-ups (0025, 0043) | A run's terminal event enqueues `wake.deliver` on the parent, available 2 s later so finished children batch into one turn. Its effect dispatches a delegated-completion message, steered into the parent's running turn when its provider can steer, else queued. The cap and pause are fields of the parent's thread row. This is the same path as T3's delegated completion ([0063](0063-schedules-pr-watches-and-delegation.md)). |
| Routing and placement (0012, 0040, 0046) | Run before `decide` and recorded on the run (`provider_instance`, account). A child waiting for capacity is a run in `queued` with the reason in its payload, so `placements` becomes a projection. A rate-limit move is `provider.switch` within the provider's kind: a new provider thread with a `provider_handoff` transfer, and a new attempt with reason `provider_recovery`. |
| Attached threads (0047) | A `context_transfers` row of type `attach`, from the source thread's last `seq` the target saw, which replaces `attached_seen`. It is materialized into a `context_handoffs` row (0052's `summary` and `since` budgets, 32 KiB) when the target's run starts. |
| Search (0047, PLX-487) | FTS5 stays. `thread_text` is filled from the `messages` projection in the same transaction: user messages when they're stored, the agent's reply when its run completes. T3's LIKE search (`ov2/ThreadSearch.ts`) is slower and isn't copied. |
| Land (0045) | `land.queue`, `land.approve`, and `land.sendBack` are commands on the coordinator's lane. Each git step (merge-tree, squash, checks, send-back) is a `land.step` effect, replay-safe because each reads refs and writes only `refs/parallax/*`. The serial queue is the coordinator lane's effect order. |
| Memory (0044) | Unchanged. Memory is files in the context folder, and its tools call the context code directly. A proposal to the user is an inbox item, which is a command. |
| Commit, push, Open PR, Accept (0014) | Effects `git.commit`, `git.push`, `pr.open`, and `thread.accept`. The commit plxd made when a CLI exited goes: a session no longer exits per turn, and [0062](0062-checkpoints-and-revert.md)'s checkpoints record each turn instead. Commit is the Git menu's, as before. |
| Approvals (0031) | Runtime requests, answered with `runtime-request.respond`. They expire at restart. A plain thread's request waits until answered, as T3's. A Project child's keeps 0031's 30-minute deny, because nobody may be watching an Auto Project. |
| Remote children (0057) | When 0057's PRs 2 to 7 land, the home row is a thread with lineage `remote` and `computer`. The watcher dispatches `remote.sync` commands with the device's mirrored state. Only 0057's PR 1 (`daemon/src/peer.rs`) is merged today. |

### Moving existing stores

- Before phase 2's migration runs, plxd copies `plxd.sqlite3` to `plxd.sqlite3.pre-<version>` once. There is no downgrade: an older plxd refuses the store with `UnsupportedSchemaVersion`, as today.
- An importer then converts each thread on the writer, one thread per job, oldest first. It writes the thread's row from `legacy_runs` and `legacy_threads`, its user messages as runs (one per prompt or sent turn, from `legacy_runs.prompt`, `turns`, and the `turnStarted` events), its compacted turn items, and its approvals as resolved runtime requests, under fresh `seq`s, and deletes the thread's old `agent.*` events in the same job. `queued` rows become queued runs with `queue_held` set. A table `legacy_imports (thread_id)` records progress, so a crash resumes where it stopped. T3 does the same with `ov2/legacy/`.
- Threads that aren't imported yet serve reads from the old rows, so the app works during the import. PLX-644 reports how long the import takes on a 1,000-thread store.

### Phases

| Phase | Issue | What lands | The app |
| --- | --- | --- | --- |
| 1. Core | PLX-643 | Commands, thread lanes, `decide`, receipts, the event and projection writer with serialize-once staging, `effects` and the worker, start-up recovery. Thread metadata commands (create, title, archive, settle, snooze, seen, delete) go through it behind today's JSON-RPC methods. The actor still runs turns. | Unchanged |
| 2. Graph and subscriptions | PLX-644 | Runs, attempts, nodes, messages, turn items, runtime requests. `message.dispatch` with T3's modes (`defer_start`, `steer_active`, `restart_active`, `queue_after_active`, `start_immediately`), the queued-run commands, `run.interrupt` with `holdQueue`. `subscribeShell`, `subscribeThread`, `threadHistory`. The importer. The actor becomes an adapter shim that ingests through the orchestrator. Projects, routing, attached threads, search, and land move onto the graph. | Moves to the new subscriptions, and the old ones go |
| 3. Adapters and sessions | PLX-645 | [0060](0060-provider-sessions.md): adapters for Codex, ACP, OpenCode, Cursor, and fake behind the provider effects, the session manager, and recovery. The actor is deleted. Claude runs through today's backend wrapped as an adapter. | Held-queue banner |
| 4. Claude | PLX-646 | [0061](0061-claude-agent-sdk.md) | Node note for Claude |
| 5. Checkpoints | PLX-647 | [0062](0062-checkpoints-and-revert.md) | Changes panel and revert |

Delegation, schedules, PR watches (PLX-648, PLX-649), and setup scripts (PLX-650) follow, on the same commands and effects.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Finish 0052 on the actor model | Ryan chose T3's model. 0052 also left out what T3 uses to keep turns, attempts, and nodes consistent: projections from events and planning without I/O. |
| T3's leases and 30 s liveness poll | One `serve` per data folder makes every `running` row at start an orphan, and the poll wakes an idle host. |
| T3's publish lane | It orders publishes from several writers. plxd has one writer thread, which publishes in commit order already. |
| Storing every streaming update as its own event, as T3 does | At 30 threads that is hundreds of transactions a second. 50 ms batches and compaction hold today's budgets. |
| Keeping 0052's claim-first receipts | The per-thread lane already serializes a retry behind its first attempt, so the receipt can be written with the change, as T3 does. |
| A new async SQL crate | rusqlite on the writer thread already meets the budgets and keeps the binary small. |

## Consequences

- Every state change is a command with a receipt, and every side effect is a durable row. A crash can't lose an effect or apply a command twice.
- The graph gives turns, attempts, tool and subagent nodes, runtime requests, and provider refs as first-class rows, which checkpoints, revert, delegation, and the timeline build on.
- The app's transcript and sidebar move to new subscriptions in phase 2, a large app change. Old methods stay until then, so phase 1 ships with no app change.
- plxd's store gains about a dozen tables and one more import step at the first start after the update. The backup costs one copy of the database.
- The actor's 3,709 lines and `agents/mod.rs`' run management are replaced, not extended. Phases 1 and 2 keep it as a shim so threads run throughout.
- Each phase is held to the load budgets and PLX-609's numbers. A phase that misses them doesn't merge.
