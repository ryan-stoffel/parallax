# 0057: A Project's threads can run on another computer

- Status: accepted; builds on [0042](0042-project-children-are-threads.md), [0045](0045-integration-branch.md), and [0056](0056-parallax-connect.md), and supersedes in part [0046](0046-project-scheduler.md)'s Hosts section (the transport, how a branch moves, and which account a worker host uses) and 0042's `ask` and memory tools for a child on another computer, until PR 8
- Date: 2026-10-06
- Issue: PLX-604

## Context

A Project lives on one plxd: its repository path, context, memory, coordinator, integration branch, and landing queue. Every child its coordinator starts (`thread_launch`, or the user's message through the coordinator) runs on that same plxd, through `agent/start` or `thread/start` with `project`. Ryan wants to pick, at any time, which of his computers those children run on. The Project stays where it is. Moving a Project is out of scope. The chosen computer needs the same repository.

Ryan settled the open points on 2026-10-06:

- Connect devices only for now. SSH hosts stay out of scope.
- Git objects move as bundles over the plxd connection, not as branches pushed to `origin`.
- A remote child's approvals wait in the device's own inbox, and it has no `ask` or memory tools until PR 8.
- The app reads a remote child over its own connection to the device. Its transcript isn't copied to the home plxd.
- A launch to an offline device fails and the coordinator hears why. It never falls back to the home plxd.
- A remote child uses the device's default account, with no Project setting for it.

What the code has today:

- No remote children. No run has a computer other than the host that stores it, and nothing in plxd connects to another plxd.
- plxd's only client of a plxd is `mcp::Plxd` in `daemon/src/mcp.rs`. It speaks 0007 over `transport::Stream`, which is a `UnixStream` on Unix and a named pipe client on Windows. It keeps one connection, matches concurrent calls by id, reconnects, and reads capabilities again after a reconnect. It ignores notifications, which `plxd mcp` never subscribes to. `plxd mcp` is its only user.
- Parallax Connect (0056) lets one plxd accept 0007 connections on TCP 7340 from the user's own untagged tailnet nodes, checked with `tailscale whois`, with at most 2 pending checks per peer address. `connect/devices` lists those nodes, and `main.rs`'s `dial` and the probe in `methods/connect.rs` already open that TCP connection.
- A provider account, its CLI sign-in, usage limits, worktrees, the sandbox, and approvals all belong to one plxd. 0012's automatic API-key fallback applies to a plain thread, and 0046 turns it off for a Project's child through the Project's `allowApiKeys`.
- `agent/wait` returns at once for a run that isn't starting or running, and reads the home log. The actor calls `wake::notify` once per CLI process and `land::turn_ended` when a turn ends. `agents::recover` marks every `starting` or `running` row `interrupted` when plxd starts. `wake::catch_up` rebuilds from row timestamps, with no per-run cursor.
- `child_header` tells a child it has `read_context`, `write_context`, `ask`, `memory_read`, and `memory_propose`, and adds the memory index. `thread/start`'s `threads` attachments are rendered from the target plxd's store (0047).
- A frame is at most 8 MiB (`MAX_FRAME_BYTES`), and 0007's limits apply to the whole connection.
- `Repo` has no remote URL. `worktree/folder.rs` reads `origin` for push and PR code.
- Landing (0045) takes the child's worktree row (`land::child` fails with "a landing child has no worktree" without one), merges its branch from the home repository with `git merge-tree`, and runs the checks in the home integration worktree. It moves a failing item to Needs you so one item can't stall the serial queue. `WorktreeManager::start_merge` starts the conflict merge in a child's worktree.
- `coordinator.md` has the coordinator review a child with `git diff` in the worktree `thread_list` prints.

## Decision

### 1. The setting

- `Project.computer`, a string: the Tailscale node ID of a device in the home plxd's `connect/devices` (0056). Absent means the home plxd. It is a Project setting set with `project/update { computer }`, where an empty string clears it, as `checks` does.
- `project/update` accepts it only for a node the device filter (2) admits, and only for a repository with an `origin` (4). It doesn't check that the device is online, so the user can pick it ahead of time. Until PR 6 turns the `projectComputer` capability on, `project/update` refuses `computer` with `unsupportedOption`, so no build accepts a setting it doesn't follow.
- plxd reads it once, where a Project's child is started (`agents`' start path for `agent/start` and `thread/start` with `project`), not in `mcp/thread.rs`. `thread_launch`, the app, and the coordinator's wake-ups all reach that path. The child's run row stores the computer it started on (`AgentRun.computer`), so a later change never moves it.
- Changing it affects only children started afterward. A running child keeps its computer. A child waiting in 0046's queue reads the setting when it starts.
- **The app.** The composer footer in `ProjectChat.tsx` is `CheckoutLabel`, a label. It becomes a menu button, `{computer} · Local checkout`. The coordinator's checkout is on the home plxd, so the button changes only where children run, and its tooltip says so. The menu is the Computer group of `RunTargetMenu`, taken out as a component both use. Its options come from the home plxd's own `connect/devices` (not the app's host list), so they're right when the Project's home is itself an SSH host or another device. The home entry reads "{name}, where the Project is". Names and icons are 0056's `deviceName` and `deviceIcon`. A device that doesn't answer shows "offline" and can still be picked. A plxd without `projectComputer`, or one with no tailnet devices, shows today's label.

### 2. How the home plxd reaches the other one

The home plxd dials the device itself, with no app involved, because children start, wake the coordinator, and finish while the app is closed. An app relay can't do that, and 0007 attaches an app only sometimes.

- **The client.** Move `mcp::Plxd` into `daemon/src/peer.rs`. It opens connections through a connector that returns a boxed `AsyncRead + AsyncWrite + Send + Unpin`, so the local socket, a Windows pipe, and a `TcpStream` all fit, and `Connection` holds the halves of that box. `plxd mcp` passes the socket connector as now. The one new connector is a TCP connection to the device's Tailscale IPv4 on 7340. The cost of the box is one virtual call per read or write.
- **Notifications.** `Plxd` hands `events/event` notifications to a channel the caller passes in. After a reconnect the channel yields a `Reconnected` marker, so the caller knows to subscribe again from its cursor.
- **Staying open.** The device closes a connection that sends nothing for 90 s, and `Plxd` stops using one it hasn't written to for 75 s, which would drop a connection that only receives events. The peer client sends `host/health` every 30 s on each connection, as 0007 does for an app, and a connection with a live subscription is exempt from the 75 s drop.
- **One client per device.** The daemon keeps one `Plxd` per device, shared by the watcher, the forwards, the start, and the bundles. 0056 caps pending `whois` checks at 2 per peer address, and several clients reconnecting at once would be closed. Its `ClientInfo` is `{ name: "plxd", version, machineId: <this node's ID> }`, so the device's log names the peer.
- **The device filter, on every dial.** Before each connect, the daemon reads `tailscale status` and checks that the node is a peer of this node's own user, untagged, and that this node is untagged (0056's rule, one function that `project/update` also calls). A node that fails it, because it was re-tagged or shared out after the setting was made, gets no connection and the cached client is closed.
- **Auth.** Auth is 0056's, unchanged: the device runs `tailscale whois` on the home node and admits it as the same user, untagged. There is no token. The device needs `connect` on, which Add computer already sets. The home plxd needs nothing new, since it only dials out.
- **Version.** After connecting, the home plxd checks the device's capabilities and requires every one a remote start depends on: `peerGit` (the `bundle/*` methods and `git/startMerge`), `peerStart` (`thread/start`'s `allowApiKeys` and commit-id `base`, both options an older plxd would ignore, which would let its API-key fallback run and start the worktree from `HEAD`), `repoRefs`, and `agentWait`. A device missing any fails the launch with "Update Parallax on {name}." Each capability is advertised in the PR that adds what it names.
- SSH hosts aren't included. Their connector would be `ssh <destination> plxd attach`, but the destination list is in the app, and plxd's background process may have no key for a non-interactive ssh.

