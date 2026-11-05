# Parallax Connect

Parallax Connect lets every device signed in to your Parallax account use your computers, wherever they are. It needs no Tailscale, sshd, SSH keys, or open ports.

Run this on the computer you want to add. It needs Node.js 20 or newer:

```sh
npx plx-cli connect
```

In Windows PowerShell, use `npx.cmd plx-cli connect`.

With no Node.js on the computer, these commands bring it along.

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts/connect.sh | sh -s -- --channel nightly
```

Windows:

```powershell
powershell -c "irm https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts/connect.ps1 | iex; Connect-Parallax --channel nightly"
```

The command signs you in, installs `plxd`, the Parallax daemon, with its background service, and connects the computer to your account. Then it shows a 6-digit code. Parallax on your other device shows the same code, and you allow it there. `npx plx-cli connect` typed by hand also needs Enter in its terminal. The command from Add computer names your device, so Allow there is enough.

## Docs

- [User guide](guide.md): adding computers and devices, routes, limits, and removing them.
- [Troubleshooting](troubleshooting.md): every error, what it means, and what to do, and where the logs are.

## What's available

- The desktop app for macOS (Apple silicon), Windows, and Linux, from the [install steps](../../README.md#install) or the [releases page](https://github.com/ryan-stoffel/parallax/releases).
- Nightly builds only. Parallax has no stable release yet.
- An iOS app, whose source is in [`apps/mobile`](../../apps/mobile). It isn't on the App Store, and there's no Play Store or Android release.
- No hosted browser client. A browser can only use the app your own `plxd` serves on your network, with Open in a browser in Settings > Connections.
