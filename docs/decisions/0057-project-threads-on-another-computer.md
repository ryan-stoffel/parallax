# 0057: A Project's threads can run on another computer

- Status: accepted; builds on [0042](0042-project-children-are-threads.md), [0045](0045-integration-branch.md), and [0056](0056-parallax-connect.md)
- Date: 2026-10-06
- Issue: PLX-604

## Context

A Project lives on one plxd: its repository path, context, memory, coordinator, integration branch, and landing queue. Every child its coordinator starts (`thread_launch`, or the user's message through the coordinator) runs on that same plxd, through `agent/start` or `thread/start` with `project`. Ryan wants to pick, at any time, which of his computers those children run on. The Project stays where it is. Moving a Project is out of scope. The chosen computer needs the same repository.

What the code has today:

- No remote children. No run has a computer other than the host that stores it, and nothing in `plxd` connects to another plxd.
- plxd's only client of a plxd is `mcp::Plxd` in `daemon/src/mcp.rs`. It speaks 0007 over `transport::Stream` (the local socket), keeps one connection, matches concurrent calls by id, reconnects, and reads capabilities again after a reconnect. `plxd mcp` is its only user.
- Parallax Connect (0056) already lets one plxd accept 0007 connections on TCP 7340 from the user's own untagged tailnet nodes, checked with `tailscale whois`. `connect/devices` lists those nodes, and `main.rs`'s `dial` and the probe in `methods/connect.rs` already open that TCP connection.
- A provider account, its CLI sign-in, usage limits, worktrees, the sandbox, and approvals all belong to one plxd. A child on another computer has to use that computer's.
- `Repo` has no remote URL. `worktree/folder.rs` reads `origin` for push and PR code.
- Landing (0045) merges a child's branch from the home repository with `git merge-tree`, and the checks run in the home integration worktree.

## Decision

### 1. The setting

- `Project.computer`, a string: the Tailscale node ID of a device in the home plxd's `connect/devices` (0056). Absent means the home plxd. It is a Project setting, behind a `projectComputer` capability, set with `project/update { computer }`. An empty string clears it, as `checks` does.
- `project/update` refuses a node that isn't one of the home plxd's own untagged tailnet nodes, and refuses a repository with no `origin` (see 4). It doesn't check that the device is online, so the user can pick it ahead of time.
- plxd reads it once, where a Project's child is started (`agents`' start path for `agent/start` and `thread/start` with `project`), not in `mcp/thread.rs`. `thread_launch`, the app, and the coordinator's wake-ups all reach that path. The child's run row stores the computer it started on (`AgentRun.computer`), so a later change never moves it.
- Changing it affects only children started afterward. A running child, and one waiting in 0046's queue that hasn't started, keep the computer they have. A waiting child reads the setting when it starts.
- **The app.** The composer footer in `ProjectChat.tsx` is `CheckoutLabel`, a label. It becomes a menu button, `{computer} · Local checkout`. The coordinator's checkout is on the home plxd, so the button changes only where children run, and its tooltip says so. The menu is the Computer group of `RunTargetMenu`, taken out as a component `RunTargetMenu` and the Project footer both use. Its options come from the home plxd's own `connect/devices` (not the app's host list), so they're right when the Project's home is itself an SSH host or another device. The home entry reads "{name}, where the Project is". Names and icons are 0056's `deviceName` and `deviceIcon`. A device that doesn't answer shows "offline" and can still be picked. A plxd without `projectComputer`, or one with no tailnet devices, shows today's label.

### 2. How the home plxd reaches the other one

The home plxd dials the device itself, with no app involved, because children start, wake the coordinator, and finish while the app is closed. An app-mediated relay can't do that, and 0007 only attaches an app sometimes.

- Move `mcp::Plxd` into `daemon/src/peer.rs`, generic over how it opens a connection (`Fn() -> Stream`), with `plxd mcp` passing the socket as now. Add one more opener: a TCP connection to the device's Tailscale IPv4 on 7340, looked up from `tailscale status` each time it connects, so a changed address is followed. This is the only new transport.
- Auth is 0056's, unchanged: the device runs `tailscale whois` on the home node and admits it as the same user, untagged. There is no token. The device needs `connect` on, which Add computer already sets. The home plxd needs nothing new, since it only dials out.
- The home plxd checks the device's capabilities after connecting. One without the methods below fails the launch with "Update Parallax on {name}."
- SSH hosts aren't included. Their connector would be `ssh <destination> plxd attach` through the same `Plxd`, but the destination list is in the app, and plxd's background process may have no key or agent for a non-interactive ssh.

### 3. What a remote child is, and the coordinator's tools

The device runs the child as an ordinary thread, because only it has the repository checkout, the accounts, and the sandbox. The home plxd keeps a run row for it, with the same run id on both, and answers for it.

- **Start.** The home plxd builds the first message exactly as for a local child (header, brief, memory index, task) and sends `thread/start` to the device with that run id, the matched repo entry (4), `base` (5), `permission` set to the Project's mode, `approvals` on, and the same `model` and `effort`. `backend` picks a kind. `account` is refused for a remote child, since account ids belong to the home plxd. The device routes the run on its own default account, so 0046's reserve and quota rules don't apply to it. A remote child counts toward `maxChildren`.
- **Status and the wake-up.** A watcher on the home plxd keeps one `Plxd` to each device with a child that hasn't ended. It repeats `agent/wait` and copies the run's status, outcome, last message, branch, and title into the home row. When a turn ends it calls the same `wake::notify` a local child does, so the coordinator wakes the same way. A restart rebuilds watchers from the store, as `wake::catch_up` does. A device that stops answering keeps its children's last status. The watcher retries every 10 s and each tool says "{name} is offline" until it answers. Nothing marks the child failed.
- **Tools.** The coordinator's tools still call the home plxd. For a run with `computer`, the home plxd forwards `agent/events`, `agent/send`, `agent/cancel`, `agent/wait`, and `agent/approve` to the device with the same run id. So `thread_read`, `thread_send`, `thread_wait`, and `thread_interrupt` keep their shape. `thread_list` and `agent/list` return the home row, with a `computer` field the tools print. `thread_launch` returns the row once the device has started it. Its error is the device's reason: offline, no repository, an old plxd. It never falls back to the home plxd.
- **Transcript.** The device holds the events. The home plxd forwards reads and doesn't copy them into its own log. The app opens a remote child on its own connection to that device, which it keeps for every Connect device the user turned on (0056), as it opens any thread there. The Project's side panel row opens it that way. Without a connection, the row shows its status and "Open {name} to read it."
- **Approvals.** An Auto-mode request the classifier won't decide goes to the device's inbox. The user answers it where the app shows that device's Needs you. 0031's 30-minute limit still denies it. The coordinator can't answer it.
- **`ask` and memory.** A remote child has the device's own thread tools and no `ask`, `memory_read`, or `memory_propose`. A child never waits on a question (0042), so it goes on with what it assumed. Giving it Project tools means a `plxd mcp` on the device bound to the home plxd, which needs the home plxd's `connect` on. That is a separate step (PR 7).

### 4. Finding the repository

- The home plxd reads the Project repository's `origin` URL and normalizes it to `host/path`: drop the scheme, user info, `.git`, and a trailing slash, lowercase the host, and turn `git@host:org/repo` into `host/org/repo`. `worktree/pull_request.rs` already drops user info.
- A new device method, `repo/match { origin }`, normalizes the `origin` of each repo entry on that plxd and returns the one that matches. Two matches go to the oldest entry. plxd can't register a repository on the device, because it doesn't know a path there, so the repository has to be added there already.
- No match: the launch fails with "{name} has no repository for github.com/org/repo. Clone it there and add it in Parallax." No `origin` on the home repository: `project/update` refuses `computer` with "This repository has no origin, so another computer can't find it."

### 5. Getting commits across, for landing

Git objects cross as bundles over the same connection, so no credentials, no `origin` branches, and no SSH are needed. Two device methods, behind a `peerGit` capability:

- `git/receive { repo, ref, bundle }`: the device runs `git fetch origin` (its own credentials, no prompt), checks that the bundle's prerequisites are present, and fetches the bundle into a local branch `parallax-sync/<project short id>`.
- `git/bundle { repo, branch, since, offset }`: the device returns `git bundle create - <since>..<branch>` as base64 chunks of at most 1 MiB, with the total size. The home plxd refuses over 64 MiB.

The flow:

- **Start.** If the integration branch's tip is the base branch's tip, nothing has landed and the device cuts the worktree from `origin/<base>` after its fetch. Otherwise the home plxd sends `git/receive` with `<base>..<integration>` as the bundle and the device cuts from `parallax-sync/<project>`. So a child still sees what landed before it. A device whose fetch doesn't contain the base commit fails with "{name} is behind origin. Pull in the repository there."
- **Land.** `land/queue` for a remote child first calls `git/bundle` with `since` set to the integration tip it was cut from, and fetches the result into `refs/parallax/remote/<run id>` of the home repository. Landing then merges that ref instead of the child's local branch, with no other change: `merge-tree`, the squash commit, and the checks all run on the home plxd, as 0045 says.
- **Conflict.** For a remote child plxd doesn't run `git merge --no-commit` in its worktree, since that worktree is on the device. It sends `git/receive` with the new tip, then tells the child to run `git merge parallax-sync/<project>` and resolve. This departs from 0045's "the child never runs git" and applies only to remote children. A second conflict goes to Needs you, as before.
- **Red checks.** The same send-back message with the output. The checks run on the home plxd with its tools. A suite that needs the device's hardware isn't supported.
- **Diff review.** The Deliverable panel's per-child diff for a remote child comes from the device connection until the child is queued. The combined diff is the home integration branch's and works as before.

### 6. Out of scope

- Moving a Project, or its coordinator, to another computer.
- More than one computer at a time for one Project. It's one setting.
- Copying a remote child's transcript into the home plxd's log.
- A remote child's `ask` and memory tools, until PR 7.
- SSH hosts that aren't Connect devices.
- Running a landing's checks on the device.
- Cloning the repository on the device, or choosing a device that has the repository at another path with a different `origin`.
- Applying 0046's account placement to the device's accounts.
- Starting on another computer when the chosen one is offline.

### PRs

Each PR lands on its own, in order. Every Rust PR runs the existing CI jobs, and each has the tests named.

1. **`refactor(daemon): plxd client usable for another plxd`.** Move `mcp::Plxd` to `daemon/src/peer.rs`, generic over its connector. Add the tailnet TCP connector, and a node lookup by ID in `tailnet.rs`. No behavior change. Files: `daemon/src/mcp.rs`, `daemon/src/peer.rs`, `daemon/src/lib.rs`, `daemon/src/tailnet.rs`, `daemon/src/mcp/*.rs` imports. Tests: `mcp`'s existing client tests move with it, and one new test connects two in-process daemons over loopback with a fake `Tailnet` and checks that an untagged peer gets served and a refused one doesn't.
2. **`feat(daemon): choose a computer for a Project (PLX-604)`.** `Project.computer`, `ProjectUpdateParams.computer`, the `projectComputer` capability, the store column, validation against `connect/devices`, `repo/match`, and the origin normalization. Nothing starts anywhere else yet. Files: `crates/parallax-protocol/src/{project,thread}.rs` and the generated types, `crates/parallax-store`, `daemon/src/methods/project.rs`, `daemon/src/methods/thread.rs` (where `repo/*` lives), `daemon/src/worktree/folder.rs`. Tests: normalization cases (ssh, https, user info, `.git`), `project/update` set, clear, and refusal, `repo/match` on two repos, and the store round trip.
3. **`feat(daemon): git bundles between plxd's (PLX-604)`.** `git/receive` and `git/bundle` on the device side, and the home-side helpers that call them. Not wired to any start path. Files: `daemon/src/worktree/bundle.rs`, `daemon/src/methods/git.rs`, `crates/parallax-protocol/src/git.rs`. Tests: two temp repositories, a bundle each way, a missing prerequisite, an oversized bundle, and chunk boundaries.
4. **`feat(daemon): start a Project's child on its computer (PLX-604)`.** `AgentRun.computer`, the start path reading the setting, `thread/start` over `peer`, the watcher with `wake::notify` and restart catch-up, and the forwards. It uses PR 3 for the starting point. Files: `daemon/src/agents/{mod,remote,wake}.rs`, `daemon/src/methods/agent.rs`, `daemon/src/mcp/thread.rs` (printing `computer`), the protocol and the store. Tests: two in-process daemons with the fake backend: launch, `thread_read`, `thread_send`, `thread_wait`, the coordinator waking when the child ends, the offline error, the missing-repository error, a plxd restart mid-run, and no change to a running child when the setting changes.
5. **`feat(daemon): land a remote child (PLX-604)`.** Bundle up on `land/queue`, merge from `refs/parallax/remote/<run id>`, and the send-back with the new tip. Files: `daemon/src/methods/land.rs`, `daemon/src/worktree/landing.rs`, `daemon/src/agents/remote.rs`. Tests: a clean landing, a conflict that sends the child the merge message, red checks, and a landing queued while the device is offline, which waits and retries.
6. **`feat(app): choose the computer a Project's threads run on (PLX-604)`.** The composer footer menu, the Computer group taken out of `RunTargetMenu`, the home plxd's `connect/devices` as its source, the remote child's row opening on its device connection, and the offline state. Files: `apps/desktop/src/renderer/{ProjectChat,RunTargetMenu,AgentChat,ProjectAgents}.tsx`, a small `ComputerMenu.tsx`, and their tests, plus an e2e test against two plxd's. Tests: pick, change, and clear the setting, the menu on a plxd without the capability, and a remote child's row.
7. **`feat(daemon): Project tools for a remote child (PLX-604)`, optional.** `ask` and memory for a remote child, with its tool server bound to the home plxd. Needs the home plxd's `connect` on, and a `thread/start` option naming the home address. Decide after PR 5.

## Ryan's answers (2026-10-06)

1. SSH hosts: Connect devices only for now. SSH hosts stay out of scope.
2. Code transfer: git bundles over the plxd connection, not pushed branches.
3. A remote child's approvals wait in the device's inbox, and it has no `ask` or memory until PR 7. That is fine for the first release.
4. The app reads a remote child over its own connection to the device. Its transcript isn't copied to the home plxd.
5. A launch to an offline device fails and the coordinator hears why. It never falls back to the home plxd.
6. A remote child uses the device's default account. There is no Project account setting.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| The app relays between the two plxd's | Wake-ups, landing, and `thread_launch` run in plxd with the app closed, and 0007 attaches an app only sometimes. |
| The home plxd runs the vendor CLI over ssh in a remote worktree | The worktree, sandbox, account, approvals, and MCP socket are all local paths and local credentials, so each would need a remote version. A remote plxd already has all of them. |
| A shadow Project on the device, with `agent/start` there | The device would need a coordinator for wake-ups, `ask`, and memory, which is a half-copy of the Project. |
| Mirroring every remote event into the home log | The app and the tools would work unchanged, but it means a second path for each event type, a catch-up after every disconnect, and double the storage. Forwarding reads covers the coordinator's needs. |
| Pushing branches to `origin` for sync | It puts `parallax/...` branches on GitHub for every remote child and needs push rights on the device. 0045 says only the user pushes. |

## Consequences

- Children can use a more powerful computer, and Projects keep their one coordinator, memory, inbox, and landing queue.
- plxd gets its first client of another plxd, and Connect's `whois` check becomes the only trust boundary for it, so the Project setting accepts only the user's own untagged nodes.
- A remote child's worktree and transcript live on the device. Deleting the Project or the run must delete them there, through the same peer connection, and fails visibly when the device is offline.
- Landing a remote child costs a bundle transfer, capped at 64 MiB.
- The home plxd and the device need the same repository, and `origin` has to match.
- A child and its watcher outlive the app but not the device: a device that goes away leaves its children at their last status.
