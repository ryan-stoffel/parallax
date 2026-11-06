# Parallax Connect user guide

[Install command](README.md) · [Troubleshooting](troubleshooting.md)

In this guide, `plx` means `npx plx-cli`, or `npx.cmd plx-cli` in Windows PowerShell. For example, `plx connect status` is `npx plx-cli connect status`. npx can reuse an old copy, and `npx -y plx-cli@latest connect` always gets the newest.

## How it works

Each computer runs `plxd`, which keeps one outgoing connection to Parallax Relay (`relay.parallax.codes`). Your account lists your computers, so a signed-in device finds them without a pairing step.

A device tries these routes to reach a computer:

1. The computer's LAN addresses, and its Tailscale address if it has one.
2. The relay, 200 ms later if none of those has answered.

While on the relay, a device checks the direct routes again every minute and moves over when one answers.

Every route is TLS from your device to `plxd`, pinned to that computer's key. The relay passes only encrypted traffic, so it can't read your threads.

## Add a computer

Start from a device that's already signed in, if you have one. In the desktop app, go to Settings > Connections > Add computer. On the phone, go to Settings > Connections > Add computer.

**In a terminal.** Add computer shows a command for macOS or Linux and one for Windows. Run it on the new computer. It needs nothing installed. It names the device you copied it from, so Allow on that device is all it takes.

**With the app.** On the new computer, install Parallax, sign in to the same account, and choose Show setup code in Settings > Connections. Allow the code on both computers, or type it on the device you're adding from.

**With `npx plx-cli connect`.** This command doesn't name a device, so it takes two steps: Allow on your device, then Enter in the terminal. Press `n` to deny. Compare the code on both screens first.

**By typing a code.** The terminal also prints a 6-digit setup code. Choose Type a code instead on your device and enter it. This works with all of the above, and it's the way in when no device can Allow. A code lasts 10 minutes and works once. A device gets 5 tries an hour per computer. `plx connect approve` shows a new code.

**Over SSH from this computer.** `plx connect add <ssh destination>` runs the same setup on another computer, with the sign-in here. `--user <user>` and `--port <port>` set the SSH user and port. It uses SSH only that once.

