# 0062: Each turn is checkpointed, diffed, and revertible

- Status: accepted; supersedes [0052](0052-orchestration-kernel.md)'s per-turn checkpoints (PLX-485, never built) and in part [0014](0014-agent-runs.md) (plxd commits a run when its CLI exits)
- Date: 2026-10-09
- Issue: PLX-636, for PLX-647

## Context

plxd commits a run's worktree when its CLI exits (`Actor::finish` and `commit_all` in `daemon/src/agents/actor.rs`, `daemon/src/worktree/mod.rs`), and `agent/diff` diffs that commit against the worktree's base (`daemon/src/agents/review.rs`). Nothing records the worktree per turn, and no turn can be undone. The app's Changes panel is an empty state ("No changes yet", `apps/desktop/src/renderer/SidePanel.tsx`), and the renderer never calls `agent/diff` or `agent/accept`. 0052 specified per-turn refs, but PLX-485 was never built.

T3 Code (`apps/server/src/`):

- **Refs.** `refs/t3/orchestration-v2/checkpoints/<scope hash>/ordinal/<n>` (`orchestration-v2/CheckpointService.ts`), one root scope per thread.
- **Capture** (`vcs/GitVcsDriver.ts`): a temporary `GIT_INDEX_FILE` seeded from the real index, `add -A` (untracked files that aren't ignored are included), `write-tree`, `commit-tree` with no parent, `update-ref`. It sets `core.fsmonitor=false` and handles sparse checkouts. A per-folder lock serializes capture, restore, and delete. A folder that isn't a git repository gives `missing`.
- **When.** The baseline (ordinal `n - 1`) is captured when a run starts, if it's missing. A `checkpoint.capture` effect runs after a root run ends `completed`, `interrupted`, or `cancelled`, not `failed` (`orchestration-v2/RunExecutionService.ts`, `CheckpointCaptureService.ts`). Capture is idempotent. Subagents get no app-level checkpoint. Each records per-file line counts and a `checkpoint` turn item.
- **Diffs** (`checkpointing/CheckpointDiffQuery.ts`): `getTurnDiff(from, to)` over `ready` checkpoints of completed runs, whitespace ignored by default, capped at 10 MB. `getFullThreadDiff` is `getTurnDiff(0, to)`. The web DiffPanel offers Changes (branch against base), Uncommitted, Latest turn, and Turn N (`apps/web/src/components/DiffPanel.tsx`).
- **Revert** (`orchestration-v2/Orchestrator.ts`, `CommandPolicy.ts`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts`): `checkpoint.rollback` needs a provider that can roll back its conversation (`canRollbackThread`: Codex, Claude, OpenCode, ACP, and Pi yes; Cursor no), a `ready` checkpoint, and an idle thread. The `provider-thread.rollback` effect rolls back the provider first (Codex `thread/rollback`, Claude by resuming at the message, [0061](0061-claude-agent-sdk.md)), then restores files with `git restore --source <checkpoint> --worktree --staged`, `clean -fd`, and `reset`, then deletes refs above the target and marks later runs `rolled_back` and their checkpoints `stale`. Restoring files needs an isolated worktree: no other thread, session, or project root may share or contain the folder. The dialog "Edit from here?" offers "Revert files too" and "Revert and keep changes", and puts the prompt back in the composer (`apps/web/src/components/ChatView.tsx`).
- T3 never prunes checkpoint refs except on rollback.

## Decision

plxd does the same, on [0059](0059-orchestration-rewrite.md)'s runs and effects.

- **Refs** are `refs/parallax/checkpoints/<thread id>/<ordinal>`, in the thread's folder: its worktree, or the checkout of a Current checkout thread. Thread ids are UUIDs, so they need no hashing. A `checkpoints` row records the ref, the run, line counts per file, and the status (`ready`, `missing`, `error`, `stale`).
- **Capture** is T3's, with #166's pinned git folder, no hooks, and `core.fsmonitor=false`: temporary index from the real one, `add -A`, `write-tree`, `commit-tree` with no parent, `update-ref`. It never touches the user's index or branch. The baseline is captured when a run starts and the previous ordinal has no checkpoint. `checkpoint.capture` is enqueued in the transaction that ends a root run `completed`, `interrupted`, or `cancelled`. It is replay-safe and idempotent, so a restart runs it again. The thread's next run waits for it, since effects on one thread run in order. A coordinator writes nothing (0024) and gets none.
- **The commit on CLI exit goes.** Commit, Push, Open PR, and Accept stay in the Git menu as effects (0059). `agent/diff` keeps working for the Git menu's committed range.
- **Diffs.** `orchestration/getTurnDiff {threadId, from, to}` and `orchestration/getFullThreadDiff {threadId, to}`, T3's rules: `ready` checkpoints of completed runs, whitespace ignored unless asked, 10 MB cap.
- **The Changes panel** shows T3's scopes: Changes (the branch against its base), Uncommitted, Latest turn, and Turn N. Each turn's checkpoint item in the transcript opens its diff.
- **Revert** is `checkpoint.rollback {threadId, checkpointId, restoreFiles}`, refused with a reason before anything changes unless the thread is idle, the checkpoint is `ready`, and the adapter declares `rollback` ([0060](0060-provider-sessions.md)): Codex `thread/rollback`, Claude by `resumeSessionAt`, OpenCode and ACP where their protocol supports it, Cursor refused. With `restoreFiles`, the thread's folder must be an isolated worktree, by T3's rule, so a Current checkout thread can revert only its conversation. The effect runs T3's order: provider, files, stale refs, then the projection changes in one transaction.
- **The dialog** is T3's: "Edit from here?" with "Revert files too" and "Revert and keep changes", and the reverted prompt back in the composer.
- **Retention.** No count cap, as T3. A thread's refs are deleted with the thread and when it is accepted, as its worktree and branch are.

## Consequences

- Every turn's changes are reviewable in the app, and a turn can be undone, with or without its files.
- Every finished turn costs one `git add -A` into a temporary index before the next turn starts. A huge untracked tree makes that slow. PLX-647 measures it on a large repository.
- Without the commit on exit, an agent's work stays uncommitted until the user commits, accepts, or the agent commits. Checkpoints keep it recoverable in the meantime.
- Cursor threads can't revert. Threads in the user's own checkout can revert the conversation but not the files.
- Checkpoint refs keep objects reachable until their thread is deleted or accepted.
