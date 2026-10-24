# 0079: Coordinator continuity

- Status: accepted; supersedes [0024](0024-coordinator-chat.md)'s Start over for a coordinator whose session can't be resumed
- Date: 2026-10-23
- Issue: PLX-937

## Context

A coordinator's continuity was its provider session. Claude Code prunes a session after 30 idle days by default, and a removed account or a move to another backend loses it too. `agent/send` then failed, and the app offered Start over: `project/start` with a new run, a new thread that knew nothing of the Project until it read its context. A Project meant to run for months loses its coordinator this way. Ryan chose sessions that start from the Project's state, and only when resume fails or on the user's Fresh session, never after some number of compactions (Projects v2 spec, decisions 1 and 9).

## Decision

### Epochs

- A coordinator's run and thread are permanent. Each provider session of the run is an epoch, numbered from 1 and stored in `coordinator_sessions` with its session id, start, end, and end reason: `not-resumable`, `user-fresh`, `backend-change`, or `compacted-out`, which plxd doesn't write (decision 1). Migration 51 makes each coordinator with a session its epoch 1.
- When the CLI reports a session other than the open epoch's, plxd ends that epoch as `not-resumable` and starts the next.
- Each end adds an `epoch` output item, `{epoch, reason}`, which the app draws as a divider: "New session, picked up from the Project's state".

### When a new epoch starts

- Resume fails. A coordinator's every resume carries `Resume::fallback`, its packet and the message. Codex starts a new thread with it when `thread/resume` fails (PLX-728). For any other backend, routing starts a new session with it once, if the resume fails as `FailureKind::SessionNotFound` before its session starts, dropping the failed attempt's events. Claude Code reports a lost session as `No conversation found with session ID` (2.1.309).
- The session's account is gone. The coordinator role's default takes over, as `not-resumable`.
- Its account now runs on another backend, or `agent/send` moves it to one: `backend-change`. The new session gets the packet, not the handoff transcript.
- `coordinator/fresh {project}`, behind the `coordinatorEpochs` capability: refused with `idConflict` while a turn runs. It ends the idle CLI and the epoch as `user-fresh`, and clears the session, so the next message starts the next epoch. The app's Project menu has it as Fresh session.
- A replaced coordinator, one `project/start` replaced, still fails `runNotResumable` (0024).

### The packet

The first message of each new epoch, at most 24 KiB, then the message that starts it. In order: the brief, the memory index, the board rendered from its items, `checkpoint.md` when it exists, the open threads with their status and their history file's last result, the open questions, the landing queue with conflicts and failed checks, the user's last 10 messages verbatim, oldest first, and a pointer to `thread_search` and `thread_read` on the thread for older conversation. Empty sections are left out.

- The user's messages are their own: each turn records whether the user wrote it (`turns.from_user`, migration 51), not a wake-up, a usage limit's resume, or another thread's `thread_send`. A turn recorded before counts as the user's unless it starts "Parallax, not the user".
- The messages take their room first, whole: when the 10 alone pass the cap, the oldest are left out, never cut. The other sections fill what is left in order, and the one that would pass it is cut, with the rest left out.

### After a compaction

When a coordinator's CLI reports `ContextCompaction { done: true }`, its next turn carries a short note ahead of the message: the board, the open threads, and where `checkpoint.md` is. A turn that starts a new epoch doesn't, since its packet has them.

## Consequences

- A Project keeps one coordinator thread for as long as it lives, and its wake-ups, questions, and children stay with it. `project/start` still makes a Project's first coordinator, and replacing one still works through it, which the app no longer does.
- A new epoch is a new Claude conversation, so it records the current system prompt: it gets the current instructions and autonomy. A resume inside an epoch still has PLX-957's snapshot gap.
- OpenCode, ACP agents, and Cursor don't report a lost session as `SessionNotFound` yet, so a resume that fails there fails as before.
- The compaction note is kept in memory, so a restart between the compaction and the next turn drops it.
- A long brief, board, or checkpoint is cut before anything after it, since sections fill in order.
