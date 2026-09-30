# Decision records

A decision that affects more than one issue gets a record here. Records supersede `docs/PLAN.md` where they differ.

| Record | Decision |
| --- | --- |
| [0001](0001-ci-before-product-code.md) | CI is built before product code, against a stand-in Electron app, which #38 retired for the real `Wisp.app` |
| [0002](0002-editor-fork-strategy.md) | The editor is upstream Code - OSS at a pinned tag plus a patch series |
| [0003](0003-naming.md) | Wisp, `wisp`, and `wispd`; the `wisp` launcher went with the editor ([0020](0020-drop-the-editor-fork.md)) |
| [0004](0004-subscription-providers.md) | Subscriptions run through each vendor's official CLI; wisp never handles consumer credentials |
| [0005](0005-shared-context-folder.md) | Shared context is a daemon-owned folder outside the repo |
| [0006](0006-release-versioning-and-packaging.md) | Versions come from release tags; macOS releases are arm64-only ([0023](0023-cross-platform.md) adds Linux and Windows) and ad-hoc signed until #7; bundle id `io.github.ryan-stoffel.wisp` |
| [0007](0007-editor-wispd-protocol.md) | The editor speaks JSON-RPC 2.0 as newline-delimited JSON through `wispd attach`, locally or over the user's `ssh`; types come from the `wisp-protocol` crate |
| [0008](0008-editor-overlay.md) | `editor/product.json` and `editor/overlay/` reach the editor tree as one commit under the patches, never as a patch |
| [0009](0009-wispd-data-folder-and-project-host.md) | wispd's files, overrides, log, and exit codes in the data folder; projects have no host field |
| [0010](0010-wispd-attach.md) | `wispd attach` starts wispd through the LaunchAgent `io.github.ryan-stoffel.wisp.wispd` or as a detached `serve`, and exits 4 when it never reaches wispd |
| [0011](0011-agents-window-baseline.md) | wisp opens into upstream's Agents window, laid out like Cursor's Projects: a built-in `ISessionsProvider` and wisp-owned sidebar in the overlay, subagents as tool-origin chats behind the Agents pill, and a few patches |
| [0012](0012-account-routing.md) | `AccountChoice` names a subscription by its backend or a key account by id; per-role defaults live in a `role_defaults` store table; a backend serves both credential kinds for its provider, so fallback never switches backends |
| [0013](0013-worker-sandbox.md) | Workers run in their vendor's own OS sandbox: they write only their worktree, the shared context folder, and temp; their commands can't read a denylist of credential stores but do have network access; wispd commits. Claude workers use `--restricted` with Claude Code's Bash sandbox |
| [0014](0014-agent-runs.md) | The `agents` capability is `agent/start`, `send`, `cancel`, `list`, and `events`; a run outlives its CLI processes, wispd commits it after each one, and it resumes by session after a restart; the event log is stored in SQLite; agents get no SSH session variables and a filled-in `PATH` |
| [0015](0015-subagent-chats.md) | Each agent run is a `wisp.agent` chat of its project's session; the subagents' chat agent is the default for agent-mode chat, which upstream needs to send anything; the Agents pill opens wisp's own panel through a presenter hook in `chatDropdownPill.ts`, and shows by default |
| [0016](0016-event-log-retention.md) | The stored event log prunes host and project events by count; a run's events stay until its run row does, which nothing removes yet (#207); the in-memory replay window is also bounded by bytes |
| [0018](0018-pr-visuals-on-request.md) | `screenshots.yml` runs only for PRs with the `screenshots` label and captures only the scenes the body's `wisp-media` block names (`after`, `before-after`, `video`), into a section of the PR body instead of a comment; supersedes the every-PR rule |
| [0019](0019-coordinator-mcp-tools.md) | The coordinator's wisp tools are `wispd mcp`, an MCP server on stdio bound to one project and one coordinator thread by arguments wispd sets; its runs carry `coordinatorThread`; Claude's coordinator allowlist is its read tools plus exactly the eight `mcp__wispd__*` tools |
| [0020](0020-drop-the-editor-fork.md) | The editor fork, its UI tests, the screenshot and release workflows, and the TypeScript generator are gone; wisp is `wispd` only until a new frontend is decided; [0022](0022-desktop-app.md) supersedes its no-UI part |
| [0021](0021-linear-work-record.md) | The Linear project Wisp replaces GitHub issues: milestones M0 to M7 are epics with sub-issues; branches are `<type>/RYA-n-<slug>`, commits end with `(RYA-n)`, and PR bodies link the issue; blocked work gets the Blocked label and a comment mentioning Ryan |
| [0022](0022-desktop-app.md) | The desktop app is Electron, React, and TypeScript in `apps/desktop/`, built with Vite+ and pnpm and laid out like T3 Code; its main process runs `wispd attach` locally or over `ssh` and speaks 0007's JSON-RPC, the sandboxed renderer uses a typed preload bridge, and protocol types are generated into `apps/desktop/src/protocol/generated/` |
| [0023](0023-cross-platform.md) | wisp supports macOS, Linux, and Windows, with a per-OS data folder, local transport (a socket, or a per-user named pipe on Windows), service (LaunchAgent, systemd user unit, logon task), secret store, and watcher; native Windows refuses Claude workers, which run in WSL2; PR CI tests macOS arm64, Linux x64, and Windows x64, and releases add Linux and Windows arm64 |
| [0024](0024-coordinator-chat.md) | A project's coordinator chat is a no-write run in a detached worktree of the project's repository that wispd moves to `HEAD` before each CLI process (RYA-171), started by `project/start` and driven through `agent/*`; wispd checks that worktree after every turn and stops the run on a change; a new start replaces a project's coordinator unless it is running, and the coordinator never sees its own run in its tools |
| [0025](0025-coordinator-wake-ups.md) | Runs a coordinator started wake it when they finish: summaries batch into one turn 2 s after the first, or after a turn in progress; 10 wake-ups in a row without the user pause them with `agent.wakeupsPaused`; wake-up turns carry `TurnStarted.wake`; the count and a pause are stored, and when wispd starts each coordinator gets one wake-up for the runs it started that ended after its last turn (RYA-178) |
| [0026](0026-prompt-images.md) | Images sent with a prompt or message are checked against caps sized to Anthropic's limit and 0007's frame, stored in the store's `images` table once the CLI has them, listed by id on the message's `turnStarted`, and served by `agent/image`; Claude gets base64 image blocks, Codex `--image=` temp files |
| [0027](0027-claude-permission-modes.md) | Every Claude thread offers Claude Code's permission modes (Auto, Manual, Accept Edits, Plan, Bypass Permissions); the coordinator is full Claude Code in its mode, in the project's repository, with wispd's tools allowed and no per-turn check; a subagent inherits the coordinator's current mode; a worker in Bypass Permissions runs without the worker sandbox |
| [0028](0028-release-channels.md) | `release.yml` publishes a nightly prerelease (`nightly-<date>-<sha7>`) per push to `develop` and a standard Latest release (`release-<date>-<sha7>`) per push to `main`, with generated notes; the app follows a channel by branch until an updater (RYA-68) reads the releases by prerelease flag; RYA-64 replaces the tags with versions; nightlies aren't pruned |

Numbers are assigned in order. Take the next free number when you start the record, add a row to this table in the same PR, and link the record from its issue.

## Template

```markdown
# NNNN: Title

- Status: accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Issue: RYA-n

## Context

What forces the decision.

## Decision

What we will do.

## Consequences

What becomes easier, what becomes harder, and what follows from it.
```
