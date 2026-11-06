# 0052: plxd's orchestration kernel

- Status: accepted; supersedes in part [0014](0014-agent-runs.md) (the event log's own writer thread, and a move's handoff cut from the front) and [0016](0016-event-log-retention.md) (a run's events are never compacted), and [0047](0047-thread-search-and-context.md)'s attached-thread summary cut from the front; superseded in part by [0059](0059-orchestration-rewrite.md) (the effects outbox, attempts, nodes, `agent/timeline`, and the receipt design, which 0059 replaces with T3 Code's) and [0062](0062-checkpoints-and-revert.md) (per-turn checkpoints); the one writer, staging, handoff budgets, and compaction carry over
- Date: 2026-10-04
- Issue: PLX-480, for PLX-443's steps 3 and 4: PLX-481, PLX-482, PLX-483, PLX-484, PLX-485, PLX-486, PLX-491, PLX-492

## Context

Projects (0042 to 0046) need 30 children running at once on one host, and 100 or more runs in each Project's history. PLX-443 checked the kernel against that on `develop` (00a60e3):

- A row and its event commit in two transactions on two connections. The store is one thread and connection (`daemon/src/store.rs`), the event log another (`daemon/src/event_log.rs`, its `Writer`), and `project/create` appends its event from inside the store's job through `append_blocking` (`daemon/src/methods/project.rs`). A crash between the two leaves a row with no event, and the two writers take turns on SQLite's one write lock.
- Only some methods are safe to repeat. Creates are idempotent on client ids, `agent/send` on `turnId`, and Accept on `id` (0014). A repeated `question/ask`, `land/sendBack`, or `agent/commit` acts twice or fails for the wrong reason.
- Push and Open PR run inside the run's actor (`on_command` in `daemon/src/agents/actor.rs`), each network step with a 300 s timeout (`NETWORK_TIMEOUT` in `daemon/src/worktree/folder.rs`). PLX-458 moves them to a task. A restart still loses an effect in flight, and each kind recovers in its own way.
- A run keeps one id across account moves (0046) and steers (0048), but nothing records each CLI process it went through. Claude's Task subagents exist only as `subagent` wrappers in `agent.output` (0041).
- Nothing records the worktree at the end of a turn, so neither a turn's diff nor a rewind is possible.
- `handoff_prompt` (0014) and `attached::summary` (0047) both cut the conversation from the front (`conversation` in `daemon/src/agents/actor.rs`), so a long run's handoff drops its task first.
- A run's events are never pruned (0016), and a turn is many 50 ms `agent.output` batches.

The load harness (PLX-446, PLX-447) gave the baselines this record is held to. On macOS arm64, with a debug plxd and 30 streaming threads:

| Measure | Baseline |
| --- | --- |
| Delivery latency | p50 0.65 ms, p99 about 16 ms |
| plxd CPU, peak RSS | 9.8%, 31.6 MiB |
| Bytes delivered | 11.7 MiB, every thread's output twice (duplicate scope subscriptions) |
| App frame time | p99 10.3 ms, no long tasks |
| App IPC | 962 messages/s and 313 KB/s, for 600 text chunks/s sent |

Ryan chose to build all of it now rather than wait for the numbers to demand each piece (PLX-443, 2026-10-04). T3 Code's orchestration V2 is the reference. This record copies its single transaction per command, its outbox, and its app-owned ids. It doesn't copy whole-entity events, one large file per concern, or a global publish semaphore.

## Decision

### One writer, one transaction per job (PLX-481)

- The store's thread owns the only write connection. The event log's `Writer` thread and its connection go. Its read connection stays, for `agent/events`.
- Every store job that writes runs in `BEGIN IMMEDIATE` … `COMMIT`. A job stages its events. Staging assigns each event the next `seq` from a counter only the writer thread changes, and inserts its row. After `COMMIT`, the writer publishes the staged events to the in-memory window in `seq` order, then hands work to the effect dispatcher (below), then replies. A job that fails or panics rolls back. Nothing is published, and the counter goes back to where it was.
- The actor's `append` and `save`, the threads, inbox, queue, and project methods, and the context watcher become store jobs. Each stages its own events. An `agent.output` batch is one job.
- The shared connection runs with `synchronous = NORMAL`, as the event log's does today (`relax_sync` in `crates/parallax-store/src/events.rs`). With WAL, a process crash loses nothing, and a power loss can lose the newest commits but never corrupts the file. `FULL` would fsync once per output batch, up to 600 times a second at 30 runs.
- A batch whose transaction fails is logged and dropped, for live subscribers too. Today such an event is delivered but not kept (`EventLog::append` in `daemon/src/event_log.rs`). Never publishing what didn't commit is the point of the change.
- When the store can't open, the log runs in memory only with a new `logId`, as today. Commit, push, Open PR, and Accept then fail with the store's error, as project methods do, since there is no outbox to put them in.

### Command ids (PLX-482)

- Every request may carry `commandId`, a UUID, in its params. The dispatcher (`daemon/src/methods/mod.rs`) takes it out before a method parses its params, so methods that deny unknown fields still parse. Capability `commandIds`.
- These methods keep a receipt: `agent/approve`, `agent/commit`, `agent/push`, `agent/openPr`, `agent/resumeNow`, `queue/cancel`, `queue/steer`, `question/ask`, `question/answer`, `question/escalate`, `land/queue`, `land/approve`, `land/sendBack`, `project/start`, `project/delete`, and `thread/delete`. Other methods ignore it:
  - Methods with their own id keep it: `agent/start`, `thread/start`, `project/create` (the new id), `thread/fork` (`newRunId`), `agent/send` and `agent/requestChanges` (`turnId`), and `agent/accept` (`id`).
  - Methods that set a value are safe to repeat: `*/update`, `thread/archive`, `inbox/seen`, `pr/link`, `pr/unlink`, `agent/autoResume`, `agent/cancel`, `queue/edit`, `queue/reorder`, `accounts/defaults/set`, `host/settings/set`, and `repo/add` (unique by path).
  - Methods whose change is files, the keychain, or the network, which no transaction covers: `memory/*`, `context/write`, `providers/*`, `accounts/keys/add`, `accounts/keys/remove`, `accounts/refresh`, `github/*`, and `pr/act`.
- Table `command_receipts`:

| Column | |
| --- | --- |
| `command_id` | TEXT, primary key |
| `method` | TEXT |
| `params_hash` | TEXT, SHA-256 of the parsed params serialized again, without `commandId` |
| `run_id` | TEXT, null when the method names no run |
| `effect_id` | INTEGER, null unless the method enqueued an effect |
| `result` | TEXT, the JSON result or error object; null until the command ends |
| `created_at`, `finished_at` | TEXT |

  Index `command_receipts_run (run_id, created_at)` serves the timeline. Index `command_receipts_age (created_at)` serves pruning.
- **Claim first.** Before a listed method runs, the dispatcher claims its id in a writer job. The job inserts the row with `result` null. If the row already exists:
  - with the same method and hash and a result, it returns that result without running anything
  - with the same method and hash and no result, it waits for the result. Waiters live in memory, keyed by `command_id`. Whoever waits creates one: a retry on a new connection while the first request runs, or a repeat after a restart whose effect is still to run. Whatever fills or deletes the receipt wakes them, and a deleted claim's waiters get its error.
  - with a different method or hash, it answers `idConflict`.
- **Run to completion.** For a listed method, the dispatcher first spawns a task of its own, holding the request's `max_requests_in_flight` permit and a cancel token that the connection never cancels. That task does everything after: the claim job, the method, and deleting the claim on an error or panic. `daemon/src/server/connection.rs` cancels and aborts every handler when a connection closes, so an aborted handler can't leave a claim behind, because it never ran the claim itself. This is `daemon/src/store.rs`'s rule that a started job runs to the end, applied to the whole command.
  - A `$/cancelRequest` for a listed method doesn't stop it. The handler keeps waiting and answers with the command's real result, so -32800 still means nothing was done.
  - A graceful stop waits for detached commands and running effects within the same `shutdown_grace` it gives handlers (`daemon/src/server/mod.rs`). Whatever is still running then is left to start-time settlement, as after a crash.
- **The result.** The method's last write fills `result`.
  - A method whose change is one store job fills it in that job, so the change and its result commit together.
  - A method that enqueues an effect sets `effect_id` in the transaction that enqueues it. The effect's final transaction, or its settlement at start, fills the result.
  - A method that returns an error deletes the claim, so a repeat runs it again. A listed method that can fail after it has changed something stores that error as its result instead.
- **At start,** claims with no result and no `effect_id` are deleted, since the process that held them is gone, and a retry runs again. So a method made of several jobs, such as `question/answer` (a row, then a message) or `project/start` (rows, then a CLI), can apply twice across a crash. That is at least once, as 0048's queue is. A one-job method can't apply twice.
- Receipts are kept 7 days. Each insert deletes receipts older than that. A retry comes within seconds of a lost response, and the timeline (PLX-492) wants the last week.
- The app sends a new `commandId` with every mutating request and reuses it on retry. `plxd mcp` does the same for its write tools.

### The effect outbox (PLX-483)

- Side effects that outlive a request are rows in `effects`, inserted in the command's transaction:

| Column | |
| --- | --- |
| `id` | INTEGER primary key; order within a run |
| `run_id` | TEXT |
| `kind` | TEXT: `checkpoint`, `commit`, `push`, `openPr`, `accept` |
| `params` | TEXT, JSON |
| `status` | TEXT: `pending`, `running`, `done`, `failed` |
| `starts` | INTEGER, how many times it has started |
| `replay_safe` | INTEGER, set from the kind |
| `result` | TEXT, the JSON result or error object |
| `created_at`, `started_at`, `finished_at` | TEXT |

  Indexes `effects_run (run_id, id)`, and `effects_open (status) WHERE status IN ('pending', 'running')`.
- A dispatcher task runs each run's effects oldest first, one at a time. Different runs run in parallel, with no host-wide cap. Starting an effect is a job that sets `running` and increments `starts`. Ending one is a single transaction. It records the result, fills the receipt, and makes the effect's own changes, such as the run accepted or a pull request linked. It stages their events and `agent.effectFinished {runId, id, kind, ok}`.
- `agent/commit`, `agent/push`, `agent/openPr`, and `agent/accept` enqueue and await their effect, so their results on the wire don't change. A second effect on the same run waits its turn instead of failing as busy. `thread/delete` and `project/delete` fail every pending effect of the run ("run deleted") and refuse while one runs. The same transaction fills those effects' receipts with that error, and the delete wakes their waiters.
- While a run has an open effect, its actor sends the CLI no turn, the first prompt included. Messages wait in 0048's queue. Commit, push, and accept already refuse a running run (0014), so an effect never races a turn.
- An effect that fails ends `failed` at once, with its error as the result. A push that the remote refuses is one example. plxd doesn't retry it, and the user does.
- There is no lease. `plxd.lock` admits one `serve` per data folder (`daemon/src/server/setup.rs`), so at start every `running` row belongs to a dead process. Before any actor resumes a run (0048's queue, 0049's timers, 0025's catch-up), plxd settles them:

| Kind | Replay-safe | A `running` row at start |
| --- | --- | --- |
| `checkpoint` | yes | Runs again. No CLI has touched the worktree since. |
| `push` | yes | Runs again. Pushing the same branch again is a no-op. |
| `openPr` | yes | Runs again. It finds the pull request it opened (0014). |
| `commit` | no | Fails with "plxd restarted during the commit". The user checks the Git menu. |
| `accept` | no | Fails with "plxd restarted during Accept". The user retries. |

  Each failed row's error also fills its receipt, in the same transaction, so a repeat of the command gets the error instead of waiting. `pending` rows never started, so they all run. `starts` only bounds restart loops: a replay-safe effect found `running` at its third start ends `failed`.
- The commit plxd makes when a CLI ends (0014, `commit_all` from `Actor::finish`) stays inline, not an effect. It is the CLI's last step, and its result sets the run's outcome. It can run while the turn's checkpoint does. That's harmless, because the checkpoint reads `HEAD` once and snapshots files, not commits.
- CLI start and stop aren't effects. A CLI is a live process whose pipes die with plxd. Its durable record is its attempt (below), and restart keeps 0014's rule: interrupted, then resumed by session.
- Effect rows stay as long as their run, like its events (0016), and go when the run is deleted.

### Attempts and nodes (PLX-484)

- An attempt is one CLI process of a run. Table `attempts`, primary key `(run_id, n)`, with `n` counting from 1:

| Column | |
| --- | --- |
| `reason` | TEXT: `new` (the run's first CLI, or a fork's), `resume` (a send to an ended run, 0048's restart queue, 0049's auto-resume, a wake-up), `steer` (0048's cancel and resume), `move` (a send that changed account or backend, 0014, 0046) |
| `backend`, `account_id`, `model` | TEXT |
| `session_id` | TEXT, set when the CLI reports it; repeats across attempts that resumed it |
| `started_at`, `ended_at` | TEXT |
| `outcome`, `error` | TEXT, `agent.finished`'s; null while it runs |

- `runs.session_id` stays the current session, which resume reads. It is written in the same transaction as the attempt's. At start, open attempts end `interrupted`, alongside their runs (0014).
- `runs.parent` (0041) stays lineage between runs. Attempts are inside a run, and nodes inside an attempt. A node never gets a run row, and `parent` never names one.
- A node is a native subagent. Table `nodes`, primary key `(run_id, call_id)`, where `call_id` is the vendor's id for the call that started it (Claude Code's `parent_tool_use_id`). Columns: `attempt`, `parent_call_id` (null at top level, else the subagent whose transcript started it), `agent_type`, `model`, `status` (`running`, `completed`, `failed`, `stopped`), `summary`, `started_at`, `ended_at`. The actor writes a node on its first `subagent` item and finishes it on `subagentFinished`. At an attempt's end, nodes still running become `stopped`, as 0041's status rule says.
- `agent.output` and `agent.finished` gain `attempt` (its `n`). The actor flushes a batch when a turn ends and when a CLI ends, so a batch belongs to one turn and one attempt. Items keep 0041's `subagent {callId}` wrapper as their node, so items get no new field.
- `agent/timeline {runId}` → `{attempts, nodes, commands, effects}`, behind capability `timeline`. PLX-484 adds it with attempts and nodes. PLX-492 adds commands (receipts with the run's `run_id`) and effects, and the app's Timeline tab.

### Per-turn checkpoints (PLX-485)

- `runs.finished_turns` (INTEGER, default 0) counts a run's finished turns. The transaction that stores a turn's end increments it and enqueues `checkpoint {turn: n}`. When an attempt starts and the run has no checkpoint yet, plxd first enqueues `checkpoint {turn: 0}`, the state before the agent's first edit. Runs from before the migration get theirs at their next CLI.
- The effect snapshots the run's folder, a worktree or a Current checkout thread's checkout, without touching the user's index or branch. It resolves `HEAD` once, then uses a temporary `GIT_INDEX_FILE` in the run's temp folder: `read-tree <head>`, then `add -A` (untracked files that aren't ignored are included), then `write-tree`, then `commit-tree -p <head>`, then `update-ref refs/parallax/checkpoints/<run>/turn/<n>`. It uses #166's pinned git folder, with no hooks. A coordinator's run writes nothing (0024) and gets none.
- The next turn waits for the checkpoint, as for any open effect, so the snapshot is the turn's own. There are two exceptions. A background subagent that writes after its turn ends has those writes land in the next turn's checkpoint. A turn that ends without being stored as finished (a crash, or a restart) gets no checkpoint, and its edits land in the next one.
- `agent/turnDiff {runId, turn}` diffs turn `n`'s checkpoint tree against `n - 1`'s, for worktrees and checkout threads alike. It uses 0014's caps. A turn whose own ref or `n - 1`'s is missing is `invalidParams`.
- Pruning: a run keeps its newest 101 checkpoints, and each capture deletes refs beyond that. `agent/turnDiff` answers for the newest 100, and the 101st is kept only as the oldest one's diff base. All of a run's refs are deleted when it is accepted or deleted, with its worktree and branch.

### The handoff budget (PLX-486)

- `handoff(events, budget)` in `daemon/src/agents/handoff.rs` replaces both callers of `conversation`. Budgets:
  - `summary {cap}`: the whole conversation when it fits. Otherwise, walking newest first, turns stay whole while they fit, older turns shrink to their first and last lines, and if it is still too long, the oldest shortened turns go. The run's first message, its task, is always kept. A task that is over half the cap on its own is cut to half the cap, keeping its start.
  - `since {seq, cap}`: only what was logged after event `seq`, as `summary` within the cap. A `seq` inside a compacted turn (below) starts at that turn's `from`, so the turn is sent whole again rather than skipped.
- There is no uncapped `full`. A summary that fits is the full transcript, and an uncapped one is what blows the target's context.

| Caller | Budget |
| --- | --- |
| A move to another backend or provider (0014, 0046) | `summary`, 64 KiB |
| A fork with no session to continue (0050) | `summary`, 64 KiB, of the log up to the fork's turn |
| An attached thread the target hasn't seen (0047) | `summary`, 32 KiB (`maxSummaryBytes` stays) |
| An attached thread the target saw before | `since` the source `seq` its last summary covered, 32 KiB |
| `thread_read` (0041) | Not a handoff and unchanged: it pages `agent/events` in about 64 KiB pages, and the calling agent picks `after` |
| A wake-up (0025) | Unchanged: each finished child's task cut to 200 bytes, and a 500-byte excerpt (`TASK_BYTES`, `EXCERPT_BYTES` in `daemon/src/agents/wake.rs`) |

  The cursor is the source's own: the newest `seq` the summary read. It is stored in `attached_seen`, primary key `(target_run, source_run)`, with column `seq`, upserted in the transaction that records the target's turn. The target's later `turnStarted` would be the wrong cursor, because a running source can log events between the read and that event, and `since` would then skip them. Rows go with either run. A resume by session gets no handoff, since the session has it.

### Compacting finished turns (PLX-491)

- A finished turn's `agent.output` batches become one row, in place. In one transaction, the last batch's payload is rewritten to the turn's final items, and the turn's other `agent.output` batches are deleted. Other events inside the turn keep their rows. The final items merge consecutive text deltas and drop deltas that a whole `text` repeats. Tool calls and results stay as they are. Reusing the last batch's `seq` keeps the turn's place in the log. The rewritten event carries `compacted: {from}`, the turn's first `seq`.
- Only turns whose last batch is older than the in-memory window's oldest `seq` are compacted, so a live subscriber never sees a change. A sweep runs at start and hourly, one turn per job so it never holds the writer for long.
- **The reader rule.** A reader that meets a compacted row first drops any `agent.output` events of that run it holds with `seq` in [`from`, the row's `seq`), then takes the row. Three readers can hold raw batches of a turn that is later compacted:
  - an `agent/events` pager whose page ended inside a turn the sweep then compacted. Its next page starts with the compacted row.
  - an `agent/events` pager reading newest first with `before` (PLX-490), whose oldest page started inside a turn the sweep then compacted. The compacted row's `seq` is at or above that `before`, so no older page reaches it. plxd adds it to the page: a `before` page also carries the run's compacted row with `from` < `before` ≤ its `seq`, if there is one. The app keeps every event it loaded, so it applies the rule to them and builds the transcript again.
  - an `events/subscribe` cursor after a restart. Compaction deletes rows, so the restart's reload of the newest `retention` events reaches further back than the old window did. A cursor that would have needed a resync now replays and meets compacted rows.
  
  Either way the client ends up with the turn once, nothing skipped and nothing repeated. The app's transcript store applies the rule. An older app that doesn't shows that one turn's items twice until it reloads the run.
- plxd's own paged readers read inside one read transaction, so a sweep can't land between their pages. They are `logged_events` in `daemon/src/agents/actor.rs` (handoffs and forks, 1,000 events a page) and `attached::summary` (newest first, through `run_events_before`).
- PLX-491 updates 0016: a run's events still stay as long as its run does, now one row per finished turn.

### Write path

```
request ─► dispatcher: claim commandId (writer job; hit: return or wait)
        ─► writer: BEGIN IMMEDIATE
                   rows + staged events (seq) + receipt result + effects rows
                   COMMIT
        ─► publish events to the window ─► subscribers
        ─► dispatcher: per-run FIFO ─► effect ─► writer: result + receipt + events, COMMIT ─► publish
```

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Keep two writers and publish an event after its row commits | A crash between the two still leaves a row with no event, and the two keep taking turns on one write lock |
| Whole-entity events with projections rebuilt from them (T3 Code) | plxd's rows are already the state, and its events are deltas for clients. Rebuilding state from events is a rewrite with no user-facing gain |
| Write the receipt only in the transaction that makes the change | A retry in flight misses it and runs too, and methods that aren't one store job (`agent/approve`, `project/start`, `question/answer`) have no such transaction |
| A receipt for every method | Methods with their own id, or that set a value, don't need one |
| Leases on effects | One `serve` per data folder already makes every `running` row at start an orphan, so a lease adds a timer and says nothing new |
| A host-wide cap on running effects | Pushes and checkpoints of different runs don't contend, and a global gate makes one slow origin hold up every run |
| CLI start and stop in the outbox | A process and its pipes can't survive a restart, so replaying a start is a new attempt, which 0014's resume already does |
| Checkpoint while the next turn runs | The snapshot would race the agent's next edits |
| An uncapped `full` handoff | The size of a long run is the problem being fixed. A summary that fits is the full transcript |
| Write a compact record at turn end and delete the batches later | Both copies exist for the whole delay, so every reader would need to skip one. Rewriting in place needs the reader rule only for readers that already hold a turn's raw batches |
| Receipts kept forever, or 24 hours | Forever grows with every click. A day is too short for the timeline |

## Where this differs from the issues

Each issue's acceptance criteria follow this record:

| Issue | Its wording | This record |
| --- | --- | --- |
| PLX-482 | Receipt written in the same transaction as the change | Claimed before the method runs, and filled by its last write |
| PLX-483 | A lease expiry column | No lease. `starts` bounds restart loops |
| PLX-484 | `agent/get` (or `agent/list`) returns attempts | `agent/timeline` |
| PLX-485 | Turn diffs against the turn before | Plus `turn/0`, the base for turn 1 and for checkout threads |
| PLX-486 | Budgets `full`, `summary`, `since` | `summary` and `since`. A summary that fits is the full transcript |
| PLX-491 | Write a compact record at turn end, delete the batches after a delay | Rewrite in place once the turn has left the window, with the reader rule |

## Consequences

- A crash can't leave a row without its event, or an effect requested without its row. Subscribers never see an event that rolled back.
- Every output batch becomes a transaction on the one writer, up to 600 a second at 30 runs. PLX-481 has to show the harness at N=30 no worse than the baselines above, with the store's queue wait before and after.
- A retried request is applied once for the methods listed, even while the first is still running, and the app retries without asking. Across a crash, a method made of several jobs can apply twice. Methods outside the list need a key of their own if they ever stop being safe to repeat.
- A push or PR survives a restart. A commit or Accept a restart interrupts fails with a clear reason instead of disappearing.
- A run's history names each CLI process, its session, account, and model, and each native subagent.
- Each turn's diff is available, and rewinding to a turn (not decided here) has the ref to start from. Every turn costs a `git add -A` into a temporary index before the next one starts.
- Handoffs keep the task and recent turns within the same caps as today, and a thread attached again sends only what's new since its last summary.
- The database grows by one row per finished turn instead of one per 50 ms batch. Deleting finished runs (#207) stays open.