### 3. What a remote child is, and the coordinator's tools

The device runs the child as an ordinary thread, because only it has the repository checkout, the accounts, and the sandbox. The home plxd keeps a run row with the same run id on both, mirrors its state, and answers for it.

**Start.**

- The home plxd creates the run row first (status `starting`, `computer` set, flagged `startUnknown`), then sends `thread/start` to the device. The row stores what a retry needs: the device's repo entry id and the base commit.
- **A refused launch leaves no row.** Any definite refusal, such as offline, no repository, an old plxd, a bundle over the cap, or an error answer from `thread/start`, deletes the row before the error goes back to the coordinator, so the row never counts toward `maxChildren` and nothing starts the child later. When `thread/start` answers, the flag clears.
- **Only a crash leaves the flag.** If plxd stops, or the connection drops after `thread/start` was sent, the flagged row stays. `thread/start` is idempotent on the run id, so the watcher asks the device for the run. If it has it, the flag clears. If not, the watcher redoes the start bundle from the stored repo entry and base commit and sends `thread/start` again. A flagged row the device can't be reached for in 10 minutes is deleted, and the coordinator hears that the launch failed.
- `thread/start` carries the device's repo entry (4), `base` (5), `permission` set to the Project's mode, `approvals` on, the same `model` and `effort`, and `allowApiKeys` from the Project's setting. A new `allowApiKeys` option on `thread/start` (absent means true) makes the device's routing refuse an API-key account and its automatic fallback, by the rule `placement::api_keys` applies when `prepare_run` starts a Project's child. So a rate-limited remote child waits as a local one does and never spends the device's API key unasked.
- `backend` picks a kind. `account` is refused for a remote child, since account ids belong to the home plxd. The device routes the run on its own default account, so 0046's reserve and quota rules don't apply to it. A remote child counts toward `maxChildren`.
- **The first message** is a remote header, not `child_header`. It names the Project, lists the device's thread tools only (no `read_context`, `write_context`, `ask`, or memory tools), and has no memory index. It tells the child that a thread it launches, forks, or sends to on the device is a plain device thread the coordinator never sees, so it shouldn't start any. The brief and the task follow as before.
- **Attachments.** `threads` on a remote child's launch is refused with "threads can't be attached to a child on another computer", because the device would render them from its own store and fail with `runNotFound`.

