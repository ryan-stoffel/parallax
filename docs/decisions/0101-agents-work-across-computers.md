# 0101: Agents work across the user's computers

- Status: accepted; amends [0091](0091-connect-over-relay.md) (the relay admits plxd by host key) and [0097](0097-same-named-projects-span-computers.md) ("plxds don't talk to each other"), and leaves [0057](0057-project-threads-on-another-computer.md) unbuilt
- Date: 2026-11-04
- Issue: PLX-1373, with PLX-1361

## Context

T3 links machines so an agent can hand work to another one, reads threads across them, and balances new threads between them (`docs/user/remote-access.md`, `docs/internals/remote.md` at T3 Code `main`). Its link is explicit: a pairing code, a token in the linking machine's secret store, and an access level.

Parallax has no equivalent. Each plxd only answers clients. 0057 designed Project children on another computer, but its follower, bundles flow, and start path were never finished: `orchestrator_computer` is off in every production config, and only You memory sync uses `peer.rs`'s `Peers`, over Tailscale. plxd keeps no account token (0091), so it can't open a relay stream or read the account's host list.

What already exists: `peer.rs`'s `Plxd` client with connectors, `remote::open_pinned` with `Pin::HostId`, DPoP-bound sessions, each host's `approved_hosts` copied between hosts by approved clients (0091), and `repo/match` (0057), which finds this host's copy of a repository by its origin.

## Decision

### Trust: an approved computer proves itself with its host key

No pairing step and no new secret. The user already approved each of their computers once under 0091, so that approval is the link.

- **The setting.** `agentWork` in `host/settings`, off by default, is one switch per computer under "Agents can work here" in Settings. It is the receiving computer's. Off, the computer refuses new peer sessions and closes the ones it has. Other computers arrive at the remote listener, so turning it on turns `remote` on, and turning `remote` off turns it off.
- **`POST /api/auth/peer`** on the receiving computer: a DPoP proof made with the caller's host key. It answers with an ordinary DPoP-bound session only when `agentWork` is on, the proof's key thumbprint is in `approved_hosts`, and it isn't a removed key. The session is listed in Settings as "`<name>` agents", one per computer, and revoked there. Revoking it refuses that computer here until `agentWork` goes off and on, since a host key can't be replaced as a device's can, and that stays this computer's alone, out of what hosts copy. It needs no Clerk token, because the proof shows the key and `approved_hosts` shows the user approved that key. The caller keeps the token in memory, and asks again after a restart.
- **The caller checks too.** It dials only a host id in its own `approved_hosts`, pinned with `Pin::HostId`, and it sends no credential until the pinned TLS is up. A host the relay lists that the user never approved gets nothing.
- **No fence.** A peer session has the same reach as the user's own device. A thread started on the other computer runs as that user, so a method allowlist on the session would only stop Parallax's own tools, as T3 found for its full-access links. The setting is the control, so it defaults to off.
- **Modes.** A remote thread takes the caller's mode unless the tool asks for one, and `check_mode` refuses one that needs less approval. `thread_send` follows the same rule: a thread on another computer that needs less approval than the caller refuses its message, since the message runs a turn in that thread's mode. The caller's plxd enforces this, as the session already trusts that plxd.

### Transport: the relay carries it, and can still read nothing

- **Two relay routes take a host proof,** instead of a Clerk token: `GET /v1/hosts` and `/v1/hosts/<id>/connect`. The header `x-parallax-peer` is `<caller host id>.<ms>.<signature>`, signed with the caller's key over a message naming the route and target. The relay checks it against the caller's registered key, within the skew it already allows host proofs, and requires both hosts to have the same owner. It counts against the target's existing limits.
- **Inner TLS stays pinned** to the target's host id, so the relay still carries only ciphertext.
- **plxd still keeps no account token.**
- **The relay route is the only one in this record.** Tool calls are small, and the relay's budget is 2 GiB a host a day. Direct routes come when something needs them. `relay` must be on at both ends.

