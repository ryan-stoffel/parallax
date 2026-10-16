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
| `plx-connect doctor` | Checks Parallax on this computer: plxd is installed, up to date, and running, Claude Code's sandbox packages on Linux, and an agent CLI on PATH. It offers a fix for each failed check it can fix, then offers to open Claude Code with the results to look into the problem and help you file an issue. Without Claude Code, it prints the prompt to paste into any agent. |

Options:

- `--channel stable|nightly`: which release to install (default `stable`).
- `--user <user>` and `--port <port>`: the SSH user and port for `add`.
- `--headless`: install plxd alone, without the app, for `add` and `setup`. Linux always gets plxd alone.
- `--dry-run`: print the steps and the install script without installing anything.

## Requirements

- Node 20 or newer on the computer that runs plx-connect, unless the Parallax app runs it.
- Tailscale on both computers, logged in as the same Tailscale user. Tagged and shared devices can't join.
- For `add`, SSH on the device: Remote Login on macOS, OpenSSH Server on Windows, or sshd on Linux. On macOS and Linux, SSH asks for the password at most once.
- Parallax builds for macOS on Apple silicon, Windows x64 and arm64, and Linux x64 and arm64.
- On Linux, Claude Code's sandbox needs bubblewrap and socat. plx-connect installs them when it can do so without a password: with `nix profile install` on NixOS, or with the package manager as root or with passwordless sudo. Otherwise it prints what to install. NixOS also needs `programs.nix-ld.enable = true;` to run agent CLIs.