**Following it.** A watcher on the home plxd keeps the home row current and gives the coordinator its wake-ups.

- Each remote row stores a cursor: the device's `logId` and the last `seq` applied. One `events/subscribe` per device and repo entry (`project` set to the device's repo entry) starts at the lowest cursor of its live rows, and each event applies only to a row whose cursor is below its `seq`. On `resyncRequired` or a changed `logId`, the watcher rebuilds each live row from `agent/list` and `agent/events`, as an app does.
- It mirrors state, not transcript. For each device `agent.updated` and `agent.finished` it appends the matching event to the home log with the home row updated (status, outcome, last message, title, branch), so the home `agent/wait`, `thread_wait`, `thread_list`, and the app see the change. It never appends `agent.output`, so answer 4 stands.
- A device `agent.finished` is one turn end, as the actor's is. For each, in order: (a) fetch the child's branch into the home repository (5), (b) append the events, (c) call `wake::notify` and `land::turn_ended`, (d) store the cursor. A crash between (c) and (d) can wake the coordinator twice for one turn. Nothing is lost.
- **A failed fetch** (`bundleTooLarge`, a hash mismatch, or a drop mid-transfer) doesn't stop the turn end: (b) to (d) still run, so the coordinator is woken about the finished child. The wake summary carries the reason, and the row is marked `fetchFailed` with it. `land/queue` refuses a marked row with that reason, after trying the fetch once more. The next turn end also retries it, and a fetch that succeeds clears the mark.
- `recover` skips rows with `computer`, so a restart of the home plxd no longer interrupts a child still running on the device or wakes the coordinator with a false outcome. The watcher sets each row's status from the device once it connects.
- A device that stops answering keeps its children's last status. The watcher retries every 10 s, and each forwarded call says "{name} is offline" until it answers. Nothing marks the child failed.

