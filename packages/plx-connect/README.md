# plx-connect

Sets up [Parallax](https://github.com/ryan-stoffel/parallax) on your computers and connects them with Parallax Connect, over Tailscale. It installs the newest Parallax from GitHub Releases, turns Connect on, and keeps plxd running, so every computer's Parallax sees every other one's threads.

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

Options:

- `--channel stable|nightly`: which release to install (default `stable`).
- `--user <user>` and `--port <port>`: the SSH user and port for `add`.
- `--dry-run`: print the steps and the install script without installing anything.

## Requirements

- Node 20 or newer on the computer that runs plx-connect.
- Tailscale on both computers, logged in as the same Tailscale user. Tagged and shared devices can't join.
- For `add`, SSH on the device: Remote Login on macOS, OpenSSH Server on Windows, or sshd on Linux. On macOS and Linux, SSH asks for the password at most once.
- Parallax builds for macOS on Apple silicon, Windows x64 and arm64, and Linux x64 and arm64.
- On Linux, Claude Code's sandbox needs bubblewrap and socat. plx-connect installs them when it can do so without a password: with `nix profile install` on NixOS, or with the package manager as root or with passwordless sudo. Otherwise it prints what to install. NixOS also needs `programs.nix-ld.enable = true;` to run agent CLIs.