### Agent tools

- **`linked_computers`** lists the account's computers with each one's id, name, whether it's online, whether it takes agent work, and its running agents. `computer` in every other tool takes an id or a name from that list, and an ambiguous name is an error.
- **`delegate_task` takes `target.computer`.** The task runs on that computer as an ordinary thread in a new worktree of the repository `repo/match` finds there, from `origin`'s default branch, or from `base` if given. It runs on the parent's backend and model unless the tool names others, and `thread_launch` without a backend uses that computer's default. Unpushed commits aren't on the other computer, and the tool's description says so. Results come back through its last message and whatever it pushes.
- **`thread_launch`, `thread_list`, `thread_read`, `thread_wait`, `thread_send`, and `thread_interrupt` take `computer`.** `task_status` and `task_cancel` work on a remote task with no extra argument.
- **The forward.** `plxd mcp` sends a tool's calls through a new local method, `peer/call { computer, method, params }`, which allows only the methods these tools use. The daemon holds one peer client per computer, as 0057 intended. `peer/computers` lists the computers, asking each online one for `host/health`. `peer/start` starts a thread there and records its row in one step, and `peer/task` reads and marks a remote task. `peer/*` answers only on the local socket, so a session from another computer can't go on to a third.
- **The start.** Before a thread starts from a remote-tracking ref, including a branch of a remote it hasn't fetched yet, the other computer fetches it with `repo/fetchBase`, since the tools tell agents to push first. A failed fetch uses what was last fetched.
- **The first message** of a remote thread opens by naming the computer and thread that started it.
- **Never a fallback.** A computer that is offline, unknown, unapproved, has `agentWork` off, or lacks the repository is an error to the agent that says which. Work never runs on the caller's computer instead.

### Waking the caller

- plxd stores each remote task and notifying remote thread in a new table: remote run id, host id, parent, title, status, summary, and whether the result was read.
- **A follower per open row** waits with `agent/wait` through the peer client, in calls of at most 60 s, and retries while the computer is unreachable. When the run ends it records the outcome and wakes the parent as a local child's end does.
- **Rows outlive restarts.** A row is stored before its thread starts, and a refusal removes it. If plxd dies after that, the thread that started is followed, and one that never did ends its row after 5 minutes and wakes the parent to say so. Open rows are followed again when plxd starts. A run on the other computer that a restart marked interrupted counts as ended. A computer removed from the account, or one that refuses the session for good, ends the task with that reason.

### The composer

- **`@` lists computers.** Choosing one inserts a chip with the computer's icon. A computer's or thread's chip is the app's own chip, as a skill's or a file's is, with the computer's device icon, and one that opens something shows it as other chips do. A thread on another computer follows that with `on <computer>`, muted, which gives way first to a long title. On send, the message carries its host id in `computers`, beside `threads`. plxd renders them before the user's message, saying how to run work there. The transcript keeps the chip, not the rendered context.
- **`@` lists threads from other computers,** named by computer, from those with `agentWork` on. The message carries `remoteThreads: [{ computer, runId, title }]`. plxd renders each as a reference for the agent to read with `thread_read`, so attaching a long thread costs nothing until it's read, as in T3.

### The Load Balancer