**Reviewing and landing.** The coordinator reviews a remote child from the home repository. Step (a) above fetches the child's branch into `refs/parallax/remote/<run id>` at each turn end. `thread_list` prints that ref in place of the worktree path. Before the child's first turn ends the ref doesn't exist, so it prints no path and a note: "branch {name} is on {computer} until its first turn ends". A remote variant of `coordinator.md` tells the coordinator to run `git diff <integration>...refs/parallax/remote/<run id>` in its own worktree. Landing (5) uses the same ref, so it never needs the device online.

**Every tool and method, for a run with `computer`:**

| Call | For a remote row |
| --- | --- |
| `thread_list`, `agent/list`, `thread/list` | Home rows, with `computer`, and the ref in place of the worktree path |
| `thread_read`, `agent/events` | Forwarded to the device. The transcript isn't copied |
| `thread_send`, `agent/send` | Forwarded. The durable queue (0048) is the device's |
| `thread_interrupt`, `agent/cancel` | Forwarded |
| `thread_wait`, `agent/wait` | The home plxd's own, from the mirrored state. Not forwarded, so a mix of local and remote `runIds` works |
| `thread_update`, `thread/update` | Forwarded, then the home row takes the new title |
| `agent/diff`, `agent/git` | Forwarded, since the device has the live worktree |
| `thread/delete`, `thread/archive` | Forwarded, then the home row and its ref go. Refused with "{name} is offline" while the device can't be reached, unless `deleteAnyway` |
| `agent/approve` | Refused with "Answer it on {name}": the request is in the device's inbox, not the home plxd's |
| `thread_fork`, `thread/fork` | Refused: forking a child on another computer isn't supported |
| `thread_search` | Home log only, so a remote child's transcript isn't searched. Its title and task are |
| `pr_link`, `pr_unlink`, `agent/openPr` | Refused. The Project ships from its integration branch |
| `thread_launch` | Starts the child on the Project's computer. Its error is the device's reason: offline, no repository, an old plxd. It never falls back to the home plxd |

Deleting a Project deletes its remote children the same way and is refused while a device with one can't be reached. Deleting a run or a Project also removes its `refs/parallax/remote/*` refs. A device that is gone for good would leave a Project undeletable, so `thread/delete` and `project/delete` take `deleteAnyway`: the home plxd drops its rows and refs without the device and says the device keeps its threads and worktrees. The app offers it in the offline error.

**Approvals.** An Auto-mode request the classifier won't decide goes to the device's inbox. The user answers it where the app shows that device's Needs you. 0031's 30-minute limit still denies it. The coordinator can't answer it.

**`ask` and memory.** A remote child has none until PR 8. A child never waits on a question (0042), so it goes on with what it assumed. PR 8 binds a `plxd mcp` on the device to the home plxd, which needs the home plxd's `connect` on.

### 4. Finding the repository

- The home plxd reads the Project repository's `origin` URL and normalizes it to `host/path`: drop the scheme, user info, `.git`, and a trailing slash, lowercase the host, and turn `git@host:org/repo` into `host/org/repo`. `worktree/pull_request.rs` already drops user info.
- A new device method, `repo/match { origin }`, normalizes the `origin` of each repo entry on that plxd and returns the one that matches. Two matches go to the oldest entry. plxd can't register a repository on the device, because it doesn't know a path there, so the repository has to be added there already.
- No match: the launch fails with "{name} has no repository for github.com/org/repo. Clone it there and add it in Parallax." No `origin` on the home repository: `project/update` refuses `computer` with "This repository has no origin, so another computer can't find it."

### 5. Getting commits across

Git objects cross as bundles over the same connection, so no credentials, no `origin` branches, and no SSH are needed. A frame is at most 8 MiB, so a bundle never travels in one request. Both directions use a bundle file on disk, 1 MiB chunks, a 64 MiB cap, and a SHA-256 the receiver checks. The device methods, behind a `peerGit` capability:

