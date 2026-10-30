# plx

Parallax's command line. `plx connect` sets a computer up for [Parallax](https://github.com/ryan-stoffel/parallax) Connect with one sign-in: it installs plxd with its login service, registers the computer with Parallax Relay under your Parallax account, and every device signed in to that account can reach it, with no Tailscale, sshd, keys, or open ports ([0091](../../docs/decisions/0091-connect-over-relay.md)).

It publishes as `plx-cli`, with a `plx` command, until the `plx` name on npm is Parallax's.

```sh
npx plx-cli connect
```

Every download is checked against the SHA-256 its GitHub release reports, and plx refuses one that doesn't match or has none. plxd goes in `~/.parallax-plxd` (`%USERPROFILE%\.parallax-plxd` on Windows), and its login service runs it from there. On Linux, `~/.local/bin/plxd` links to it.

## Commands

| Command | What it does |
| --- | --- |
| `plx connect` | Signs in, installs plxd here, registers it with the relay, and turns on `relay` and `remote`. Once it's online it shows a 6-digit code: type it on a signed-in device when that device opens this computer, and plx prints the device's name. |
| `plx connect add <ssh destination>` | The same on another computer over SSH, with the sign-in here. |
| `plx connect approve` | Approves a device waiting to sign in, once its code matches, or shows a new code to type on a device. |
| `plx connect status` | Prints the account, host id, relay state, and routes. |
| `plx connect unlink` | Turns the relay off here and keeps the registration, so the host id and webhook URLs stay. Signed-in devices keep their sessions until removed in Settings. |
| `plx connect remove` | Signs in again and removes this computer from your account. |
| `plx doctor` | Checks Parallax on this computer and hands what's left to your coding agent. See [Doctor](#doctor). |

Until the release after this one, the Tailscale commands stay: `plx devices [--json]`, `plx add <device>`, and `plx setup` ([0056](../../docs/decisions/0056-parallax-connect.md)).

Options:

- `--channel stable|nightly`: which release to install (default `stable`).
- `--no-browser`: sign in on any device and paste the code here. This is automatic over SSH and on Linux without a display.
- `--user <user>` and `--port <port>`: the SSH user and port for `add`.
- `--headless`: install plxd alone, without the app, for the Tailscale `add` and `setup`. `connect` always installs plxd alone.
- `--dry-run`: print the Tailscale steps and install script without installing anything.
- `--agent claude|codex` and `--model <model>`: the agent `doctor` hands off to, without asking, and its model.

## Sign-in

`plx connect` uses the Parallax app's Clerk OAuth application, with PKCE. With a browser on this computer, sign-in returns to a listener on 127.0.0.1. Otherwise plx prints a link: open it on any device, sign in, and paste the code `relay.parallax.codes/connect/code` shows. The code works only with the verifier plx holds. The token goes to plxd once, to register, and nothing keeps it.

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

- Node 20 or newer on the computer that runs plx, unless the Parallax app runs it.
- For `add`, SSH on the other computer: Remote Login on macOS, OpenSSH Server on Windows, or sshd on Linux. On macOS and Linux, SSH asks for the password at most once.
- Parallax builds for macOS on Apple silicon, Windows x64 and arm64, and Linux x64 and arm64.
- On Linux, plxd brings the bubblewrap and socat Claude Code's sandbox needs. Ubuntu 24.04 and later also need the distro's `bubblewrap` and the AppArmor profile from Claude Code's sandboxing docs. NixOS needs `programs.nix-ld.enable = true;` to run agent CLIs.
