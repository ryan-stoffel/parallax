# 0066: Updating Parallax updates plxd on every connected computer

- Status: accepted; extends [0030](0030-release-versions.md) (`plxd.version`), [0056](0056-parallax-connect.md), and [0065](0065-remote-reach.md)'s SSH install (PLX-642)
- Date: 2026-10-10
- Issue: PLX-700

## Context

The app's updater replaces the app, and since PR #687 the local `plxd serve` too (`replaceDaemon` in connection.ts). Nothing updated plxd on the other computers the app connects to:

- An SSH host can be updated with `INSTALL_SCRIPT` (installPlxd.ts), but only when the user clicks Update in Settings > Connections.
- A LAN-paired computer (`plxd dial --remote`) and a Parallax Connect device (`plxd dial <ip>`) are reached only through plxd's own protocol. On Linux, plx-connect installs plxd alone in `~/.local/bin/plxd` with a systemd user service, and nothing ever updated it. It also wrote no `plxd.version`, so that plxd reported its build's placeholder, `0.1.0`, whatever release it was. Ryan's ThinkPad sat on that.

## Decision

### plxd: `host/update`

- A new method, `host/update { version }`, behind the capability `hostUpdate`. Failures are `hostUpdateFailed` errors with a message for people. It is withheld from the renderer (`withheldMethods`); only the app's main process sends it.
- plxd downloads `parallax-plxd-<version>-<os>-<arch>` and its `.sha256` from the release `v<version>` with the system `curl` (`github::download_with`, `--proto =https` and `--proto-redir =https`),  checks the SHA-256, writes `plxd.version` beside it, and proves it runs: `--version` must exit 0 and name the version. Only then does it replace anything: plxd first, then `plxd.version`, so a failed second move leaves the new plxd reporting the old version (the app just tries again), never the old plxd claiming the new one. `PLXD_RELEASES_URL` points it at another releases folder, `file://` allowed; like `PLXD_SERVICE_LABEL`, only tests set it. Everything before the move happens in a temp folder beside the destination, so a failure leaves nothing behind.
- Where it goes:
  - A plxd in an app bundle (`Resources/` on macOS, `resources/` on Linux, an AppImage's mount included), or already in `~/.parallax-plxd`, installs to `~/.parallax-plxd/plxd` and `plxd.version`, the same layout `INSTALL_SCRIPT` uses and `LOCATE_PLXD` looks in first.
  - A standalone plxd, such as plx-connect's `~/.local/bin/plxd`, is replaced in place (rename over its own executable) with `plxd.version` beside it. When its folder isn't writable, it goes to `~/.parallax-plxd` instead.
  - A cargo build (`target/<profile>/`, `target/<triple>/<profile>/`) refuses, as the app's `PLXD_PATH` builds are: "a development build, so it doesn't update itself".
- It never downgrades, comparing versions by their numbers and ignoring the channel suffix (0030). The same number answers `upToDate`.
- It answers before it restarts: `restart: now` when no agent's turn is running, or `afterRuns` with `runningAgents`, and the handover waits until the last turn ends, checking every 5 s.
- The handover: with plxd's login service installed (`service status`), it runs the new plxd's `service install --replace` detached, which points the LaunchAgent or systemd unit at the new binary and restarts it. Without a service, plxd shuts down gracefully and, once its lock is released, starts the new `plxd serve` detached as `attach` would. A LAN or Connect computer without a service would otherwise be unreachable until someone started plxd there.
- When `service install --replace` fails and the service manager runs this plxd, it never starts `serve` itself: under systemd, a process it starts stays in the unit's cgroup and is killed with it, and `Restart=on-failure` ignores the exit 0 of a clean stop, which would leave the computer with no plxd. Instead it shuts down and exits 75 (`EX_TEMPFAIL`), and `Restart=on-failure` or launchd's `KeepAlive.SuccessfulExit=false` starts the service's program again. For an in-place update that path now holds the new plxd; for one that went to `~/.parallax-plxd` while the service still names the old path, the old plxd comes back, and the app reports the failure. "The manager runs this plxd" means its service's main pid (`systemctl show MainPID`, `launchctl print`) is plxd's own; when the manager can't be asked, plxd's cgroup ending in the unit's name on Linux, or `XPC_SERVICE_NAME` naming the label on macOS. Only when it fails and no manager runs plxd does it fall back to starting `serve` itself.
- macOS and Linux only. On Windows it refuses: "plxd can't update itself on Windows. Update Parallax on that computer." Parallax's installer owns plxd there.

### App: when to update

- Only a packaged app without `PLXD_PATH`, and only remote hosts: SSH hosts, LAN computers, and Connect devices. The local plxd is #687's.
- Once the local connection reports plxd at the app's version, so after an update has landed locally, every connected remote host whose plxd is older than `app.getVersion()` is updated, and so is every one that connects later. Each host is tried once per launch per app version (`hostUpdate.ts`).
- How: `host/update` when the host advertises `hostUpdate`, with a 15-minute timeout for the download. Without it, an SSH host gets `installPlxd`, as Update in Settings does, and reconnects through `LOCATE_PLXD`. That install restarts plxd at once, so the app first waits until the host's `host/health` reports `runningAgents: 0`, asking every 15 s; every plxd has reported it since before this change. Any other host gets a failure that says how to fix it: on Linux `npx plx-connect setup --channel <channel>`, on macOS and Windows "Update Parallax on that computer".
- Success is reported when the host reconnects on a plxd at least that version, so a host that waits for its agents reports it later.
- A host that answered `restart: now`, or whose SSH install finished, fails if it reconnects on an older plxd or hasn't reconnected on the new one within 3 minutes. Retry while a host is updating does nothing, so one host never runs two updates.

### App: notifications

- Main broadcasts `parallax:hostUpdate` events; the bridge has `onHostUpdate` and `retryHostUpdate`.
- A failure is a sticky error notice, `Couldn't update plxd on <host>`, with the reason and Retry. Success is a brief `Updated plxd on <host>`. Both use the key `hostUpdate/<host>`, so each replaces the last (`useHostUpdateAlarms`).

### plx-connect

- Its Linux script writes `~/.local/bin/plxd.version`, so a plxd it installs reports its real version.

## Consequences

- A plxd from before this change (0.1.0 on a Connect device) can't take `host/update`. On a Linux device the user runs plx-connect once more; every update after that is automatic.
- A Mac whose own Parallax is older than this one gets `~/.parallax-plxd/plxd` and, with Connect on, its LaunchAgent moves there. That Mac's app moves it back once its own plxd is newer (`repointService`). A Mac without the LaunchAgent whose app started its plxd may have that app replace the new serve with its bundled one at its next launch; the app here tries once per launch and leaves it.
- An update stops the host's provider sessions and restarts plxd, but never while a turn is running. A turn that starts in the moment between the check and the restart is cut off, as with any plxd restart.
- Amended by PLX-746: Update everything sends `host/update` with `now`, which restarts at once and cuts off running turns after the user confirms; the host's `continueAfterRestart` then decides whether they go on. It goes through the main process (`updateHostNow`), so `host/update` stays withheld from the renderer.
- `host/update` downloads from GitHub on the host, so the host needs HTTPS access to github.com.
