# 0052: plxd's orchestration kernel

- Status: accepted; supersedes in part [0014](0014-agent-runs.md) (the event log's own writer thread, and a move's handoff cut from the front) and [0016](0016-event-log-retention.md) (a run's events are never compacted), and [0047](0047-thread-search-and-context.md)'s attached-thread summary cut from the front
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
- When the store can't open, the log runs in memory only with a new `logId`, as today.

### Command ids (PLX-482)

- Every request may carry `commandId`, a UUID, in its params. The dispatcher (`daemon/src/methods/mod.rs`) takes it out before a method parses its params, so methods that deny unknown fields still parse. Capability `commandIds`.
- These methods keep a receipt: `agent/approve`, `agent/commit`, `agent/push`, `agent/openPr`, `agent/resumeNow`, `queue/cancel`, `queue/steer`, `question/ask`, `question/answer`, `question/escalate`, `land/queue`, `land/approve`, `land/sendBack`, `project/start`, `project/delete`, and `thread/delete`. Other methods ignore it:
  - Methods with their own id keep it: `agent/start`, `thread/start`, `project/create` (the new id), `thread/fork` (`newRunId`), `agent/send` and `agent/requestChanges` (`turnId`), and `agent/accept` (`id`).
  - Methods that set a value are safe to repeat: `*/update`, `thread/archive`, `inbox/seen`, `pr/link`, `pr/unlink`, `agent/autoResume`, `agent/cancel`, `queue/edit`, `queue/reorder`, and `repo/add` (unique by path).
  - Methods whose change is files, the keychain, or the network, which no transaction covers: `memory/*`, `context/write`, `providers/*`, `github/*`, and `pr/act`.
- Table `command_receipts`:

| Column | |
| --- | --- |
| `command_id` | TEXT, primary key |
| `method` | TEXT |
| `params_hash` | TEXT, SHA-256 of the parsed params serialized again, without `commandId` |
| `run_id` | TEXT, null when the method names no run |
| `effect_id` | INTEGER, null unless the method enqueued an effect |
| `result` | TEXT, the JSON result or error object; null while its effect runs |
| `created_at`, `finished_at` | TEXT |

  Index `command_receipts_run (run_id, created_at)` serves the timeline. Index `command_receipts_age (created_at)` serves pruning.
- The receipt is written in the transaction that makes the change. A method whose change is one store job writes the result there. A method that enqueues an effect writes `effect_id` there, and the effect's final transaction writes the result. A method that fails rolls back, receipt included, so a repeat runs it again.
- A repeat with the same id and hash returns the stored result without running. A repeat whose effect hasn't ended waits for it. The same id with a different method or hash is `idConflict`.
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
| `attempts` | INTEGER, starts it has had |
| `replay_safe` | INTEGER, set from the kind |
| `result` | TEXT, the JSON result or error object |
| `created_at`, `started_at`, `finished_at` | TEXT |

  Indexes `effects_run (run_id, id)`, and `effects_open (status) WHERE status IN ('pending', 'running')`.
- A dispatcher task runs each run's effects oldest first, one at a time. Different runs run in parallel, with no host-wide cap. Starting an effect is a job that sets `running` and increments `attempts`. Ending one is a single transaction. It records the result, fills the receipt, and makes the effect's own changes, such as the run accepted or a pull request linked. It stages their events and `agent.effectFinished {runId, id, kind, ok}`.
- `agent/commit`, `agent/push`, `agent/openPr`, and `agent/accept` enqueue and await their effect, so their results on the wire don't change. A second effect on the same run waits its turn instead of failing as busy. `thread/delete` and `project/delete` fail every pending effect of the run ("run deleted") and refuse while one runs.
- While a run has an open effect, its actor sends the CLI no turn. Messages wait in 0048's queue. Commit, push, and accept already refuse a running run (0014), so an effect never races a turn.
- There is no lease. `plxd.lock` admits one `serve` per data folder (`daemon/src/server/setup.rs`), so at start every `running` row belongs to a dead process. Before any actor resumes a run (0048's queue, 0049's timers, 0025's catch-up), plxd settles them:

| Kind | Replay-safe | A `running` row at start |
| --- | --- | --- |
| `checkpoint` | yes | Runs again. No CLI has touched the worktree since. |
| `push` | yes | Runs again. Pushing the same branch again is a no-op. |
| `openPr` | yes | Runs again. It finds the pull request it opened (0014). |
| `commit` | no | Fails with "plxd restarted during the commit". The user checks the Git menu. |
| `accept` | no | Fails with "plxd restarted during Accept". The user retries. |

  `pending` rows never started, so they all run. A replay-safe effect stops after 3 attempts.
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

- `runs.turns` (INTEGER, default 0) counts a run's finished turns. The transaction that stores a turn's end increments it and enqueues a `checkpoint {turn}` effect.
- The effect snapshots the run's folder, a worktree or a Current checkout thread's checkout, without touching the user's index or branch. It uses a temporary `GIT_INDEX_FILE` in the run's temp folder: `read-tree HEAD`, then `add -A` (untracked files that aren't ignored are included), then `write-tree`, then `commit-tree` parented on `HEAD`, then `update-ref refs/parallax/checkpoints/<run>/turn/<n>`. It uses #166's pinned git folder, with no hooks. A coordinator's run writes nothing (0024) and gets none.
- The next turn waits for the checkpoint, as for any open effect, so the snapshot is the turn's own. One exception is a background subagent that writes after its turn ends. Its writes land in the next turn's checkpoint.
- `agent/turnDiff {runId, turn}` diffs turn `n`'s checkpoint tree against `n - 1`'s, and turn 1's against the worktree's base. It uses 0014's caps.
- Pruning: a run keeps its newest 100 checkpoints, and each capture deletes refs beyond that. All of a run's refs are deleted when it is accepted or deleted, with its worktree and branch.

### The handoff budget (PLX-486)

- `handoff(events, budget)` in `daemon/src/agents/handoff.rs` replaces both callers of `conversation`. Budgets:
  - `summary {cap}`: the whole conversation when it fits. Otherwise, walking newest first, turns stay whole while they fit, older turns shrink to their first and last lines, and if it is still too long, the oldest shortened turns go. The run's first message, its task, is always kept.
  - `since {seq, cap}`: only what was logged after event `seq`, as `summary` within the cap.
- There is no uncapped `full`. A summary that fits is the full transcript, and an uncapped one is what blows the target's context.

| Caller | Budget |
| --- | --- |
| A move to another backend or provider (0014, 0046) | `summary`, 64 KiB |
| A fork with no session to continue (0050) | `summary`, 64 KiB, of the log up to the fork's turn |
| An attached thread the target hasn't seen (0047) | `summary`, 32 KiB (`maxSummaryBytes` stays) |
| An attached thread the target saw before | `since` the `seq` of the target's last `turnStarted` that listed it, 32 KiB |

  `seq` is daemon-wide, so the target's own event marks what it saw in the other run's log, and nothing new is stored. A resume by session gets no handoff, since the session has it.

### Compacting finished turns (PLX-491)

- A finished turn's `agent.output` batches become one row, in place. In one transaction, the last batch's payload is rewritten to the turn's final items, and the turn's other batches are deleted. The final items merge consecutive text deltas and drop deltas that a whole `text` repeats. Tool calls and results stay as they are. Reusing the last batch's `seq` keeps the turn's place in the log, and no new table or reader logic is needed. The rewritten event carries `compacted: {from}`, the turn's first `seq`.
- Only turns whose last batch is older than the in-memory window's oldest `seq` are compacted, so a live subscriber never sees a change. A sweep runs at start and hourly, one turn per job so it never holds the writer for long.
- A subscriber whose cursor falls inside a compacted turn, which can happen after a restart reloads further back, gets `resyncRequired`.
- PLX-491 updates 0016: a run's events still stay as long as its run does, now one row per finished turn.

### Write path

```
request ─► dispatcher (commandId: receipt hit? return it)
        ─► writer: BEGIN IMMEDIATE
                   rows + staged events (seq) + receipt + effects rows
                   COMMIT
        ─► publish events to the window ─► subscribers
        ─► dispatcher: per-run FIFO ─► effect ─► writer: result + receipt + events, COMMIT ─► publish
```

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Keep two writers and publish an event after its row commits | A crash between the two still leaves a row with no event, and the two keep taking turns on one write lock |
| Whole-entity events with projections rebuilt from them (T3 Code) | plxd's rows are already the state, and its events are deltas for clients. Rebuilding state from events is a rewrite with no user-facing gain |
| A receipt for every method, written by the dispatcher in its own transaction | Its transaction isn't the change's, so a crash between them answers a repeat wrongly. Methods with their own id, or that set a value, don't need one |
| Leases on effects | One `serve` per data folder already makes every `running` row at start an orphan, so a lease adds a timer and says nothing new |
| A host-wide cap on running effects | Pushes and checkpoints of different runs don't contend, and a global gate makes one slow origin hold up every run |
| CLI start and stop in the outbox | A process and its pipes can't survive a restart, so replaying a start is a new attempt, which 0014's resume already does |
| Checkpoint while the next turn runs | The snapshot would race the agent's next edits |
| An uncapped `full` handoff | The size of a long run is the problem being fixed. A summary that fits is the full transcript |
| Write a compact record at turn end and delete the batches later | Both copies exist in between, so readers would need to skip one. Rewriting in place after the window has passed needs no reader change |
| Receipts kept forever, or 24 hours | Forever grows with every click. A day is too short for the timeline |

## Consequences

- A crash can't leave a row without its event, or an effect requested without its row. Subscribers never see an event that rolled back.
- Every output batch becomes a transaction on the one writer, up to 600 a second at 30 runs. PLX-481 has to show the harness at N=30 no worse than the baselines above, with the store's queue wait before and after.
- A retried request is applied once for the methods listed, and the app retries without asking. Methods outside the list need a key of their own if they ever stop being safe to repeat.
- A push or PR survives a restart. A commit or Accept a restart interrupts fails with a clear reason instead of disappearing.
- A run's history names each CLI process, its session, account, and model, and each native subagent.
- Each turn's diff is available, and rewinding to a turn (not decided here) has the ref to start from. Every turn costs a `git add -A` into a temporary index before the next one starts.
- Handoffs keep the task and recent turns within the same caps as today, and a coordinator re-reading a child sees only what's new.
- The database grows by one row per finished turn instead of one per 50 ms batch. Deleting finished runs (#207) stays open.
