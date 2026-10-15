# 0072: A Connect computer keeps one plxd per user running at `~/.parallax-plxd`, restarted after any exit and kept current

- Status: accepted; amends [0023](0023-cross-platform.md) (the services), [0053](0053-cursor-sdk.md) and [0061](0061-claude-agent-sdk.md) (where the sidecars' files come from), [0056](0056-parallax-connect.md) (plx-connect and the app's handover), and [0066](0066-update-connected-hosts.md) (where plxd runs from, and Windows)
- Date: 2026-10-15
- Issue: PLX-818, for PLX-576, PLX-820, PLX-821, PLX-823, PLX-824, and PLX-825

## Context

Ryan wants Parallax Connect to be set and forget: a computer added once stays reachable through reboots, crashes, app updates, and plxd updates, and every computer is kept up to date. Headless computers should be able to run plxd without the app. An audit on 2026-10-15 found that only a packaged Mac app that finished its LaunchAgent handover (PLX-631) came close:

- Since PLX-646, plxd finds the Claude and Cursor sidecars' files beside itself, and only the app bundle ships them. plx-connect's Linux plxd, an SSH host's, and a Mac's after `host/update` refuse Claude and Cursor threads.
- The systemd unit is `Restart=on-failure` with systemd's default start limits, so five quick failures leave it `failed` for good. A clean exit isn't restarted there or by the LaunchAgent (`KeepAlive.SuccessfulExit=false`). Only plx-connect turns on lingering. A bootstrap that fails right after a bootout leaves no job.
- Windows has no service. An app update applied at quit kills plxd, and nothing starts it again until Parallax opens. `host/update` refuses on Windows.
- The app hands plxd to its service only on macOS, points it at the app bundle, gives up on a failed handover until its next launch, never revives a device connection that stopped retrying, and drops every device connection when the local plxd's `host/settings/get` fails.
- The app runs the `plx-connect` npm installed globally, which needs Node and drifts from the app's version. Nothing checks what plx-connect downloads, and it always installs the full app on macOS and Windows.

## Decision

### One plxd per user, at `~/.parallax-plxd`

- On every OS, plxd's login service runs `~/.parallax-plxd/plxd` (`%USERPROFILE%\.parallax-plxd\plxd.exe` on Windows), with `plxd.version` beside it. That's already the layout of the SSH install (PLX-642), `host/update` (0066), and `LOCATE_PLXD`. It no longer runs from an app bundle or an AppImage mount. A service that still runs plx-connect's old `~/.local/bin/plxd` keeps working, and `host/update` still updates that file in place, until the app, the SSH install, or plx-connect moves the service to the copy.
- Whoever installs or updates plxd writes that copy: the app, plx-connect, the SSH install, and `host/update`. The app and `host/update` write a temp file in the same folder and rename it into place, plxd first and then `plxd.version`, as 0066 does, and never replace a newer copy with an older one. plx-connect installs the release it picked, as it always has. On Windows, a running `plxd.exe` is renamed aside before the new one moves in, and the leftover is deleted at the next start.
- On Linux, plx-connect also links `~/.local/bin/plxd` to the copy, so `plxd` stays on `PATH` and existing services move to it.

### Every plxd carries its sidecars

- plxd embeds each sidecar's `package.json`, `package-lock.json`, and non-test `src/*.mjs` with `include_bytes!`, about 90 KB. The SDK still installs on first use into `<data>/tools/<dir>/<version>/` with `npm ci`, from the embedded manifest and lockfile, and the embedded `src/` is synced into it before each start. The app bundle no longer ships the sidecar folders. A test fails when a sidecar gains a source file that isn't embedded.

### The service restarts plxd after any exit

