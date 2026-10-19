# plx-connect

Sets up [Parallax](https://github.com/ryan-stoffel/parallax) on your computers and connects them with Parallax Connect, over Tailscale. It installs the newest Parallax from GitHub Releases, or plxd alone with `--headless` (always on Linux), turns Connect on, and keeps plxd running, so every computer's Parallax sees every other one's threads.

Every download is checked against the SHA-256 its GitHub release reports, and plx-connect refuses one that doesn't match or has none. plxd goes in `~/.parallax-plxd` (`%USERPROFILE%\.parallax-plxd` on Windows), and its login service runs it from there. On Linux, `~/.local/bin/plxd` links to it.

The Parallax app has plx-connect inside it, so Add computer in Settings needs no Node.

```sh
npx plx-connect
```

## Commands

| Command | What it does |
| --- | --- |
| `plx-connect` | Lists your online devices that aren't on Parallax yet, asks for one, and adds it. |
| `plx-connect devices [--json]` | Lists your devices on your tailnet, and whether each answers on Parallax Connect's port, 7340. |
| `plx-connect add <device>` | Installs Parallax on a device over SSH and connects it. `<device>` is a host name, MagicDNS name, or Tailscale IP. |
| `plx-connect setup` | Installs Parallax on this computer and connects it, for a device that can't take SSH. |
| `plx-connect doctor` | Checks Parallax on this computer and hands what's left to your coding agent. See [Doctor](#doctor). |

Options:

- `--channel stable|nightly`: which release to install (default `stable`).
- `--user <user>` and `--port <port>`: the SSH user and port for `add`.
- `--headless`: install plxd alone, without the app, for `add` and `setup`. Linux always gets plxd alone.
- `--dry-run`: print the steps and the install script without installing anything.
- `--agent claude|codex` and `--model <model>`: the agent `doctor` hands off to, without asking, and its model.

## Doctor

```sh
npx plx-connect doctor
```

It asks the running plxd for its version, health, and agents, then checks:

- plxd is installed, running, answering, and running the binary on disk, not one a self-update replaced.
- It's the newest release on its channel.
- The project store is ok and its writes aren't queuing.
- Each agent Parallax uses is installed and signed in.
- git is on PATH, the disk has room, and plxd's log has no errors from the last 24 hours.
- On Linux, bubblewrap and socat, which Claude Code's worker sandbox needs.

For each failed check it can fix, it asks first: it starts plxd, runs an agent's own sign-in, or installs the sandbox packages. Then it writes `context.md` (this computer's facts and the results) and `prompt.md` (the [playbook](src/doctor-playbook.md)) to `doctor/<time>/` in the data folder. It offers to open Claude Code or Codex on them, as T3 Code's `t3 triage` does. The agent asks what went wrong, reads the logs and the store, checks Parallax's source and issues, and helps you file an issue with the `via-doctor` template. It posts only after you approve the text. Without either agent, the doctor prints the two files' paths to paste into any agent.

## Requirements

- Node 20 or newer on the computer that runs plx-connect, unless the Parallax app runs it.
- Tailscale on both computers, logged in as the same Tailscale user. Tagged and shared devices can't join.
- For `add`, SSH on the device: Remote Login on macOS, OpenSSH Server on Windows, or sshd on Linux. On macOS and Linux, SSH asks for the password at most once.
- Parallax builds for macOS on Apple silicon, Windows x64 and arm64, and Linux x64 and arm64.
- On Linux, Claude Code's sandbox needs bubblewrap and socat. plx-connect installs them when it can do so without a password: with `nix profile install` on NixOS, or with the package manager as root or with passwordless sudo. Otherwise it prints what to install. NixOS also needs `programs.nix-ld.enable = true;` to run agent CLIs.
