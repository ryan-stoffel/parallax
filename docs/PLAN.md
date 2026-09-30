# Wisp: Project Plan

Updated Sep 28, 2026

Records in [decisions/](decisions/) supersede this plan where they differ. Work is tracked in the [Wisp project in Linear](https://linear.app/ryanstoffel/project/wisp-459c0ee45806) ([0021](decisions/0021-linear-work-record.md)).

## Overview

An open-source desktop app that reproduces the Cursor Projects workflow on machines you own. A project is one coordinator chat: it plans the work and delegates it to subagents that share project context.

The reference architecture is Cursor's [Introducing Projects](https://cursor.com/blog/projects) (Sep 10, 2026). The differences: the host is any machine you own, local or over SSH, and agents run through your own AI subscriptions, managed inside the app.

## Goals and non-goals

Goals:

* Run projects on this computer or any machine reachable over SSH
* Run agents through your own subscriptions, using each vendor's official CLI, with API keys as a fallback ([0004](decisions/0004-subscription-providers.md))
* The app and `wispd` on macOS, Windows, and Linux ([0023](decisions/0023-cross-platform.md))
* Good performance

Non-goals:

* A hosted cloud service
* An editor. The Code - OSS fork was dropped ([0020](decisions/0020-drop-the-editor-fork.md)).
* Slack triggers

## Core concepts

| Concept | What it is | Cursor equivalent |
| --- | --- | --- |
| Project | A body of work that outlives one chat: a feature, a migration, or ongoing upkeep. It is one coordinator chat. | Project |
| Coordinator | The project's chat. It plans and delegates but never writes code, so it is never blocked. | Coordinator Agent |
| Subagent | A worker that runs one task in its own git worktree on the project's host | Subagent |
| Thread | A single agent chat in a repository, or in none, with no coordinator ([0017](decisions/0017-normal-threads.md)) | Agent chat |
| Shared context | A folder of Markdown files that `wispd` owns and mirrors to other machines. Agents add research, test instructions, and your preferences ([0005](decisions/0005-shared-context-folder.md)). | Shared context |
| Host | A machine running `wispd`: this computer, or one reached over SSH, such as a Mac mini | Cloud computer |
| Local agent | A subagent on your laptop, started by a coordinator on another host when something must run there | Local agent |
| Trigger | A schedule or a PR watch that wakes the coordinator | Subscription |

Cursor calls triggers subscriptions. This plan says triggers to avoid confusion with AI subscriptions.

## Architecture

Two programs: the desktop app, and `wispd`, a Rust daemon that does everything else. With an external host, closing the laptop does not stop a project.

```mermaid
flowchart LR
  A[Desktop app<br/>Electron] -- "wispd attach<br/>local or ssh" --> H[wispd on host<br/>coordinator, runs, state]
  T[Triggers] --> H
  H --> W[Subagents and threads<br/>vendor CLIs in worktrees]
  W <--> S[(Shared context)]
```

* Desktop app ([0022](decisions/0022-desktop-app.md)): Electron, React, and TypeScript in `apps/desktop/`, laid out like T3 Code. A sidebar of projects and threads, the chat, and a side panel for diffs and review. Its main process runs `wispd attach`, locally or over the user's `ssh`, and speaks JSON-RPC to it ([0007](decisions/0007-editor-wispd-protocol.md), [0010](decisions/0010-wispd-attach.md)).
* Host daemon (`wispd`): one per user per host. It runs the coordinator, whose tools are `wispd mcp` ([0019](decisions/0019-coordinator-mcp-tools.md)) on top of Claude Code's own configuration, in the permission mode you pick ([0027](decisions/0027-claude-permission-modes.md)), and agent runs, each a vendor CLI in its own worktree and sandbox ([0013](decisions/0013-worker-sandbox.md), [0014](decisions/0014-agent-runs.md)). It stores project state and the event log in SQLite, owns shared context, and listens for triggers.
* Subscriptions: `wispd` never handles consumer credentials. You sign in to each vendor's CLI on the host, and `wispd` routes each run to an account ([0004](decisions/0004-subscription-providers.md), [0012](decisions/0012-account-routing.md)).

## MVP and milestones

The MVP is one project on one host: a coordinator, two parallel subagents, shared context files, and diffs reviewable from the app.

| Milestone | Done when |
| --- | --- |
| [M0: Foundations](https://linear.app/ryanstoffel/issue/RYA-74) | The repo holds the desktop app and `wispd`, CI checks both on macOS, Windows, and Linux, and the decision records for Linear and cross-platform support are in |
| [M1: App shell](https://linear.app/ryanstoffel/issue/RYA-75) | The Electron app launches on all three OSes, talks to a local `wispd`, and runs threads |
| [M2: Hosts](https://linear.app/ryanstoffel/issue/RYA-76) | You add a local or SSH host from the app and connect to `wispd` on it. The daemon runs on macOS, Windows, and Linux. |
| [M3: Subscriptions](https://linear.app/ryanstoffel/issue/RYA-77) | You sign in with your own subscriptions, with API keys as a fallback. Runs route through them and usage shows per account. |
| [M4: Projects](https://linear.app/ryanstoffel/issue/RYA-78) | You describe a project once, and the coordinator plans it and runs parallel subagents in their own worktrees on a host. On an external host it keeps working with the laptop closed. |
| [M5: Review](https://linear.app/ryanstoffel/issue/RYA-79) | You review each task's diff in the app and turn accepted work into commits or PRs |
| [M6: Local agent + triggers](https://linear.app/ryanstoffel/issue/RYA-80) | With an external host, the coordinator starts a subagent on the laptop. Schedules and PR watches wake the coordinator without a prompt, with notifications. |
| [M7: Release](https://linear.app/ryanstoffel/issue/RYA-81) | Installable builds for macOS, Windows, and Linux, plus README, license, install steps, and a short demo |

Records dated before Sep 27, 2026 use the old numbering: M1 host daemon, M2 subscription manager, M3 single agent, M4 coordinator, M5 local agent, M6 triggers.

## Open questions and risks

Answered:

* The name is Wisp, and the daemon is `wispd`, not shared with Roster ([0003](decisions/0003-naming.md))
* Shared context is a folder `wispd` owns and copies, not git commits ([0005](decisions/0005-shared-context-folder.md))
* Providers: Claude Code first, then Codex, then Cursor once Cursor confirms in writing ([0004](decisions/0004-subscription-providers.md))
* The UI follows T3 Code's layout rather than Cursor's ([0022](decisions/0022-desktop-app.md))
* Triggers: schedules and PR watches first; Slack is out of scope ([RYA-59](https://linear.app/ryanstoffel/issue/RYA-59))

Open:

* How a host's coordinator runs a local agent on the laptop ([RYA-55](https://linear.app/ryanstoffel/issue/RYA-55))
* How triggers wake the coordinator ([RYA-59](https://linear.app/ryanstoffel/issue/RYA-59))
* Whether workers may reach the host's own interface addresses ([RYA-45](https://linear.app/ryanstoffel/issue/RYA-45))
* Versioning, packaging, and signing for three OSes ([RYA-64](https://linear.app/ryanstoffel/issue/RYA-64))
* Name conflict checks before release: the Gleam web framework Wisp, GitHub, domains, trademarks, and package names ([RYA-71](https://linear.app/ryanstoffel/issue/RYA-71))

Risks:

* Subscription terms. Running consumer subscriptions from a third-party app may break vendor terms, and a public open-source app makes that more visible. Running only the vendors' own CLIs reduces this, and API keys stay as a fallback ([0004](decisions/0004-subscription-providers.md)).
* Coordinator quality. Weak task specs make workers fail. Start with the strongest model and grade plans by hand.
* Three OSes. Each has its own transport, service, secret store, and sandbox, and native Windows can't sandbox Claude workers, which run in WSL2 instead ([0023](decisions/0023-cross-platform.md)).
