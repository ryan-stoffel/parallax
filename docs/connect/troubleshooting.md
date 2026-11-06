# Parallax Connect troubleshooting

[Install command](README.md) · [User guide](guide.md)

Start here:

1. Run `npx plx-cli connect status` on the computer you can't reach, or choose Check connection in Settings > Connections there. Both name the first part that failed.
2. Find the message below. `<reason>` stands for text that varies.
3. If it isn't here, run `npx plx-cli doctor`, then check [the logs](#logs).

In Windows PowerShell, use `npx.cmd` for `npx`.

## Connection check

Each result names a part: `signIn`, `relay`, `listener`, or `stream` in `check.failed` in `plx connect status --json`.

- `plx connect status` has a `Connection check` row that says `failed at the relay: <message>`, then a `What to do` row with the advice below.
- Settings prints `Relay failed. <message> <advice>`.

`plx connect status` has no token, so the first three messages under Sign-in appear only in Settings.

### Sign-in (`signIn`)

| Message | What to do |
| --- | --- |
| `The relay didn't accept this sign-in.` | Sign in again from Profile in the sidebar. |
| `The relay can't reach Clerk to check this sign-in.` | Clerk, the sign-in service, is out of reach. Try again in a few minutes. |
| `This computer isn't on the account you're signed in to.` | Run `npx plx-cli connect` on this computer, or turn Reach from anywhere off and on in Settings, to register it. |
| `The relay doesn't know this computer.` | Run `npx plx-cli connect` on this computer, or turn Reach from anywhere off and on in Settings, to register it. |

### Relay (`relay`)

