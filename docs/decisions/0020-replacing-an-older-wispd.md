# 0020: `wispd attach` replaces an older running wispd

- Status: accepted; amends [0010](0010-wispd-attach.md), where attach never stopped a wispd
- Date: 2026-09-26
- Issue: #256

## Context

After an upgrade, the `wispd serve` of the old version keeps running: one that an earlier `attach` started, or the LaunchAgent's. 0007 noted that it runs until it restarts (#71). The new editor's `attach` reached it, and the Accounts view showed "Method not found: accounts/keys/list" (#256). The protocol version doesn't catch this, because new methods are additive (0007): an older wispd speaks the same protocol but lacks the methods.

## Decision

### When attach replaces a wispd

- When something accepts connections, attach first opens a probe connection and sends `initialize`. The running wispd's release version is `result.wispd`, or `error.data.detail.wispd` when it answers `incompatibleProtocol`. That shape never changes (0007), so an older protocol is replaced too.
- attach compares `major.minor.patch` with its own version. Only a strictly older wispd is replaced.
  - Pre-release and build suffixes are ignored, so `0.3.0-dev` counts as `0.3.0`.
  - A version that doesn't parse, and a probe that fails or gets no answer within 2 s (capped by the connect deadline), count as "not older".
  - So attach never stops a wispd of the same or a newer version, or one it can't read.
- For anything else, attach connects again and bridges, as before. The editor sends its own `initialize` on that fresh connection.

### How

- attach writes `wispd attach: restarting wispd <old>, which is older than <new>` to stderr. The editor reads this line (below), so its start is a contract.
- The pid comes from `wispd.lock` (0009), read after the answer. The socket file's device and inode are read before `initialize` goes out. A wispd removes its socket as soon as it starts shutting down, before it lets go of the lock. So if the socket is unchanged when attach is about to stop wispd, the pid came from that wispd's lock file, not a successor's.
- **LaunchAgent:** if the launch agent is installed for this data folder (0010) and `launchctl print` reports the same pid, attach runs `launchctl kickstart -k gui/<uid>/io.github.ryan-stoffel.wisp.wispd`. launchd sends SIGTERM and starts the job again from its plist, so it is never killed out from under launchd. If that fails, attach falls back to SIGTERM.
- **Otherwise:** SIGTERM to the pid. 0009's shutdown lets in-flight requests finish for up to 10 s.
- attach then waits until the socket file is gone or replaced, and starts wispd the usual way (0010): kickstart or a detached `serve`, which exits 3 until the old one releases the lock. After `kickstart -k`, launchd starts it, so attach only retries the connect.
- All of this stays inside `--connect-timeout`. An old wispd that takes longer to stop ends that attach with exit 4, and the editor's next attempt finds no socket and starts wispd as usual.
- One replacement per attach. What answers next is bridged even if it is still older, such as a LaunchAgent whose plist names an old binary. The editor then shows the out-of-date message below. `wispd service install` updates the plist.

### Concurrency

- **Two attaches during an upgrade:** each checks that the socket is still the one it probed right before it signals. The first SIGTERM removes the socket, so a second attach usually doesn't signal again. A second SIGTERM would skip 0009's 10 s grace. Both then start `serve`, one wins the lock, and the other's attach connects to the winner.
- **Mixed versions** converge on the newest: a newer attach replaces an older wispd, and an older attach keeps a newer one.
- **Runs in flight** on the old wispd are cancelled and recorded `interrupted`, and resume through `agent/send` (0014). Other editors connected to it lose their connection and reconnect through attach (0007).
- **Data:** the old wispd stops the store cleanly, and the new one opens the same folder. Nothing is copied or migrated beyond the store's own migrations.

### The editor

- A `-32601` (method not found) answer becomes a `WispdError` that names the method and both versions: "wispd 0.1.0 is out of date and doesn't support accounts/keys/list, which Wisp 0.2.0 needs. Update wisp on the host, or reconnect to restart wispd." Every view that shows an error's message gets it.
- While attach restarts wispd, the `connecting` state carries `restarting: <old version>`, from the stderr line above. The host chip and the no-host view then say "restarting wispd" instead of "connecting".

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Compare capabilities instead of versions | A wispd missing a capability may be newer, with a feature turned off, and methods inside a capability grow without a new one (0007). |
| Replace any wispd of a different version | A downgrade, or an older editor next to a newer one, would stop the newer wispd, and two editors would take turns stopping each other's. |
| Signal the pid from `LOCAL_PEERPID` | The pid reported by the socket itself, but reading it needs nix's `socket` feature, which adds a crate (`memoffset`). The lock file already names the holder, and the socket check above makes it safe to use. |
| Leave it to `wispd service install` or a manual restart | That was the bug: every upgrade left users on the old wispd. |
| A shutdown method in the protocol | Old wispds, the ones that need replacing, don't have it. SIGTERM already means a graceful stop (0009). |

## Consequences

- After an upgrade, the old wispd is restarted at the next attach, on this Mac and on a host whose own `attach` is newer than its running `serve`. That is most of #71.
- An editor newer than its host's wispd still reaches an older wispd over SSH, since the host's `attach` is the same version as that wispd. The out-of-date message tells the user to update wisp there.
- Every attach costs one extra connection and `initialize`, which wispd logs.