- **Device to home:** `bundle/prepare { run, exclude }` creates the bundle once, in a temp file in the device's data folder, from the run's own branch (the device reads it from the run, so a peer can't ask for any other branch or repository) pinned to the tip at that moment, with `exclude` as object ids. It returns `{ id, tip, size, sha256 }`, or `bundleTooLarge` over the cap. `bundle/read { id, offset, length }` serves a chunk of the file as base64, and `bundle/drop { id }` removes it. An unread bundle expires after 10 minutes.
- **Home to device:** `bundle/begin { run, size, sha256 }` opens a file, `bundle/write { id, offset, data }` appends a chunk, and `bundle/apply { id, tip }` checks the hash and `git bundle verify`, fetches the bundle's one ref into `parallax-sync/<run id>` (a ref per run, so another child's start can't move it), and checks that it equals `tip`.
- **Validation.** Only a UUID run id and hex object ids come from the peer, and the device builds every ref name and argument itself, so nothing starts with `-` or names another ref. `bundle/apply` writes only `parallax-sync/*`.

The flows:

- **Start.** One path for every Project. The home plxd bundles `<integration tip> --not --remotes=origin`. When that is empty, nothing is sent and the device cuts the worktree from the integration tip's commit, which `origin` has. Otherwise the device runs `git fetch origin` (its own credentials, no prompt), applies the bundle, and cuts from `parallax-sync/<run id>`, so a child sees what landed before it and a local base ahead of `origin` works too. `thread/start`'s `base` takes the commit id (PR 4 adds that form if it takes only branch names). A device that lacks a commit the bundle needs fails with "{name} is missing commits the Project needs. Fetch the repository there."
- **Each turn end.** The watcher calls `bundle/prepare` with `exclude` set to three kinds of commit: the integration tip the child was cut from, the last tip it received from the device, and every integration or squash tip the home plxd has sent the device for this run (the row keeps them). The child's branch contains the last kind after a send-back, so leaving them out keeps the bundle to the child's own commits. It reads the chunks, checks the hash, and fetches the result into `refs/parallax/remote/<run id>` in the home repository, and stores the tip as the run's last received tip.
- **Land.** `land/queue` for a remote child merges that ref. It runs `merge-tree`, the squash commit, and the checks on the home plxd, as 0045 says. The remote row stores `branch` as the device's branch name (for the commit body and messages) and a `remoteRef`. It has no worktree row, and `land::child` returns the ref for the steps that read the branch. A failure of any kind moves the item to Needs you, as it does today, and never waits for the device or holds the queue.
- **Conflict.** After a conflict the home plxd sends the new integration tip with `bundle/begin`, `write`, and `apply`, then calls `git/startMerge { run, tip }`. The device runs `start_merge` in the child's worktree, as for a local child, so 0045 stands: the child only resolves files and never runs git. The home row's status is mirrored and can lag, so `git/startMerge` refuses with `runBusy` when the device's own run is starting or running. As for a local child that is working when it conflicts, the item then goes to Needs you. The message to the child names the tip sha, as 0045 does. A resolution's conflict-marker check runs on the ref at the next turn end. A second conflict goes to Needs you, as before. If the device is offline when a send-back is due, the item goes to Needs you with "can't reach {name} to send it back".
- **Red checks.** The same send-back: the home plxd points a temporary ref at the squash commit, bundles it against the last tip the device has, applies it to the device, and the message names its sha. So the child can `git show` it, then fixes and its next turn is queued again as 0045 says.

### 6. Out of scope

- Moving a Project, or its coordinator, to another computer.
- More than one computer at a time for one Project. It's one setting.
- Copying a remote child's transcript into the home plxd's log.
- A remote child's `ask` and memory tools, until PR 8.
- SSH hosts that aren't Connect devices.
- Running a landing's checks on the device.
- Cloning the repository on the device, or choosing a device that has the repository at another path with a different `origin`.
- Applying 0046's account placement, capacity, or reserve to the device's accounts.
- Starting on another computer when the chosen one is offline.
- Opening a PR from a remote child's branch. The Project ships from its integration branch.
- Keeping a remote child from launching plain device threads. Its header tells it not to.

### PRs

Each PR lands on its own, in order. PR 6 turns the `projectComputer` capability on, and PR 7 is the only UI. Until PR 6, `project/update` refuses `computer`, so a build with PRs 1 to 5 starts every child on the home plxd. The tests in PRs 4 and 5 set `computer` in the store directly. Between PRs 4 and 5 a remote child exists with no watcher, which is inert while the capability is off.

1. **`refactor(daemon): plxd client usable for another plxd`.** Move `mcp::Plxd` to `daemon/src/peer.rs` with the boxed connector, the notification channel with its `Reconnected` marker, and a 30 s `host/health` heartbeat with the idle-drop exemption for a subscribed connection. Add the tailnet TCP connector, the device filter as one function, the shared client per device, and `ClientInfo`. No behavior change for `plxd mcp`. Files: `daemon/src/mcp.rs`, `daemon/src/peer.rs`, `daemon/src/lib.rs`, `daemon/src/tailnet.rs`, `daemon/src/mcp/*.rs` imports. Tests: the existing client tests move with it, plus a test that two in-process daemons over loopback with a fake `Tailnet` serve an untagged peer and refuse a tagged one, that the filter runs again on reconnect, that two callers share one connection, that notifications arrive after a reconnect with a `Reconnected` marker before them, and that a subscribed connection that receives nothing stays open past 90 s.
2. **`feat(daemon): store a computer for a Project (PLX-604)`.** `Project.computer`, `ProjectUpdateParams.computer`, the store column, validation with the device filter, `repo/match`, and the origin normalization. The capability stays off, and `project/update` refuses `computer`. Files: `crates/parallax-protocol/src/{project,thread}.rs` and the generated types, `crates/parallax-store`, `daemon/src/methods/project.rs`, `daemon/src/methods/thread.rs` (where `repo/*` lives), `daemon/src/worktree/folder.rs`. Tests: normalization cases (ssh, https, user info, `.git`), the store round trip, `repo/match` on two repos, and `project/update`'s refusals.
3. **`feat(daemon): git bundles between plxds (PLX-604)`.** `bundle/*` and `git/startMerge` on the device, with the home-side helpers, advertising `peerGit`. Not wired to any start path. Files: `daemon/src/worktree/bundle.rs`, `daemon/src/methods/bundle.rs`, `crates/parallax-protocol/src/bundle.rs`. Tests: two temp repositories, a bundle each way, a missing prerequisite, a hash mismatch, an oversized bundle, chunk boundaries, a branch that moves between chunks (the tip stays pinned), argument and ref validation, and `git/startMerge` (its refusal with `runBusy` for a running run, and its start of the merge for an idle one).
4. **`feat(daemon): start a Project's child on its computer (PLX-604)`.** The row created first, `AgentRun.computer`, the start path reading the setting, the remote header, the `threads` refusal, `thread/start`'s `allowApiKeys` and commit `base`, the start bundle, the `startUnknown` flag with the stored repo entry and base commit, the capability check, `deleteAnyway`, the forwards and refusals in the table, remote delete (including a Project's), and `recover` skipping remote rows. It advertises `peerStart` on the device side. Files: `daemon/src/agents/{mod,remote}.rs`, `daemon/src/methods/{agent,thread}.rs`, `daemon/src/mcp/thread.rs`, the protocol and the store. Tests: two in-process daemons with the fake backend: a launch, `thread_read`, `thread_send`, `thread_interrupt`, the refusals, the offline and missing-repository errors, a refused launch that leaves no row and doesn't count toward `maxChildren`, a crash between the row and `thread/start` that retries with a new start bundle, an unreachable flagged row that is deleted after 10 minutes, a device missing a required capability, no API-key fallback on the device, a delete, a Project delete, and `deleteAnyway` with the device offline, and a restart of the home plxd that leaves a running child running.
5. **`feat(daemon): follow a remote child (PLX-604)`.** The watcher: cursor, subscription, state events appended to the home log, `wake::notify` and `land::turn_ended` per turn, `resyncRequired` and `logId` handling, the per-turn bundle into `refs/parallax/remote/<run id>` with the three-part `exclude` set, the `fetchFailed` mark, ref cleanup, `thread_list` printing the ref (or the note before the first turn end), and the remote `coordinator.md`. Files: `daemon/src/agents/{remote,wake}.rs`, `daemon/src/agents/coordinator.md`, `daemon/src/mcp/thread.rs`, the store. Tests: a turn end wakes the coordinator once, a finished child doesn't spin the watcher, a completed-running-completed sequence between two polls ends two turns, a device log reset, an offline device that comes back, a crash between the wake and the cursor, a failed fetch that still wakes the coordinator with the reason, the ref holding the child's commits for a diff, and a bundle that stays small after a send-back.
6. **`feat(daemon): land a remote child (PLX-604)`.** `land::child` for a remote row, the merge from the ref, the send-back with the tip (calling PR 3's `git/startMerge`), red checks, `land/queue` refusing a `fetchFailed` row, Needs you in place of any wait, and turning the `projectComputer` capability on. Files: `daemon/src/methods/land.rs`, `daemon/src/worktree/landing.rs`, `daemon/src/agents/remote.rs`, `daemon/src/methods/project.rs`. Tests: a clean landing with the device offline, a conflict that reaches the child with the tip, red checks that send the commit, an offline send-back that goes to Needs you without holding the queue, a `fetchFailed` row refused with its reason, and the capability being the only thing that lets `project/update` accept `computer`.
7. **`feat(app): choose the computer a Project's threads run on (PLX-604)`.** The composer footer menu, the Computer group taken out of `RunTargetMenu`, the home plxd's `connect/devices` as its source, a remote child's row opening on its device connection, and the offline state. Files: `apps/desktop/src/renderer/{ProjectChat,RunTargetMenu,AgentChat,ProjectAgents}.tsx`, a small `ComputerMenu.tsx`, and their tests, plus an e2e test against two plxds. Tests: pick, change, and clear the setting, the menu on a plxd without the capability, and a remote child's row.
8. **`feat(daemon): Project tools for a remote child (PLX-604)`, optional.** `ask` and memory for a remote child, with its tool server bound to the home plxd. Needs the home plxd's `connect` on and a `thread/start` option naming the home address. Decide after PR 6.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| The app relays between the two plxds | Wake-ups, landing, and `thread_launch` run in plxd with the app closed, and 0007 attaches an app only sometimes. |
| The home plxd runs the vendor CLI over ssh in a remote worktree | The worktree, sandbox, account, approvals, and MCP socket are all local paths and local credentials, so each would need a remote version. A remote plxd already has all of them. |
| A shadow Project on the device, with `agent/start` there | The device would need a coordinator for wake-ups, `ask`, and memory, which is a half-copy of the Project. |
| Mirroring every remote event into the home log | The app and the tools would work unchanged, but it means a second path for each event type, a catch-up after every disconnect, and double the storage. Mirroring state and forwarding reads covers the coordinator's needs. |
| Pushing branches to `origin` for sync | It puts `parallax/...` branches on GitHub for every remote child and needs push rights on the device. 0045 says only the user pushes. |
| Fetching the child's branch only at `land/queue` | The coordinator couldn't review a child's diff from its own worktree, and landing would wait on the device. |

## Consequences

- Children can use a more powerful computer, and Projects keep their one coordinator, memory, inbox, and landing queue.
- plxd gets its first client of another plxd, and Connect's `whois` check, applied again on every dial, is the only trust boundary for it.
- The home repository holds a ref for every live remote child, and the device holds a worktree and `parallax-sync/*` refs. Deleting a run or a Project removes them, and is refused while the device is offline unless the user deletes anyway, which leaves the device's threads and worktrees behind.
- Each turn costs a bundle transfer, capped at 64 MiB, so a very large child is refused with a reason.
- The home plxd and the device need the same repository, and `origin` has to match.
- A remote child and its watcher outlive the app but not the device: a device that goes away leaves its children at their last status.
- A remote child can start plain threads on the device that the coordinator never sees, until PR 8 or a later record decides otherwise.
