# 0007: JSON-RPC over `plxd attach`, locally and over SSH

- Status: accepted; the `agents` capability's methods are partly superseded by [0014](0014-agent-runs.md), which renames `agent/stop` to `agent/cancel` and `agent/output` to `agent/events`, and adds `agent/send` from 0011; its TypeScript client and the generated types' location are superseded by [0022](0022-desktop-app.md); the local transport on Linux and Windows (a per-user named pipe there) is in [0023](0023-cross-platform.md); the `coordinator` capability is `project/start` and the `agent/*` methods instead of `coordinator/send`, `coordinator/stop`, and `coordinator.*` events ([0024](0024-coordinator-chat.md)); extended by [0065](0065-remote-reach.md) (the same JSON-RPC over a WebSocket, with paired sessions)
- Date: 2026-09-24
- Issue: #56

## Context

The editor and `plxd` need one protocol, whether `plxd` runs on this Mac or on a host reached over SSH. It has to carry everything from M1's projects to M6's triggers. Agents on a host keep running while the MacBook sleeps (M4), so the editor has to catch up on what it missed. #57 to #66 build on this record. The prototypes that checked it are described on #56.

## Decision

### Transport

- **Local:** plxd listens only on a Unix socket, `plxd.sock` in its data folder `~/Library/Application Support/parallax` (0006).
  - On every start, plxd checks the folder with `symlink_metadata`. It must be a directory, not a symlink, and owned by plxd's euid. plxd then sets it to 0700.
  - A `flock` on `plxd.lock` allows one plxd per folder. Only the lock holder removes an old `plxd.sock`, and only if it is a socket.
  - The socket is 0600, and `getpeereid` must return plxd's own uid.
  - macOS caps socket paths at 103 bytes, which the default path exceeds when the home folder path is longer than 56 bytes.
    - In that case, plxd and its clients (`attach`, `plxd mcp`) all use `$(getconf DARWIN_USER_TEMP_DIR)plxd-<hash>.sock`. `<hash>` is the first 8 hex digits of the SHA-256 of the data folder's path, and that folder is per user and 0700.
    - macOS's daily `dirhelper` deletes files there that are older than three days, so plxd checks the socket every minute and binds it again if it is gone.
  - There is no TCP port, no token, and no system-wide daemon. Each macOS user runs their own plxd, so users of a shared Mac stay isolated.
  - The trust boundary is the user. Any process running as that user can connect and call any method, including the agents plxd starts, which run shell commands. #11's plan approval is a UX step, not a boundary against a compromised agent.
