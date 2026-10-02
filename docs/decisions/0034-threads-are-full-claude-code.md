# 0034: A thread is full Claude Code in every mode

- Status: accepted; supersedes in part [0013](0013-worker-sandbox.md) and [0017](0017-normal-threads.md) (a thread's sandbox and first prompt), and [0031](0031-permission-requests.md) (a thread asks in Accept Edits too)
- Date: 2026-10-01
- Issue: RYA-276

## Context

A normal thread (0017) ran in the worker sandbox (0013) in every mode but Bypass Permissions (0027): `--restricted`, a fixed `--tools`, `--strict-mcp-config`, git metadata read-only, and a first message that listed Parallax's limits, among them "Don't commit or change git history" and "localhost is unreachable". A thread therefore didn't behave like Claude Code in a terminal or a T3 Code thread. A real Claude Code 2.1.286 thread through plxd on `develop`, in Accept Edits, answered:

- that no global `CLAUDE.md` was in its context
- that it had no Skill tool, so no skills
- that it skipped `git commit` because its first message forbade it

Ryan wants a prompt sent in Parallax to work as it does in Claude Code or T3 Code. 0027 already runs a coordinator and a bypass worker as full Claude Code.

## Decision

- **No sandbox.** A thread whose client answers permission requests (`approvals`, 0031) gets, for its Claude Code run, the arguments a bypass worker gets (0027), in every mode: its `--permission-mode`, `--allowedTools` with the todo tools, `--add-dir` for its writable folders, and `--settings` with only the task list's `env` (RYA-251). There is no `--restricted`, `--tools`, `--strict-mcp-config`, or sandbox settings. The user's, project's, and local settings, `CLAUDE.md` files, skills, plugins, hooks, subagents, and MCP servers all load, and git and the network work as in a terminal. Its `system/init` may list any tool, and must still report the requested mode and a Claude Code of at least `WORKER_MIN_VERSION`.
- **Asking.** A thread with `approvals` asks over stdio (0031) in Accept Edits too, as well as in Manual, Auto, and Plan. Nothing sandboxes its commands, so in Accept Edits its Bash calls prompt, as in a terminal, and headless Claude Code would deny them otherwise. Bypass Permissions asks about nothing. In Plan it has `ExitPlanMode` as a coordinator does, since it has no `--tools` list.
- **The first message** of a thread is the user's message as written. A provider handoff's is the conversation and the new message, with nothing before them.
- **What stays.** A thread still runs in its own worktree, in its scratch repository, or in the user's checkout (RYA-264). plxd still commits what is left uncommitted in a worktree when the CLI exits. The agent may commit and push itself. Where the worktree is cut from, and which ref a checkout thread switches to, are unchanged (`base` and `checkoutRef` from RYA-281). `RunRequest.thread` marks the run, set for a run whose scope is a repo entry (0017).
- **Without `approvals`** a thread keeps 0013's sandbox and runs as before. Its client can't show a request, so with no sandbox every Bash call its allow rules don't cover would be denied, in Accept Edits too. That covers threads started before the app showed requests (RYA-196) when they resume, and clients that don't send the flag. Its first message is still the user's own.
- **Workers** that a coordinator spawns keep 0013's sandbox, in every mode but Bypass Permissions.

## Consequences

- A thread can do anything Claude Code can on the host as the user, as 0027 records for a coordinator: read `~/.ssh`, push, and run the repository's hooks and MCP servers. Manual, Accept Edits, Auto, and Plan ask through the app for what Claude Code would ask about, and the user's allow rules apply.
- A thread can write outside its worktree, including the user's checkout and other threads' worktrees. plxd still commits only what is in its worktree.
- A thread on Linux still needs Claude Code's sandbox to work on the host (`linux_sandbox::check_host`), and threads still need macOS or Linux. Neither is used by the run any more, so relaxing both is a follow-up.
- A thread's notes folder is no longer named in its first message, so an agent writes notes there only when asked.

## Evidence

On 2026-10-01, on macOS 27.0 with Claude Code 2.1.286 and Ryan's own subscription, `plxd serve` with a fresh data folder ran threads started over `plxd attach` with `approvals: true`, each request allowed:

| Thread | Asked | Result |
| --- | --- | --- |
| `develop`, Accept Edits, new worktree | Name from the global `CLAUDE.md`; three skills; commit; push to a local remote | No `CLAUDE.md`, no Skill tool, commit skipped "because this session's rules say not to commit" |
| This change, Accept Edits, new worktree | The same | "Ryan"; `simplify`, `code-review`, `ponytail:ponytail`; committed and pushed the worktree's branch |
| This change, Manual, Current checkout of a GitHub clone | Invoke the `ponytail:ponytail-help` skill; count `mcp__` tools; `git fetch`; `git push --dry-run` over HTTPS | Skill ran; 346 MCP tools; fetch and the authenticated dry-run push succeeded |

`gh auth status` failed the same way in the thread and in Ryan's own shell, because the account had hit GitHub's API rate limit.