- systemd: `Restart=always`, `RestartSec=5`, and `StartLimitIntervalSec=0`, so the unit never enters `failed` from start limits. `systemctl --user stop` and `service uninstall` still stop it. `plxd service install` turns on lingering for the user when it's off, so plxd starts at boot and outlives logout. If it can't, it warns and still installs.
- launchd: `KeepAlive` true, under launchd's throttle. A `bootstrap` that fails right after `bootout` is retried for up to 10 seconds.
- Windows (PLX-576): a per-user scheduled task, registered from XML with `schtasks /create /xml`, which needs no admin rights. It has a logon trigger for the user that repeats every 5 minutes with no end, and `MultipleInstancesPolicy` `IgnoreNew`, so a running plxd ignores the repeats and one that exited is started again within 5 minutes. It runs as `InteractiveToken` with `LeastPrivilege`, has no execution time limit (the default of 72 hours would end plxd), runs on battery, has `RestartOnFailure`, and runs at normal priority. Its action is `conhost.exe --headless "<plxd.exe>" serve`, so no console window opens. ConPTY has run that itself since Windows 10 1809. `plxd attach` starts the task with `schtasks /run`, and starts `serve` itself when that fails. `service status` prints the same `key: value` lines as on the other OSes.
- Every path where plxd exits 0 on purpose either goes through the service manager (`service install --replace`, `service uninstall`), or happens without a service installed.

### The app keeps the copy current and its devices connected

- While Connect is on, a packaged app without `PLXD_PATH` refreshes `~/.parallax-plxd/plxd` from its own plxd when the copy is missing or older. It runs `<copy> service install --replace` only while `host/health` reports no running agents, and otherwise tries again at the next discovery. This holds on every OS where `plxd service status` works, and a plxd without the subcommand is skipped quietly. At launch, a service that's installed is refreshed and replaced from the copy, never from the bundle. This replaces PLX-631's bundle-pointing handover, 0066's `repointService` moves between the bundle and `~/.parallax-plxd`, and the exception for a translocated Mac app.
- A failed step is tried again at later discoveries, backing off to at most once every 5 minutes, and logged each time. Nothing waits for the next launch. A replace that times out at launch leaves the local connection retrying.
- Discovery drops and re-adds a device connection that has stopped retrying, such as one refused as `incompatibleProtocol` after an update. Only a definite `host/settings/get` answer changes the local `connect`; an error or timeout keeps the devices. The app reads the local `connect` every 15 seconds, whether it's on or off, so `plxd connect on|off` run outside the app is followed within 15 seconds.

### plx-connect

- The app ships `packages/plx-connect` in its resources and runs it with its own Electron as Node (`ELECTRON_RUN_AS_NODE`), so Add computer needs no Node or npm here and always matches the app. Settings' Install plx-connect step goes away. `npx plx-connect` still works for a computer without the app.
- `add` and `setup` take `--headless`, which installs plxd alone without the app on macOS and Windows. Linux always does that. Releases attach `parallax-plxd-<v>-win-<arch>.exe` with its `.sha256`, beside the macOS and Linux plxd. The Add computer wizard has a Headless switch, which is on and fixed for Linux.
- Every download is checked against the SHA-256 that GitHub's release API reports for the asset (`digest`), else against its `.sha256` asset. A mismatch, or a missing checksum, refuses the install.
- On Windows, the script installs the logon task, and falls back to `attach` with a warning for a plxd that has no task.

### `host/update` on Windows (PLX-825)

- `host/update` on Windows downloads `parallax-plxd-<v>-win-<arch>.exe`, checks it, installs it as above, and hands over through the logon task, or starts `serve` detached when there's none. It no longer refuses.

## Consequences

- A Connect computer comes back on its own after a crash, a `kill`, a logout (Linux), a reboot, an app update, and a plxd update.
- The app on a computer no longer owns where its service's plxd lives. Two installs, such as a stable and a nightly app, share one copy and move it only forward, so they don't trade it back and forth.
- An app update that changes plxd waits to restart the service until no agents are running, so the old plxd can run for a while after an update. `hostUpdate`'s check that the local plxd matches the app's version waits with it.
- A LaunchAgent starts only once the user logs in to the Mac, and a Windows logon task once the user signs in, as before. Starting at boot with nobody logged in would need a LaunchDaemon and root, which this record doesn't do.
- Publishing plx-connect 0.3.0 to npm, for `npx`, is Ryan's.
