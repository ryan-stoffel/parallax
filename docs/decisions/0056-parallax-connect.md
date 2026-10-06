# 0056: Parallax Connect reaches plxd over Tailscale

- Status: accepted
- Date: 2026-10-05
- Issue: PLX-574

## Context

An SSH host (0007, 0010) lets one app reach one plxd. Seeing every computer's threads from every computer that way takes an SSH host in every direction: sshd on every machine (Remote Login on a Mac, the OpenSSH Server feature on Windows), keys in every `authorized_keys` (Windows keeps an admin's in `C:\ProgramData\ssh\administrators_authorized_keys`), and Parallax and plxd installed by hand on each.

Ryan's computers are all on one Tailscale tailnet. Tailscale already encrypts traffic between them (WireGuard), and `tailscale whois <ip:port>` names the node and the Tailscale user behind any tailnet address. `tailscale status --json` lists the tailnet's nodes, each with its stable `ID`, `HostName`, `OS`, `TailscaleIPs`, `Online`, and `UserID`, and `Self` for this node. Tagged nodes and nodes shared from another tailnet have other users.

## Decision

### Transport

- A host setting, `connect`, off by default. While it is on, plxd listens on TCP port 7340 on its own Tailscale IPv4, and nowhere else. It checks every 10 s, and at once when `host/settings/set` changes `connect`, so a Tailscale that starts late, a new address, or the setting turning off binds or closes the listener.
- Each accepted connection is checked before plxd reads from it. plxd runs `tailscale whois --json <peer ip:port>` and serves the connection only when the peer's user is this node's own user (`UserProfile.ID` equals `Self.UserID`), the peer has no tags, this node has no tags, and the peer isn't this node's own address. Every tagged node shares one user, `tagged-devices`, so the user check alone would let one tagged node into another. Anything else is closed, and logged.
- At most 8 connections wait on `whois` at once, and at most 2 from one peer address. Any more are closed at once, so a refused node can't make plxd start processes without limit or take every slot.
- When the listener stops (`connect` turned off, a new address, Tailscale stopped, or this node's user or tags changed at the same address), every connection it accepted closes too. Local connections stay.
- An accepted connection speaks 0007's protocol as a local socket connection does, with the same limits.
- `plxd dial <addr>` connects to `addr` (an IP, with port 7340 unless one is given) and bridges stdio to it, byte for byte, as `attach` bridges the socket. It exits 4 when it never connects, like attach. The app runs it as a host's connection command, so `Connection` is the same for every transport.
- `plxd connect on|off` sets the setting in the store, for an install script with no connection to plxd. A running plxd sees it within 10 s.
- `connect/devices` lists the tailnet's untagged nodes of this node's user, and this node, with whether each answers on port 7340. A tagged node lists only itself.

### Device names and icons

A Connect device's nickname and icon are host settings, `deviceName` and `deviceIcon` (`laptop`, `desktop`, `mini`, or `server`), on that device's own plxd, so every computer shows the same. Unset, the app derives both from the host name: `mini` is a mini PC, `desktop`, `pc`, or `tower` a PC, `server` a server, and `laptop`, `book`, `thinkpad`, or anything else a laptop.

### The app

- Settings > Connections has a Parallax Connect section. Install runs `npm install -g plx-connect` on this computer, as an agent's install does (PLX-558). Then a toggle sets the local plxd's `connect`, and turning it on opens the Add computer wizard.
- While the local plxd's `connect` is on, the app asks it for `connect/devices` every 15 s and keeps a connection, with id `tailnet:<node ID>`, to every other device that answers. A device stays listed, retrying, after it goes offline. So a computer set up from another one connects to all of them without its own wizard.
- Each device's switch in Settings says whether this app uses it; off drops its connection and its threads here. Remove takes it off this app's list until Add computer adds it again. Neither changes anything on the device.
- A Connect device's terminals, installs, and sign-ins go over ssh to its Tailscale IP, as SSH hosts' do.
- Sidebar thread rows show their device's icon next to the provider logo when there is more than one host.

### plx-connect

`plx-connect` is an npm package, run with `npx plx-connect` or installed by the app. It needs Node only on the computer that runs it.

- `plx-connect devices` lists the user's tailnet devices.
- `plx-connect add <device>` runs `ssh` to the device's Tailscale IP (`StrictHostKeyChecking=accept-new`, since the tailnet already authenticates the node; one connection multiplexed with `ControlMaster` where the local ssh supports it, so a password is asked at most once). It finds the OS, arch, and details, installs the newest Parallax of the given channel from GitHub Releases, installs plxd's login service, runs `plxd connect on`, opens port 7340 in Windows' firewall when it can, and installs `plx-connect` there when npm is there. It then waits for port 7340 to answer.
- `plx-connect setup` does the same on this computer, for a device that can't take SSH.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| SSH hosts in every direction, with plx-connect copying keys | Needs sshd and admin rights on every computer, including the laptop, and Windows' admin key file. Every new computer edits every other one. |
| Tailscale SSH | Its server runs only on Linux and on the open-source macOS client, not on Windows or the App Store Mac app. |
| A token per device instead of `whois` | Another secret to store and copy to every computer. Tailscale already proves which node and user is on the other end. |
| Listening on every interface | The LAN and the internet would reach plxd. Binding only the Tailscale address keeps it on the tailnet. |
| plx-connect discovering devices for the app | A computer set up remotely may have no Node, so it couldn't find the others. plxd is on every Connect device. |

## Consequences

- Only the first install needs SSH to the target, and only from the computer that adds it. After that, nothing needs sshd.
- A shared or multi-user computer: any process on the tailnet's other nodes of the same Tailscale user can reach plxd while `connect` is on. The node's own address is refused, so another OS user on the same computer can't.
- Tagged nodes can't join. A tailnet where Ryan's servers are tagged needs them untagged, or a later rule for tags.
- Windows has no plxd login service yet ([PLX-576](https://linear.app/ryanstoffel/issue/PLX-576)), so plx-connect starts plxd with `attach`, which breaks away from the SSH session, and a Windows device is unreachable after a restart until Parallax opens there.
- The Linux install needs the release's AppImage, which plx-connect unpacks for plxd. A release without a Linux build can't set up Linux, which is every nightly today ([PLX-575](https://linear.app/ryanstoffel/issue/PLX-575)).
- Publishing `plx-connect` to npm needs Ryan's npm account.