- **Editor:** it always talks over a child process's stdio.
  - Locally it runs the bundled `plxd attach` (#62). For a host it runs `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=~/.ssh/parallax-%C -- <destination> plxd attach` (on Windows, `-o ControlPath=none` instead, since its OpenSSH has no ControlMaster).
  - The editor rejects a destination that starts with `-` or contains whitespace or control characters, and `--` keeps ssh from reading it as an option. `parallax.host` is application-scoped, so a workspace's `.vscode/settings.json` can't set it.
  - `ControlMaster=no` makes it a client of a shared connection only if one is there. `parallax-%C` is a Parallax-owned socket in `~/.ssh`, one per host (`%C` hashes host, port, and user), short because a Unix socket path can't pass about 104 bytes on macOS. With no socket, or a dead one, ssh connects directly, so key-based hosts behave as they did with `ControlPath=none`.
  - Hosts that need a password or 2FA are in scope through Sign in (PLX-601). The app runs `ssh -o ControlMaster=auto -o ControlPersist=yes -o ControlPath=~/.ssh/parallax-%C -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -f -- <destination>` in a terminal, where the user answers ssh's prompts. `-f` backgrounds ssh once it has authenticated, so the terminal ends and the master stays; `BatchMode` connections then reach the host through it. `ControlMaster=auto` lets ssh clear a stale socket that a crashed master left. Not on Windows.
  - A master can't go stale and hang a reconnect for long: `ServerAlive` ends one whose network went away (about 45 s), and the heartbeat below kills a connection through a dead one. The host then fails with Permission denied until the user signs in again, so after sleep or a network drop a password host needs Sign in again. The master is a separate ssh process, so it outlives quitting Parallax, until its network drops or it's stopped with `ssh -O exit`.
  - `attach` (#60) bridges stdio to the socket byte for byte. If plxd isn't running, `attach` starts it through the LaunchAgent when #61 installed one.
    - Otherwise it starts `serve` in a new session (`setsid`), with stdio going to its log, so the ssh session can close.
    - #60's "no orphaned processes" applies to `attach`, not to that `serve`, so a disconnect never stops agents.
    - On a host, the LaunchAgent is the recommended setup, since a process started from SSH may not reach the Keychain (0004).
- **Credentials:** Parallax stores none and never sees any.
  - The user's `ssh` applies their config, keys, agent, `known_hosts`, and jump hosts.
  - `BatchMode=yes` turns prompts into errors. The user accepts a new host key or unlocks a key once, with `ssh <destination>` in the integrated terminal, or enters a password with the app's Sign in.
- **Reconnect:**
  - The editor sends `host/health` every 30 s and on wake. If 10 s then pass with no bytes received, it kills the child and reconnects, backing off from 1 s to 10 s (#11). This covers both sleep and network changes.
  - Any received bytes, such as a replay in progress, reset that timer.
  - plxd writes responses ahead of queued events, and drops a connection that has been silent for 90 s.

### Framing

- **Messages:** JSON-RPC 2.0 in both directions, one compact JSON object per line (NDJSON). MCP's stdio transport and the vendor CLIs (0004) use the same framing.
- **Frame size:** at most 8 MiB (`maxFrameBytes`).
  - A malformed line gets -32700.
  - An oversized frame closes the connection.
  - Diffs, logs, and files come through paged methods.
- **Conventions:** fields are camelCase, ids are UUIDv7 strings, times are RFC 3339 UTC, and integers stay below 2^53.
- **Rust:** `serde_json` and `tokio_util`'s `LinesCodec::new_with_max_length`, with no RPC framework.
- **TypeScript:** Code - OSS's own `JsonRpcProtocol` (`vs/base/common/jsonRpcProtocol.ts`, which upstream's MCP client uses) over `StreamSplitter('\n')`, so no npm dependency is added.
- **Debugging:** `printf '%s\n' '<request>' | ssh <destination> plxd attach | jq`, which works because `attach` half-closes.

### Handshake and versioning

- **`initialize` comes first**, and anything sent before it fails with `notInitialized`.
  - It sends `protocol: {min, max}`, `client: {name, version, machineId?}`, and `capabilities`.
  - It returns `protocol`, `plxd` (the release version), `logId`, `capabilities`, and `maxFrameBytes`.
  - `capabilities` is an object map such as `{"agents": {}}`, as in LSP and MCP.
  - The map, the version fields, and the `incompatibleProtocol` error never change shape.
- **`protocol` is an integer, starting at 1.**
  - Additions keep it: methods, notifications, event kinds, optional fields, and enum values. Receivers ignore anything unknown, and every enum Rust receives has an `#[serde(other)]` fallback.
  - An older plxd would silently ignore a new option. So an option whose loss changes behavior, such as a sandbox setting, is sent only when plxd advertises a capability for it.
  - Removals, renames, and type changes bump it. After a bump, the previous version stays in range for at least one release, so an editor and its host can upgrade at different times.
  - Capabilities (`agents`, `coordinator`, `localRunner`, `triggers`) gate later features, so a newer editor still works with an older host.
- **On a mismatch**, plxd answers `incompatibleProtocol`, with both ranges and its release version.
  - The editor enters #63's incompatible state and stops retrying until the user clicks Retry.
  - It names the side to update, for example "Update Parallax on mac-mini".

### Events and backpressure

- **Event log:** every state change goes into one event log, numbered by a daemon-wide `seq`.
  - From M3 the log is stored in SQLite (#58).
  - `logId` changes only when the log starts over, such as after a wiped data folder or after an M1 restart that loses an in-memory log.
- **Subscribing:** snapshot methods such as `project/list` return the event log's `seq` from before they read, so they may already reflect some events after it, and replaying those is harmless (PLX-457). `events/subscribe {after, project?}` replays newer events, then streams live `events/event` notifications: `{subscription, seq, time, project?, event: {kind, ...}}`. Without `project`, it gets host-level events such as `project.created`.
- **Several clients:** any number of connections may attach, each with its own subscriptions, and plxd broadcasts every change to all of them.
- **Resuming:** after a reconnect, the editor resubscribes from its last `seq`. It reloads its snapshots instead if `logId` changed, or if plxd answers `resyncRequired` because the history is gone or too long to replay. From M3, `agent/output` rebuilds a running agent's transcript after a resync.
- **Backpressure:** each connection has a bounded outbound queue.
  - A subscriber that falls behind the live buffer reads from the log until it catches up, so agents never wait on an editor and memory stays bounded.
  - Output is coalesced to one `agent.output` per run every 50 ms.

### Errors and cancellation

- **Error codes:**
  - Malformed traffic gets JSON-RPC's standard codes.
  - -32800 means cancelled.
  - Every Parallax error is -32000 with `data: {kind, detail?}`. The editor matches on `kind`, a generated enum such as `projectNotFound`, and never on `message`.
- **Cancelling a request:** `$/cancelRequest {id}` cancels it, and the request still gets exactly one answer.
- **Disconnects:** a disconnect fails pending requests but never stops an agent. Long work takes a client-generated id (`runId`) and stops only through its own method (`agent/stop`), which uses 0004's cancel for each CLI.
- **Idempotent creates and starts:** every method that creates or starts something takes the new thing's id from the caller: `project/create {id}`, `agent/start {runId}`, `coordinator/send {turnId}`, `runner/start {runId}`, and `trigger/create {id}`.
  - The caller generates the id (UUIDv7) once and sends the same id on every retry.
  - If a thing with that id exists, the receiver returns it instead of creating or starting another. If the params differ from the original call, it fails with `idConflict`.
  - A retry after a lost connection therefore never starts a second agent or spends quota twice.

### Types

- **Source of truth:** the `parallax-protocol` crate (#57), which holds the serde types and one method table.
- **Generated TypeScript:** an explicit generator command runs ts-rs 12 with `Config::with_large_int("number")`.
  - It doesn't use `#[ts(export)]`, whose generated tests write files during `cargo test`.
  - The output is committed under `editor/`, which the fork job's input hash covers, so a type change also reruns the fork type-check. The fork still builds without Rust.
- **Tests (#57):** `check-rust` already runs `cargo test`, which runs both of these.
  - A staleness test regenerates the TypeScript in memory and fails if it differs from the committed copy. Codex's app-server crate uses the same check.
  - Sample messages for each protocol version are committed, and a test asserts that they all still deserialize. This enforces the additive rule.

### Methods

| M1 method | Direction | Purpose |
| --- | --- | --- |
| `initialize` | editor to plxd | Handshake |
| `host/health` | editor to plxd | Uptime, store state, running agents; heartbeat |
| `host/version` | editor to plxd | plxd and protocol versions, macOS, arch |
| `project/list` | editor to plxd | `{projects, seq}` |
| `project/create` | editor to plxd | `{id, name, repoPath}`; idempotent on `id` |
| `events/subscribe`, `events/unsubscribe` | editor to plxd | Replay after `seq`, then live |
| `events/event` | plxd to editor | One event, such as `project.created` |
| `$/cancelRequest` | either | Cancels a request |

Later milestones add methods and events behind a capability, with no version bump:

| Capability | Methods | Events |
| --- | --- | --- |
| M3 `agents` | `agent/start {runId, ...}`, `agent/stop`, `agent/list`, `agent/output {runId, after}` (paged, returns `seq`), `agent/diff` (paged), `context/list`, `context/read`, `context/write` | `agent.started`, `agent.output`, `agent.finished`, `context.changed` |
| M4 `coordinator` | `coordinator/send {turnId, ...}`, `coordinator/stop`, `plan/approve {planId}`, which fails with `planReplaced` if #11's flow replaced that plan | `coordinator.output`, `coordinator.turnFinished`, `plan.proposed`; parallel agents are just more `runId`s |
| M5 `localRunner` | `runner/start {runId, ...}`, `runner/stop`, and the shared context mirror sync (0005), which the host sends over the connection the MacBook opened. `client.machineId` tells two machines apart. | `runner.output`, `runner.finished` |
| M6 `triggers` | `trigger/list`, `trigger/create {id, ...}` | `trigger.fired` |

`plxd mcp` (M4) is an MCP server on stdio and a normal Parallax client on the socket. It sends `initialize` like any other client but no heartbeats: it keeps one connection, stops using it after 75 s without a write (under plxd's 90 s idle limit), and opens a new one on the next call. It exposes only its project's coordinator tools (0004), never `plan/approve`.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| gRPC (tonic, `@grpc/grpc-js`) | It needs HTTP/2 end to end, which over `ssh` means a proxy or port forwarding. It adds grpc-js and protoc to the fork (0002 rule 3), and binary frames can't be read with `jq`. |
| HTTP plus WebSocket (axum, `ws`) | Upstream's agent host uses it with a bearer token. On a private link it only adds a layer. On TCP, any local user or browser tab can reach it, so it needs a token, which is a secret. |
| Content-Length framing (LSP) | Hard to type or read, and a bad header loses the stream, while NDJSON resyncs at the next newline. |
| SSH port or socket forwarding | Another process to supervise, it can't start plxd, and servers often disable it. A forwarded TCP port exposes plxd to every local user. |
| In-process SSH (`ssh2`) | Upstream's remote agent host (a 2,180-line file) reparses `ssh_config` and `known_hosts` and prompts for passphrases, so Parallax would handle secrets. |
| Schema first, specta, typeshare | Schema first needs two generators. specta 2 is still a release candidate. typeshare rejects `{kind, ...}` enums. |

## Consequences

- **One client:** #63 and #64 share one client that spawns a process and exchanges lines, and #63 gets auto-start from `attach`.
- **Additive changes:** the protocol reaches M6 without a version bump only while changes stay additive. The sample-message tests and reviews of `parallax-protocol` enforce that.
- **Upgrades:** after an upgrade, the old plxd keeps running until it restarts (#71).
