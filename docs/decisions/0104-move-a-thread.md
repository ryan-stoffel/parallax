# 0104: Move a thread to another computer

- Status: accepted; amends [0101](0101-agents-work-across-computers.md) ("Existing threads stay put"), and builds on [0050](0050-fork-a-thread.md) and PLX-1143's Remote Control move
- Date: 2026-11-12
- Issue: PLX-1538

## Context

Ryan wants to start a thread on one computer and later continue it from another. A thread lives on the plxd that started it: its log, its CLI session, and its worktree. 0101 lets an agent start new work elsewhere, but an existing thread can't leave. PLX-1143 moves only a Claude Remote Control thread, whose session already runs on the other computer.

## Decision

- **The app moves it,** since it's connected to both computers and the user is there to ask. No `agentWork` or peer session is needed, so it works with any computer the app reaches.
- **`thread/export`** on the source returns the thread's prompt, title, backend, options, and transcript, cut as a fork at its latest turn (0050). It refuses a running thread. Past 6 MiB it leaves out the oldest events, so it and `thread/receive` stay under the 8 MiB frame limit.
- **`thread/receive`** on the target makes it a thread shaped as an import (PLX-881): the copied transcript, no CLI until the first follow-up, which tells a new session the conversation (0014). Its run id comes from the exported one, so a retry returns the same thread.
- **Code moves through `origin`,** as 0101's delegation does. A thread in a repository refuses uncommitted changes. The target finds its copy of the repository with `repo/match`, so a missing one refuses before anything is pushed, then the source pushes its branch with `agent/push` and the target fetches it with `repo/fetchBase`. The move stops unless the fetched commit is the one the source pushed, since a failed fetch keeps what was fetched last. The moved thread works in a new worktree from `origin/<branch>`. A thread with no repo moves only its conversation.
- **The source is archived** once the target has the thread. Both are behind the `threadMove` capability.

## Rejected

| Option | Why not |
| --- | --- |
| Copying the CLI's session file | Each CLI stores sessions its own way, and Claude Code's are keyed by the working folder's path, which differs on the other computer. A handoff works for every provider. |
| plxd moves it through a peer session | It needs `agentWork` on the target. The app is already connected to both. |
| Git bundles instead of a push (0057) | Bundles write to a run that already exists on the target. A push is what 0101 settled on. |

## Consequences

- The moved thread's first message starts a new session, so it keeps what was said but not the CLI's own context, as a fork onto another provider does.
- Moving a thread in a repository pushes its branch to `origin`.
- The target needs a clone of the repository with the same `origin`.