- **`host/health` gains `load`:** `{ cpu, memory, cores }`: CPU and memory in use, as percentages, and logical cores. Memory leaves out file caches: `sysinfo`'s used memory is total minus available on Linux and Windows, and Activity Monitor's Memory Used on macOS, whose available memory wrongly counts active pages. An older plxd omits `load`.
- **The app keeps the settings,** in `localStorage`, as 0096 does: a switch, which computers are left out, and each computer's Prefer, Normal, or Less often. A computer takes part until it's left out, and keeps its preference. They're under Settings > Connections and appear with two or more computers. While that section is on screen and the switch is on, it reads each computer's load every 3 s and says where the next thread goes, from the same scoring, with the default provider. It can't know the next thread's repository.
- **A new draft starts on it.** With the switch on, a fresh New Thread checks and moves to the pick with no click. While it checks and moves, the box sends nothing: its text stays, and the send button says it's waiting, since a send uploads its files and fixes its model for the computer it's on. The pick holds for the draft, including when its tab is opened again. A manual pick overrides it, and even a computer left out can be picked by hand. In New Thread's computer menu, the pick has the check, as any chosen computer does, and a small scale mark, as it does in the bar; while it checks the bar says it's choosing. After a manual pick, a last row, Let the Load Balancer choose, gives the draft back to it and checks again, and so does picking another repository or a Cmd/Ctrl+Enter start, which leaves the box ready for a new thread. Picking a branch or workspace while it checks keeps the draft where it is.
- **Where it doesn't start:** a reopened draft or Diagnose a problem's, a Project (its computer tray picks), another computer's repository picked from Mod+N's or the repository menu, a new tab in a pane that isn't focused (it takes that pane's computer), and New Thread as a stand-in while an orchestrator on another computer loads.
- **Eligible** means connected, not left out, listing the repository as the computer bar does (a thread with no repository can go anywhere, and one whose list hasn't loaded doesn't count), not named in the draft, sending `load`, and able to run the draft's provider per `providers/list`: the model picked in the draft, or else the default model's instance, or with neither any instance that's on and can run, which the model menu would then use. It waits up to 3 s for computers still connecting, and up to 3 s more for answers, and decides among those that answered, by what's connected, listed, and taking part by then.
- **The score** is $w \cdot n \cdot (1 - c) \cdot (1 - m) / (1 + r)$, with $w$ of 100, 50, or 25 for the preference, $n$ the cores, $c$ and $m$ the CPU and memory fractions, and $r$ the running agents, since a just-started agent doesn't show in a CPU sample yet.
- **Full** is 95% or more of CPU or memory, as T3 has it. With no computer able to take the thread, the bar says to pick one, each menu row says why not, the send is refused until the user picks or it finds one, and the menu links to the setting.
- **What pins a draft.** Attached threads on this computer, whose run ids mean nothing elsewhere, and `@` files, listed from this computer's checkout, keep the draft here, and the menu says why. Images and files don't: the app holds them until the send uploads them, and nothing sends until the draft is placed. A thread on another computer is a reference and doesn't pin, though the draft can't move onto a computer it names, since a computer can't be named from itself.
- Existing threads stay put. The phone keeps its manual choice.

## Rejected

| Option | Why not |
| --- | --- |
| A pairing code per link, as T3 | The user already approved these computers under 0091, and a second approval proves nothing new. |
| The app forwards between computers | Delegation has to run and wake the caller while the app is closed. |
| Giving plxd an account token for the relay | 0091 keeps no token on purpose. A host-key proof gives the relay what it needs. |
| Scoped peer sessions | A thread on the other computer can do what its user can, so scope would limit nothing that matters. PLX-1364 can add it for read-only devices. |
| Copying commits to the other computer | A push is enough for now, and bundles add a flow nothing needs yet. |
| Cloning a missing repository automatically | An agent choosing what lands on another computer's disk should be a user's call. The error says what's missing. |

## Consequences

- Turning on `agentWork` lets an agent on any of the user's approved computers run commands on this one, at the caller's mode or stricter. A prompt-injected agent on one computer can reach the others that have it on, which is why it starts off.
- Production needs a relay deploy, which Ryan does by hand (PLX-1371). A relay from before this record refuses the proof, so the tools say the relay needs updating.
- A computer with `relay` off can't take part.
- A computer added with Allow alone (0091) is in `allowedHosts`, not `approvedHosts`, so it can't take part on either end, since it may be a fake one the user clicked through. PLX-1402 tracks what lifts it.
- Every thread started this way uses the other computer's accounts and its usage limits.
- PLX-1362 still has to build Orchestrator children on another computer. It can use this record's client and follower.