| Message | What to do |
| --- | --- |
| `This computer's connection to the relay is off.` | Turn on Reach from anywhere in Settings, or run `npx plx-cli connect`. |
| `plxd can't read its host key: <reason>` | Run `npx plx-cli connect` on this computer, or turn Reach from anywhere off and on in Settings. |
| `The relay is limiting this account's requests for now.` | Wait a minute, then check again. |
| `The relay answered <status>.` | Check this computer's internet connection and clock, then check again. If both are fine, the relay may be down, so try again in a few minutes. |
| `Parallax couldn't reach the relay: <reason>` | The same. Also check any proxy or firewall for `relay.parallax.codes`. See [Proxies](guide.md#proxies). |
| `Parallax couldn't reach the relay: this computer's clock is too far off the relay's; set it to the right time` | Set the computer's clock to the right time. |
| `The relay didn't answer in time.` | Check the internet connection and clock, then check again. |
| `plxd isn't connected to the relay.` | Check the internet connection and clock, then check again. |
| `The relay stopped answering over plxd's connection.` | Check the internet connection and clock, then check again. |
| `The relay is too old to run this check.` | The relay needs updating, which only its owner can do. Your connection may still work. Check again after that. |

### Listener (`listener`)

The relay's streams end at `plxd`'s listener on this computer, TCP port 7341.

| Message | What to do |
| --- | --- |
| `This computer's listener is off, so a stream has nowhere to go.` | Turn on Pair computers on this network in Settings, or run `npx plx-cli connect`. |
| `plxd isn't listening yet.` | Check again. If it keeps failing, quit whatever else uses this port, or restart Parallax. |
| `Port 7341 is in use by another program.` | Quit that program. `lsof -i :7341` finds it on macOS and Linux. |
| `Parallax couldn't listen on port 7341: <reason>` | Check again. If it keeps failing, restart Parallax. |
| `Another program answers on plxd's port, with a different key.` | Quit that program, or restart Parallax. |
| `plxd's listener didn't answer: <reason>` | Check again. If it keeps failing, restart Parallax. |
| `plxd's listener didn't answer in time.` | Check again. If it keeps failing, restart Parallax. |

### Stream (`stream`)

| Message | What to do |
| --- | --- |
| `The relay refused a new stream: this computer opened 30 this minute.` | Wait a minute, then check again. |
| `This computer used its 2 GiB through the relay for today.` | Streams come back at midnight UTC. Computers on the same network still connect directly. |
| `The relay refused the stream: this computer has 16 open, or this network made too many requests this minute.` | Close a connection or wait a minute, then check again. |
| `The relay refused a new stream.` | Check again. If it keeps failing, check that no firewall or proxy here blocks WebSockets to the relay, then restart Parallax. |
| `The relay refused the stream with HTTP <status>.` | The same. |
| `Parallax couldn't reach the relay: <reason>` | The same. |
| `The relay didn't open the stream in time.` | The same. |
| `The relay opened a stream, but this computer's plxd didn't join it.` | The same. |
| `The stream opened, but no answer came back: <reason>` | The same. |
| `The stream opened, but no answer came back in time.` | The same. |
| `A different key answered inside the stream, so nothing was sent through it.` | Don't sign in from this computer until this is explained. Choose Copy diagnostics and put the report in a [bug report](https://github.com/ryan-stoffel/parallax/issues/new). |

### When the check can't run

| Message | What to do |
| --- | --- |
| `couldn't run: plxd couldn't run the check: <reason>` | Run `npx plx-cli connect` to update `plxd`. |
| `Sign in to Parallax from Profile in the sidebar first.` | Sign in, then check again. |
| `Parallax can't reach Clerk, its sign-in service. Try again once it's back.` | Try again later. Computers on this network keep working. |
| `Parallax isn't connected to this computer's plxd.` | Restart Parallax. If that doesn't help, run `npx plx-cli doctor`. |

## `plx connect status`

| What it shows | What to do |
| --- | --- |
| `Account`: `not signed in (run plx connect)` | Run `npx plx-cli connect` on this computer. |
| `Relay`: `off` | Turn on Reach from anywhere in Settings, or run `npx plx-cli connect`. |
| `Relay`: `on, not connected: <reason>` | See the reason under [Relay](#relay-relay). |
| `This computer isn't registered with the relay yet. Sign in to Parallax to register it.` | Run `npx plx-cli connect` here, or sign in to the app here. |
| `Reach from anywhere`: `off` | This row is the setting the app calls Pair computers on this network. Turn that on, or run `npx plx-cli connect`. The app's Reach from anywhere switch is the `Relay` row. |
| `Reach from anywhere`: `on, not listening: <reason>` | See the reason under [Listener](#listener-listener). |
| `Routes`: `none` | The listener isn't up. Fix that first. |
| `<device> is waiting for approval. Run plx connect approve.` | Run `npx plx-cli connect approve`, compare the codes, then press Enter, or `n` to deny. |

Text and `--json` both exit 0 when `plxd` answered, connected or not. When `plxd` doesn't answer, it exits 1.

## Setting up with `plx connect`

plx prints each failure on a line starting `✗`, and exits 1.

| Message | What to do |
| --- | --- |
| `Parallax has no stable release yet. Run again with --channel nightly.` | Run it again with `--channel nightly`. |
| `The newest stable release, <tag>, is too old for Parallax Relay. Run again with --channel nightly.` | Run it again with `--channel nightly`. |
| `The newest nightly release, <tag>, is too old for Parallax Relay. Try again once a newer nightly is out.` | Try again later. |
| `Parallax has no nightly release.` | Try again later, or check the [releases page](https://github.com/ryan-stoffel/parallax/releases). |
| `GitHub answered <status> <text> for the release list.` | GitHub refused or failed. Try again later. |
| `Parallax doesn't run on <platform>.` | Use macOS, Windows, or Linux. |
| `Parallax has no build for Intel Macs, only Apple silicon.` | Use another computer. |
| `The newest nightly, <tag>, has no <OS> <arch> plxd.` (or `build`) | That build failed on this nightly. Try again once a newer one is out. |
| `The release has no SHA-256 for <file>, so plx won't install it.` | plx won't install a download it can't check. Try again once a newer nightly is out. |
| `The install failed on <computer> (exit <code>).` | Read the lines above it. |
| `Couldn't read the computer's details (exit <code>).` | Check that the computer's shell runs commands normally, then run it again. |
| `Couldn't start plxd: <reason>` | Run `npx plx-cli doctor`. |
| `plxd stopped answering: <reason>` | Run `npx plx-cli doctor`. |
| `The relay didn't accept this sign-in.` | Run `npx plx-cli connect` again and sign in. |
| `The relay answered 403: too_many_hosts` | The account has its 10 computers. Remove one in Settings > Connections. |
| `The relay answered <status>: <reason>` | Try again in a few minutes. |
| `Parallax couldn't reach the relay: <reason>` | Check this computer's network, proxy, and firewall for `relay.parallax.codes`. plx ignores proxy settings, but plxd doesn't. See [Proxies](guide.md#proxies). |
| `It isn't online: it didn't connect in time` | `plxd` didn't reach the relay and start listening within 60 seconds. Run `npx plx-cli connect status`. |
| `It isn't online: <reason>` | See the reason under [Relay](#relay-relay) or [Listener](#listener-listener). |
| `SSH couldn't connect to <destination>. Turn on Remote Login (macOS), OpenSSH Server (Windows), or sshd (Linux) there, or run npx plx-cli connect --channel nightly on it.` | For `plx connect add`. Do what it says. |

`Input ended before an answer.` means `plx connect approve` had no terminal to read Enter or `n` from, so it neither approved nor denied. Run it in a terminal.

### Sign-in

| Message | What to do |
| --- | --- |
| `Couldn't reach Clerk to sign in. Check this computer's network and run it again.` | Do what it says. plx's own requests ignore proxy settings. |
| `Clerk didn't start the sign-in: its discovery document answered <status>.` | Clerk may be down. Try again in a few minutes. |
| `Clerk didn't start the sign-in: its discovery document is malformed.` | Clerk may be down, or something on this network changed its answer. Try again, or from another network. |
| `Clerk didn't start the sign-in: <reason>` | Try again. If it keeps failing, [open an issue](https://github.com/ryan-stoffel/parallax/issues/new) with the reason. |
| `The code expired before it was approved. Run it again.` | Run it again and approve sooner. |
| `The sign-in was denied. Run it again to try once more.` | Run it again, and allow the computer. |
| `Clerk didn't finish the sign-in: <reason>` | Run it again. |
| `Sign-in timed out. Run it again.` | Finish in the browser within 10 minutes. With no browser here, use `--no-browser`. |
| `Clerk didn't accept the code: <reason>. Try again.` | Paste the code again, exactly as the page shows it. You get 3 tries. After that, run it again. |
| `No code was entered before input ended. Run it again in a terminal, or send the code on stdin.` | This appears with no terminal, as with `curl ... \| sh`. Run it in a terminal, or download the script and run `sh connect.sh < codes`. |

Being asked to paste a code isn't an error. plx uses that flow by itself when sign-in with a short code isn't available.

## In the desktop app

### Notices

| Message | What to do |
| --- | --- |
| `Can't reach Parallax Relay` | Wait. Computers on this network keep working, and the rest reconnect when the relay is back. If only this computer sees it, check its network. |
| `Can't reach Clerk sign-in` | Wait. Computers on this network keep working. New relay connections and sign-ins wait until it's back. |
| `This computer isn't on your account` | If you didn't remove it, choose Set up again, which registers it with one click. |
| `This computer was removed` | Choose Start over with a new key in Settings > Connections, then allow this computer on another device. |
| `This computer is read-only` | It stays that way. For full access, choose Start over with a new key, then allow this computer on another device. |
| `<computer> is near its daily relay limit` | Nothing yet. It still works over the LAN, which doesn't count. |
| `<computer> reached its daily relay limit` | The relay won't connect to it until the time shown. It still works over the LAN. |

### A computer's status

| Message | What to do |
| --- | --- |
| `Needs its setup code` | Type the code from its terminal, or from Show setup code in its Settings > Connections. On that computer, `npx plx-cli connect approve` shows a new one. |
| `Waiting for it to come online` | Start that computer, or check its network. |
| `Allow it if it shows <code>` | Compare with that computer's screen. Allow only if they match. Another code, or none, means something else is answering. |
| `Confirm it there · <code>` | Press Enter in that computer's terminal, or Allow in its Parallax. |
| `Allow this computer on another device · <code>` | Allow it on a device that already uses that computer, or run `npx plx-cli connect approve` there. |
| `It hasn't let this computer in. Ask again.` | Choose Ask again, then allow it on another device. |
| `It didn't let this computer in: the request was denied or lapsed.` | Choose Ask again, and allow it within 10 minutes. This also covers a computer with its clock more than 5 minutes off, or one over its 5 requests an hour. Check its `plxd.log`. |
| `It removed this computer. Start over with a new key above.` | Choose Start over with a new key. |
| `It says it removed this computer, but it was added with Allow alone, so Parallax doesn't act on that.` | Nothing changes on this device, as Parallax doesn't take that computer's word for this. To use it, choose Ask again. |
| `Parallax couldn't sign in there: <reason>` | Check that computer's network and its `plxd.log`. |

### Typing or allowing a code

| Message | What to do |
| --- | --- |
| `Enter the 6 digits it shows.` | Enter all 6 digits. |
| `That code is wrong, used, or expired. Check it, then type it again.` | Check it. A code works once and lasts 10 minutes. `npx plx-cli connect approve` there shows a new one. |
| `Couldn't reach it. Check that it's on and still showing its code.` | Do what it says. |
| `That's 5 tries with this computer this hour. Try again later.` | Wait, and make sure you're typing the code that computer shows. |
| `Parallax couldn't pair: <reason>` | Check that computer's network and its `plxd.log`. |
| `That request ended. Type the code it shows instead.` | Choose Type a code instead. |
| `Parallax couldn't record this here, so it isn't allowed. Type the code instead.` | Type the code. If this repeats, update this computer's Parallax. |
| `Parallax couldn't allow it: <reason>` | Check the reason, then try again. |

### Removing and routes

| Message | What to do |
| --- | --- |
| `This is the computer you're on. Remove it from another one, or turn off Reach from anywhere.` | Do what it says, or run `npx plx-cli connect remove` here. |
| `That computer isn't on your account anymore.` | Nothing to do. Add it again if you want it back. |
| `Couldn't turn Reach from anywhere on` with `The relay answered 403: too_many_hosts` | The account has its 10 computers. Remove one. |
| `Couldn't turn Reach from anywhere on` with `The relay didn't accept this sign-in.` | Sign in again from Profile in the sidebar. |
| `Enter an address, with a port if it isn't 7341.` | Enter an address. |
| `Enter only the address and port, with no https:// or path.` | Remove the scheme and path. |
| `That isn't an address. Add a port only if it isn't 7341.` | Check what you typed. |
| `That isn't a valid IP address.` | Check what you typed. |
| `The port must be a number from 1 to 65535.` | Fix the port. |
| `Parallax Relay is already a route.` | Nothing to do. |
| `That route is already in the list.` | Nothing to do. |
| `Only a route you added can be removed.` | Routes the computer reports come back, and the relay always stays. |

## On the phone

| Message | What to do |
| --- | --- |
| `That computer is offline or asleep.` | Wake it, or check its network. Run `npx plx-cli connect status` there. |
| `Too many connections to that computer this minute. Try again shortly.` | Wait a minute. |
| `Parallax Relay didn't take this phone's sign-in.` | Sign in again in the app. |
| `Parallax Relay doesn't know that computer. Run npx plx-cli connect --channel nightly on it.` | Do what it says. |
| `Parallax Relay refused the connection (<status>).` | Try again in a few minutes. |
| `Sign in to reach your computers through Parallax Relay.` | Sign in. |
| `Sign in to Parallax again.` | Sign in. |
| `Couldn't reach that computer.` | Check the phone's network, then that computer's. |
| `Another computer answered for that one.` | The computer's key doesn't match. Don't use it until this is explained. Check its `plxd.log`, and [open an issue](https://github.com/ryan-stoffel/parallax/issues/new). |
| `That computer refused this phone's sign-in.` | Check that computer's `plxd.log`. |
| `That computer refused this phone's new session.` | Check that computer's `plxd.log`. |
| `That request wasn't allowed.` | Ask again, then allow it within 10 minutes. |
| `That request wasn't allowed in time.` | Ask again, then allow it within 10 minutes. |
| `This phone asked that computer 5 times this hour. Try again later.` | Wait. |
| `That computer's code was tried 5 times this hour. Try again later.` | Wait, and make sure you're typing the code it shows. |
| `The code has 6 digits.` | Enter all 6 digits. |
| `This phone was removed` | Choose Start over with a new key, then allow this phone on another device. |
| `This phone is read-only` | It stays that way. For full access, choose Start over with a new key, then allow this phone. |

A computer can refuse the phone with its own reason, shown as written here:

| Message | What to do |
| --- | --- |
| `Reach from anywhere is off on this computer` | Turn it on there, or run `npx plx-cli connect` there. |
| `this computer isn't signed in to an account` | Run `npx plx-cli connect` there. |
| `this computer's clock is off; set it to the right time` | Set that computer's clock. It can be off by 5 minutes at most. |
| `too many new devices asked this hour` | A computer takes 5 requests an hour. Wait, or use `npx plx-cli connect approve` there. |
| `this device was removed` | Choose Start over with a new key. |
| `a token issued too long ago` or `a token issued in the future` | Set the clocks on the phone and on that computer to the right time. |
| `the account's signing keys are out of reach` | That computer can't reach Clerk. Check its network. If a proxy inspects its TLS, exempt Clerk's host. See [Proxies](guide.md#proxies). |

## Logs

Remove computer names, addresses, and host ids before you share a log. An install from before these folders existed may keep them in the OS's app data folder.

| Where | What it holds |
| --- | --- |
| `~/.parallax/logs/plxd.log` (`%USERPROFILE%\.parallax\logs\plxd.log` on Windows) | `plxd`, on each computer: the relay link, and each client that connected and disconnected |
| `~/.parallax/desktop/logs/connection.log`, then `.1` and `.2` | The desktop app: each connection it made and lost |
| Settings > About > Connection log on the phone | The phone, with the same lines as the desktop's, to read or copy |

To find disconnects on a computer:

```sh
grep 'client disconnected' ~/.parallax/logs/plxd.log
grep 'relay link' ~/.parallax/logs/plxd.log
```

| Line | What it means |
| --- | --- |
| `client disconnected route=<route> reason=<reason>` in `plxd.log` | A client that had connected left. `route` is `local`, `lan`, `tailnet`, or `relay`. |
| `relay link lost cause=<cause>` in `plxd.log` | `plxd`'s connection to the relay went. `cause` is `relay_closed`, `tcp_reset`, `tcp_eof`, `ping_timeout`, `io_error`, or `websocket_error`. Open streams outlive it, so this doesn't mean a client dropped. |
| `relay link lost` with `close_code=4409 close_reason="replaced"` | Another `plxd` connected as this computer. Check for a second copy running with the same key. |
| `relay link closed cause=<cause>` in `plxd.log` | `plxd` ended the link itself: `shutdown`, the setting going `off`, or a wake or change of network, `moved`. |
| `could not connect to the relay` in `plxd.log` | An attempt that never linked. |
| `refused an account sign-in: this computer's clock is off from the relay's` in `plxd.log` | Set this computer's clock. |
| `could not fetch the account's signing keys` in `plxd.log` | `plxd` can't reach Clerk. See [Proxies](guide.md#proxies). |
| `could not listen for remote clients` in `plxd.log` | The listener couldn't bind port 7341. |
| `client_disconnect host=<name> route=<route> reason=<reason>` in the app's log | A connection that was up went. `reason` is `transport_closed`, `liveness_timeout`, `better_route`, `route_removed`, `new_device_key`, `app_closed`, `protocol_error`, `not_found`, `incompatible_protocol`, `ssh_setup`, or `refused`. |
| `client_connect host=<name> route=<route>` in the app's log | A connection came up. `down_ms` and `last_reason` say how long the last one was down and why. |
