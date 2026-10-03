# 0042: A Project's coordinator and children are threads, in Auto or Bypass Permissions

- Status: accepted; builds on [0041](0041-thread-lineage-and-host-mcp.md), and supersedes in part [0013](0013-worker-sandbox.md) and [0034](0034-threads-are-full-claude-code.md) (a coordinator's children keep the worker sandbox), [0024](0024-coordinator-chat.md) (only Claude Code coordinates), [0027](0027-claude-permission-modes.md) (where the coordinator runs, and children inheriting its mode), [0035](0035-codex-threads.md) (Codex children on `codex exec`), and [0036](0036-cursor-threads.md) (Cursor never runs a coordinator or its children)
- Date: 2026-10-03
- Issue: PLX-383

## Context

A thread is the user's own CLI in its thread mode (0034, 0035, 0036, 0040): their settings, instructions, skills, plugins, hooks, and MCP servers, in its own worktree. A Project's coordinator is Claude Code only (0024), and its children run as workers: 0013's sandbox in every mode but Bypass, a fixed tool list, `codex exec` for Codex (still refused, RYA-145), and Parallax's limits ahead of the task. So a Project runs a weaker agent than a plain thread, and every improvement to threads has to be made twice.

0041 already makes the coordinator an ordinary parent thread with the host-wide MCP. This record decides what a Project adds on top, and how its children keep moving with nobody watching. Ryan settled it on 2026-10-03.

## Decision

### One base

- **The coordinator and every child are threads**, started through the same path as a thread the user starts, on any provider instance (0040) whose kind offers the Project's permission mode. What is added on top:

| | Added to the thread |
| --- | --- |
| Child | `parent` set to the coordinator's run (0041), the first message below, and the Project tools for children: memory ([0044](0044-project-memory.md)) and `ask` ([0043](0043-project-inbox-and-autonomy.md)) |
| Coordinator | 0041's tools, the Project tools for coordinators (landing in [0045](0045-integration-branch.md), memory curation in 0044, the inbox in 0043, capacity and moves in [0046](0046-project-scheduler.md)), and wake-ups |

- **No worker path for children.** A child gets no `--restricted`, fixed `--tools`, `--strict-mcp-config`, `codex exec`, or Parallax limits in its first message. 0013's sandbox stays only for a thread whose client doesn't answer permission requests (0034).
- **Any provider coordinates.** Claude Code, Codex, Cursor, and any instance whose kind has the Project's mode can run the coordinator or a child, chosen per thread.

### A Project runs in Auto or Bypass Permissions

- A Project has a permission mode, `auto` or `bypass`, set when it's created and changeable later. The coordinator and every child run in it. Manual, Accept Edits, and Plan aren't offered: a child in one of them stops at its first command until someone answers, and without the sandbox nothing else lets it go on.
- Each kind maps the mode as it does for threads: Claude Code and Codex offer both, Cursor, Grok Build (`--always-approve`), and Hermes Agent (`dont_ask`) offer only Bypass, and a kind with neither (OpenCode, Pi, Oh My Pi, Antigravity, other ACP agents) can't run in a Project. A child placed on a kind that lacks the Project's mode is refused with a reason ("Cursor has no Auto. Set the Project to Bypass to use it."), never moved up to Bypass on its own.
- Auto can still ask: Claude Code's classifier and Codex's reviewer send what they won't decide to the app (0031, 0035). Such a request goes to the inbox under Needs you. It holds only that child, and 0031's 30-minute limit denies it if nobody answers, so the child goes on.
- **The disclaimer.** Create Project, and Make a project (below), show a dialog before creating: a Project's agents run without asking, so they can edit files, run commands, use the network, and push with the user's credentials, and Bypass has no second check. The user picks Auto or Bypass there. It shows every time a Project is created.

### Dispatch

- **The composer has two targets.** New task, the default, starts a child. Ask sends the message to the coordinator. A keyboard shortcut flips between them.
- **New task never waits on the coordinator.** `thread/start` gains `project`. With it, plxd sets `parent` to the Project's coordinator, cuts the worktree from the integration branch's tip ([0045](0045-integration-branch.md)), builds the first message, places the run ([0046](0046-project-scheduler.md)), and starts it. The coordinator hears about it in its next wake-up, batched as 0025 batches.
- **The first message** is a short header naming the Project and the child's tools, the brief, the memory index (0044), and then the user's words. A child the coordinator launches gets the same header with the coordinator's task in place of the user's words.

### The coordinator writes no code

- Its instructions say it never edits files. It plans, dispatches, reviews, curates memory, and lands work. Any change to code is a child.
- It runs in a detached worktree of the Project's repository at the integration branch's tip, which plxd refreshes before each CLI process as 0024's RYA-171 worktree did. An edit it makes anyway reaches neither the user's checkout nor the integration branch. This replaces 0027's coordinator in the user's checkout.
- 0027's "subagents inherit the coordinator's mode" is replaced by the Project's mode.

### Where children show

- Only inside the Project, never in the main sidebar. The Project's sidebar row shows their combined status, as 0033 does.
- The Project view is the coordinator chat in the center and its children in the side panel, ordered Needs you, Working, Done, Failed. A child opens as a full thread in place, with 0041's parent chip back to the coordinator. The user can always message a child directly.

### Make a project from threads

- Selecting threads on one repo and one host offers Make a project. It shows the disclaimer, creates a Project on that repo, starts its coordinator, and sets each thread's `parent` to it. The threads keep their history and worktrees, and switch to the Project's mode from their next turn. The coordinator reads them (`thread_read`) and drafts the brief for the user to approve.
- Their branches land on the integration branch like any child's, since landing merges.

## Consequences

- One runtime. A fix to threads reaches coordinators and children, and a Project never runs a weaker agent than a thread.
- Children have the user's credentials, network, and hooks, with Auto's classifier or nothing between them and the machine. The disclaimer and the Project's mode are the only guard. A Project can't use providers that have neither mode.
- A Project in Auto can't place a child on Cursor. The user has to choose Bypass to mix it in.
- The coordinator can't make a quick fix itself. A one-line change is a child, which costs a run.
- RYA-145 (Codex workers on `codex exec`) is no longer needed.