**From a script.** With no terminal on stdin, plx prints one line starting `Setup code:` and exits 0. See [Scripts in plx's README](../../packages/plx/README.md#scripts).

### Signing in

With a browser on the computer, plx opens it and you sign in there.

Over SSH, without a display, or with `--no-browser`, plx prints a link and a short code. Open the link on any device, sign in, and allow the computer. plx continues by itself.

If that flow isn't available, plx prints a link alone. Sign in there, then paste the code the page shows when plx asks.

plx gives its sign-in to `plxd` once to register the computer, and nothing keeps it.

### Releases

plx installs the newest nightly. `--channel stable` asks for a stable release, and Parallax has none yet.

## Add a phone or another device

Sign in to the same account. The device asks the first computer that answers, and a device that already uses that computer shows Allow with a code. Check that both show the same code, then allow it. One Allow covers all your computers.

With no other device at hand, run `plx connect approve` on one of your computers. It shows the waiting request's code. Enter approves and `n` denies. A request lasts 10 minutes. A denied or lapsed request doesn't try again until you choose Ask again.

Pairing with a code still works for a computer that isn't on your account, or on a LAN with no internet. Use Pair a device and Pair computer in Settings > Connections.

## Routes

You can add a direct address to a computer and change the order of its routes. Both stay on that device and don't sync.

- Desktop: Settings > Connections, the computer's menu, Routes.
- Phone: Settings > Connections, the computer's page, Routes.

An added route is an IP address or DNS name, with a port if it isn't 7341. The phone takes only IP addresses and `.local` names. The relay can move in the list, but you can't remove it. Only a route you added can be removed.

`plxd` closes any connection from outside a private network. So a port forward works only when the client arrives from a private address, as over a VPN.

## When the connection drops

Streams already open stay up when `plxd` loses its connection to the relay, and `plxd` reconnects by itself. After a computer wakes or changes network, `plxd` notices within about 5 seconds and reconnects. When `plxd`'s end of a stream is gone, the relay closes the stream, so your device reconnects right away rather than waiting to notice.

Updating the relay ends every stream, and apps reconnect by themselves.

If the relay or Clerk, the sign-in service, is down, the app says so. Computers on the same network keep working.

## Limits

| Limit | Value |
| --- | --- |
| Computers on an account | 10. Phones and browsers don't count |
| Open streams per computer | 16 |
| New streams per computer | 30 a minute |
| Traffic through the relay per computer | 2 GiB a day, resetting at 00:00 UTC |
| Waiting device requests per computer | 1 at a time, 5 an hour |

The apps warn at 80% of the daily traffic limit. LAN and Tailscale traffic doesn't count toward it.

## Read-only devices

A device has full access or is read-only. A read-only device can read threads, their files and diffs, and pull requests. It can't start or message agents, approve anything, open a terminal, change settings, or manage devices.

To mark a device, choose Make read-only beside it in Settings > Connections on the desktop, or Read-only on a computer's page on the phone. Its connections close and come back read-only, and the mark spreads to your other computers.

You can't undo this for that device's key. To get full access back, choose Start over with a new key on that device, in Settings > Connections. That device then asks as a new device, and you have to allow it.

Read-only limits that key only. It doesn't limit Tailscale on port 7340, `plxd attach` over SSH, or a shell on the computer.

## Remove a computer or a device

**A computer.** In Settings > Connections, open the computer's menu and choose Remove. It leaves your account and your devices stop reaching it. You can't remove the computer you're on from its own app. To do that, run `plx connect remove` there, which signs in again. To add a computer back, run the setup on it again.

**A device.** Choose Revoke beside it in Settings > Connections. Your computer signs a removal and the relay passes it to your other online computers, which end that device's sessions right away. A computer that's offline catches up when one of your devices next reaches it, and until then the session there still works. A removed key can't come back. That device can choose Start over with a new key, and you have to allow it again.

**Stop using the relay but stay registered.** `plx connect unlink` turns the relay off on that computer and keeps its id and webhook URLs. Devices already signed in keep their sessions until you remove them. Run `plx connect` to turn it back on. With the relay off, the computer gets no webhooks or phone notifications. The relay holds webhooks for up to 24 hours.

## Tailscale

Tailscale is optional. A computer with Tailscale reports its address as one more direct route, and a desktop on the same tailnet uses it with no relay traffic. The phone doesn't use Tailscale. The Tailscale switch in Settings > Connections also finds computers on your tailnet, and `plx devices`, `plx add <device>`, and `plx setup` keep working until a later release removes that path.

## Proxies

`plxd` uses `https_proxy` or `HTTPS_PROXY` to reach the relay and Clerk, unless `no_proxy` or `NO_PROXY` names the host. It takes an `http://` proxy only. These limits apply:

- A background service doesn't get your shell's setting on macOS or Linux.
- plx's own requests ignore the proxy.
- A proxy limited to TLS 1.2 fails.
- Behind a proxy that inspects TLS, the computer refuses new account sign-ins until Clerk's host is exempt from inspection. Existing sessions and pairing with a code still work.

## Check a connection

- `plx connect status` prints the account, host id, relay state, and routes, then opens a real stream through the relay back to the computer. Each run spends one of its 30 new streams a minute. `--json` prints the same as one object.
- Check connection in Settings > Connections does the same, and also checks your sign-in. Copy diagnostics copies a report with no token or user id in it, for a bug report.
- `npx plx-cli doctor` checks Parallax on this computer. It can fix some problems and hand the rest to Claude Code or Codex. In the app, it's Diagnose a problem in the command menu.

Older copies of plx, including plx-cli 0.7.0 on npm, print no connection check. Older apps have no Check connection.

## plx commands

| Command | What it does |
| --- | --- |
| `plx connect` | Signs in, installs `plxd` here, and connects this computer to your account |
| `plx connect add <ssh destination>` | The same on another computer over SSH |
| `plx connect approve` | Approves a waiting device, or shows a new code to type |
| `plx connect status [--json]` | Shows this computer's state and checks a real stream through the relay |
| `plx connect unlink` | Turns the relay off here and keeps the registration |
| `plx connect remove` | Signs in again and removes this computer from your account |
| `plx doctor` | Checks Parallax on this computer |

`plx --help` lists every option.
