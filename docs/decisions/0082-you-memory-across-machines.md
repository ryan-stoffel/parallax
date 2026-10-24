# 0082: You memory syncs between the user's Connect devices

- Status: accepted; supersedes [0044](0044-project-memory.md)'s "You is not shared across hosts or devices yet" and, for the You scope, [0005](0005-shared-context-folder.md)'s "the host's version wins"
- Date: 2026-10-23
- Issue: PLX-946, for PLX-934 (spec step 12, Ryan's decision 8)

## Context

You memory lives in `context/you` on each host (0044), so a preference learned on one computer never reaches another. Ryan decided You should follow the user across machines, and on 2026-10-23 chose the "Auto" path: plxd copies it between the user's Connect devices, with no repository the user has to own.

What it builds on:

- **Entries** are Markdown files, `memory/<kind>/<slug>.md` with a header (`Kind`, `Title`, `Source`, `Date`, `Writer`), and `knowledge/<slug>.md`. You is usually tens of KiB. plxd rewrites an entry's `Last used:` line when an agent reads it (PLX-943) and its `Stale:` line when a path it names is gone.
- **Parallax Connect** (0056): the user's untagged devices of one Tailscale user reach each other's plxd on port 7340, checked with `tailscale whois` on the answering side and the device filter on the dialing side. `daemon/src/peer.rs` (0057) is plxd's client of another plxd, one per device (`Peers`), sending its node ID as `machineId`.

## Decision

**Each plxd pulls You memory from the user's other Connect devices.** No new service, credential, or crypto, and memory stays on the user's own computers.

Not chosen:

- Through Parallax Relay: needs relay storage with a key shared by every host, or host-to-host pairing, and the relay stores nothing today (0068).
- A user-owned Git repository: You on GitHub in plaintext and push credentials on every host. Ryan chose against it.
- The app copying between connected hosts: nothing syncs while the app is closed, two open apps race, and daemon tests can't cover the merge.

### What syncs and what stays local

- **Syncs:** You's `memory/<kind>/*.md` and `knowledge/*.md`, and their deletions.
- **Stays local:**
  - `proposals/`, including the conflict proposals below.
  - The `Last used:` and `Stale:` header lines. Each host keeps its own. They are left out of the text that syncs and of its hash, so an agent reading an entry never makes it look edited. A synced entry arrives without them.
  - Repo and Project scopes. A fact that only holds on one machine, such as a local path, belongs there.
  - Secrets, which live in the host's keystore (0040, 0063) and never in memory.

### Identity and access

- **A machine is its Tailscale node ID.** Its name is its `deviceName` (0056), or its Tailscale host name when that is unset, as of the write.
- **Who may sync:** the dialing plxd runs 0056's device filter. The answering plxd serves `memory/syncList` and `memory/syncRead` only on a connection that arrived over its Connect listener and passed 0056's `tailscale whois` check. It refuses them on every other connection: the local socket, `plxd attach` over SSH, and paired remote and relay sessions.
- **Pull only.** A plxd reads its peers and writes only its own folder.

### Entry versions

A store table, `you_entries`, keeps one row per path: `hash` (SHA-256 of the synced text), `clock` (a version vector, node ID to counter), `machine` and `machine_name` (the last writer), `written_at`, and `deleted` (a tombstone).

**A scan finds local changes.** It compares the folder with the table: a file whose hash differs from its row, a new file, or a row whose file is gone. Each one bumps this machine's counter and records this machine as the writer, at the file's modified time, or now for a deletion. plxd scans before each pull and before it answers a peer's `memory/syncList`. That one scan covers `memory/write`, `memory/delete`, an edit on disk, and an edit made while plxd was down.

**Sync never overwrites a local write.** `memory/write`, `memory/delete`, and the `Last used:` stamp on You take the same lock as the scan and the apply. Before replacing or deleting a file, the apply checks that the file still has its recorded hash. A file edited on disk since the scan is left for the next pull, which sees it as a local change.

Tombstones are never removed. Each is one small row, and a host offline for months must not bring a deleted entry back.

### Pull

While `connect` is on, every 60 seconds from a minute after plxd starts, plxd scans, then pulls each online Connect device that advertises `youSync`. It pulls the devices at once, each within 60 seconds, so a device that went to sleep mid-call can't hold up the others:

1. `memory/syncList {}` returns every row.
2. For each row whose clock this host's doesn't cover, `memory/syncRead { path }` returns the synced text, which must match the row's hash. A mismatch waits for the next pull.
3. Under the same lock as the scan, plxd scans again and applies each row by the rules below.

A path outside `memory/<kind>/` and `knowledge/`, or text over the shared context caps, is skipped.

### Conflict rules

Compare the local clock with the remote one:

- **Equal, or local covers remote:** nothing.
- **Remote covers local (last writer per entry):** plxd takes the remote version, writing the file or deleting it, and takes its row. When the remote text is the text this host has, it takes only the row, so the host keeps its `Last used:` and `Stale:` lines, and running children hear of no change. "Later" is decided by the clocks, not wall time, so a host with a wrong clock can't drop an edit.
- **Concurrent** (neither covers the other):
  - **Same text, or both deleted:** plxd keeps it and merges the clocks.
  - **An edit against a deletion:** the edit is kept, since keeping it loses nothing.
  - **Two different edits, a proposal:** plxd keeps the version written later, ties going to the higher node ID, so every host picks the same one. The other version becomes a proposal on this host, with `Scope: you` and `Replaces: <entry path>`, which the Memory tab already shows with Save and Discard. A knowledge file has no kind for a proposal, so its other version becomes a copy beside it in `knowledge/`, a file of its own that syncs like any other.
  - The proposal's or copy's name comes from the losing version: the entry's kind and name, then the node ID that wrote it and that node's counter, such as `proposals/preference-tabs-nb2-3.md`. A retry, or a later pull that sees the same conflict, writes the same file over itself instead of adding another.
  - Every host that sees both versions before it receives the merged row writes the proposal: usually the first host to pull, and sometimes two that pull each other at the same moment, or a third that pulls both sides first. Each host keeps at most one per losing version. Resolving it on one host leaves the others' copies, which the user discards.

In each concurrent case the kept row takes the merged clock (pointwise maximum). It covers both versions, so every other host takes it as a newer version, with no second conflict. Saving the proposal is a local write, which reaches every host the same way. Discarding it deletes only the proposal.

### What the user sees

- `MemoryFile` gains `machine` (`{ id, name }`) for a You entry whose file matches its row: the computer that last wrote it. The Memory panel shows "Written on {name}" beside its source.
- There is no new setting. You syncs while `connect` is on.

### Protocol

- Capability `youSync`.
- `memory/syncList {}` returns `{ entries: [{ path, hash, clock, machine: { id, name }, writtenAt, deleted }] }`.
- `memory/syncRead { path }` returns `{ content }`, the synced text, at most 1 MiB.

### Tests

- Unit tests on the clock comparison, the merge rules, and the synced text with `Last used:` and `Stale:` left out.
- Server tests with two plxds on loopback and a fake tailnet:
  - **Conflict:** an entry written on A reaches B, showing A as its machine. Both edit it while apart. Once they reconnect, both hold the later edit, and the other edit is a proposal, at most one per host, which more pulls don't add to.
  - **Offline catch-up:** B stops. A adds, edits, and deletes entries. B restarts on its data folder and matches A after a pull, the deletion included, and A still matches after more pulls.
  - **Connect only:** a client on the local socket is refused `memory/syncList` and `memory/syncRead`.

## Consequences

- You converges among Connect devices within about a minute of an edit, whenever two of them are online. An offline host catches up from any peer when it returns.
- Two computers that are never online at the same time never converge, and hosts reached only by SSH or LAN pairing keep their own You.
- The entry itself converges everywhere, but a conflict proposal stays on the hosts that saw both versions, sometimes more than one.
- "Written on" is missing for up to a minute after an edit, until the next scan records it.
- Any of the user's untagged tailnet devices can read all of You, as it already can through Connect.
- The mobile app reads You through the host it connects to and syncs nothing itself.
