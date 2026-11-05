# plx

Parallax's command line. `plx connect` sets a computer up for [Parallax](https://github.com/ryan-stoffel/parallax) Connect with one sign-in: it installs plxd with its login service, registers the computer with Parallax Relay under your Parallax account, and every device signed in to that account can reach it, with no Tailscale, sshd, keys, or open ports ([0091](../../docs/decisions/0091-connect-over-relay.md)).

It publishes as `plx-cli`, with a `plx` command, until the `plx` name on npm is Parallax's.

```sh
npx plx-cli connect --channel nightly
```

Parallax ships only nightlies for now. plx-cli 0.6.1 on npm still defaults to stable, so the command names the channel. In Windows PowerShell, use `npx.cmd`. On a computer without Node.js, use the commands in the Parallax app's Add a computer dialog, which bring it along.

Every download is checked against the SHA-256 its GitHub release reports, and plx refuses one that doesn't match or has none. plxd goes in `~/.parallax-plxd` (`%USERPROFILE%\.parallax-plxd` on Windows), and its login service runs it from there. On Linux, `~/.local/bin/plxd` links to it.

## Commands

| Command | What it does |
| --- | --- |
| `plx connect` | Signs in, installs plxd here, registers it with the relay, and turns on `relay` and `remote`. Once it's online it shows a 6-digit code. Parallax on your other computer asks for it, and once you type it there, plx says so and exits. |
| `plx connect add <ssh destination>` | The same on another computer over SSH, with the sign-in here. |
| `plx connect approve` | Approves a device waiting to sign in, once its code matches, or shows a new code to type on a device. |
| `plx connect status [--json]` | Prints the account, host id, relay state, and routes. See [Scripts](#scripts) for `--json`. |
| `plx connect unlink` | Turns the relay off here and keeps the registration, so the host id and webhook URLs stay. Signed-in devices keep their sessions until removed in Settings. |
| `plx connect remove` | Signs in again and removes this computer from your account. |
| `plx doctor` | Checks Parallax on this computer and hands what's left to your coding agent. See [Doctor](#doctor). |

Until the release after this one, the Tailscale commands stay: `plx devices [--json]`, `plx add <device>`, and `plx setup` ([0056](../../docs/decisions/0056-parallax-connect.md)).

Options:

- `--channel stable|nightly`: which release to install (default `nightly`). `plx connect` stops before sign-in when that release is older than Parallax Relay, and says what to run instead.
- `--no-browser`: sign in on any device, with a link and a short code printed here. This is automatic over SSH, on Linux without a display, and with no terminal.
- `--user <user>` and `--port <port>`: the SSH user and port for `add`.
- `--headless`: install plxd alone, without the app, for the Tailscale `add` and `setup`. `connect` always installs plxd alone.
- `--dry-run`: print the Tailscale steps and install script without installing anything.
- `--json`: print `plx devices` or `plx connect status` as JSON.
- `--agent claude|codex` and `--model <model>`: the agent `doctor` hands off to, without asking, and its model.

## Sign-in

`plx connect` uses the Parallax app's Clerk OAuth application. With a browser on this computer, sign-in uses PKCE and returns to a listener on 127.0.0.1. Otherwise plx uses Clerk's device authorization grant: it prints a link and a short code, you approve on any device, and plx carries on by itself. The code is useless without the device code plx holds. If the grant isn't available to the OAuth application, plx prints a link instead, and you paste the code `relay.parallax.codes/connect/code` shows, which works only with the verifier plx holds. The token goes to plxd once, to register, and nothing keeps it.

## Scripts

`plx connect`, `scripts/connect.sh`, and `scripts/connect.ps1` run with no terminal, which for plx means stdin isn't one. `connect.sh` with no terminal needs plx-cli 0.7.0 or newer on npm, and fails without it.

- No browser opens. plx prints the sign-in link on its own indented line, which works from any device.
- plx reads the code from stdin, one line per try, up to 3 tries. When input ends first, it says no code was entered and exits 1. `curl ... | sh` leaves nothing on stdin, so to pipe a code in, download `connect.sh` and run it with `sh connect.sh < codes`.
- Once the computer is online, plx prints one setup code and exits 0, rather than waiting for a device. plxd keeps the code for 10 minutes, and `plx connect approve` shows a new one.
- `plx connect approve` with a device waiting reads its answer from stdin too. When input ends first, it exits 1 and neither approves nor denies.

Read these from stdout, along with the exit code: 0 when it worked, 1 when it failed, and 2 for a bad command line.

| Line | Meaning |
| --- | --- |
| `  https://...` | The sign-in link. |
| `Paste the code it shows: ` | plx is waiting for a line on stdin. |
| `Setup code: 482911 (works until 2026-11-04T12:00:00Z). ...` | The code to type in Parallax on a signed-in device, and when it stops working. |

Lines starting with `→`, `✓`, or `✗` are progress for people. Their wording can change, and the symbols may not survive a Windows console's encoding, so don't test for them.

`plx connect status --json` prints one object, and these field names are stable. It exits 0 whenever plxd answered, connected or not. When plxd doesn't answer, stdout is empty, the reason goes to stderr, and it exits 1.

| Field | Type | Meaning |
| --- | --- | --- |
| `account` | string or null | The Parallax account's user id, or null when not signed in. |
| `hostId` | string | This computer's host id. |
| `relay.on` | boolean | The `relay` setting. |
| `relay.connected` | boolean | Whether plxd is connected to the relay. |
| `relay.problem` | string or null | Why it isn't connected, for people. |
| `remote.on` | boolean | The `remote` setting, Reach from anywhere. |
| `remote.listening` | boolean | Whether plxd's remote listener is bound. |
| `remote.problem` | string or null | Why it isn't listening, for people. |
| `routes` | string array | Where clients can reach this computer, best first. Empty unless it's listening. |
| `approvedDevices` | number | How many devices are approved. |
| `waitingDevice` | string or null | The name of a device waiting for approval. |

## Doctor

```sh
npx plx-cli doctor
```

It asks the running plxd for its version, health, and agents, then checks:

- plxd is installed, running, answering, and running the binary on disk, not one a self-update replaced.
- It's the newest release on its channel.
- The project store is ok and its writes aren't queuing.
- Each agent Parallax uses is installed and signed in.
- git is on PATH, the disk has room, and plxd's log has no errors from the last 24 hours.

For each failed check it can fix, it asks first: it starts plxd or runs an agent's own sign-in. Then it writes `context.md` (this computer's facts and the results) and `prompt.md` (the [playbook](src/doctor-playbook.md)) to `doctor/<time>/` in the data folder. It offers to open Claude Code or Codex on them, as T3 Code's `t3 triage` does. The agent asks what went wrong, reads the logs and the store, checks Parallax's source and issues, and helps you file an issue with the `via-doctor` template. It posts only after you approve the text. Without either agent, the doctor prints the two files' paths to paste into any agent.

## Requirements

- Node 20 or newer on the computer that runs plx, unless the Parallax app or Add a computer's command brings it.
- For `add`, SSH on the other computer: Remote Login on macOS, OpenSSH Server on Windows, or sshd on Linux. On macOS and Linux, SSH asks for the password at most once.
- Parallax builds for macOS on Apple silicon, Windows x64 and arm64, and Linux x64 and arm64.
- On Linux, plxd brings the bubblewrap and socat Claude Code's sandbox needs. Ubuntu 24.04 and later also need the distro's `bubblewrap` and the AppArmor profile from Claude Code's sandboxing docs. NixOS needs `programs.nix-ld.enable = true;` to run agent CLIs.
