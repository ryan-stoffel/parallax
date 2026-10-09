# 0065: Parallax is reachable from any device, through LAN pairing, SSH install, a web client, a hosted relay, and a mobile app

- Status: accepted; amends PLAN.md's non-goal on hosted services, extends [0007](0007-editor-plxd-protocol.md) (a WebSocket transport beside `plxd attach`) and [0056](0056-parallax-connect.md), and builds on [0037](0037-accounts.md)'s accounts
- Date: 2026-10-09
- Issue: PLX-636, for PLX-641, PLX-642, PLX-651, PLX-652, and PLX-653

## Context

A Parallax app reaches plxd in two ways. `plxd attach` over a child's stdio, locally or as `ssh … plxd attach`, speaks 0007's newline-delimited JSON-RPC (`apps/desktop/src/main/connection.ts`). Parallax Connect has plxd listen on its Tailscale address, port 7340, for the user's own untagged nodes, checked with `tailscale whois`, and the app runs `plxd dial` (0056, `daemon/src/server/tailnet.rs`). The app finds plxd on an SSH host but can't install or update it (PLX-580, `LOCATE_PLXD` exits 127). plxd has no HTTP or WebSocket server, no web client, and no relay. Phones can't reach it at all. PLAN lists "a hosted cloud service, except Parallax accounts" as a non-goal, and accounts (Supabase Auth, 0037) back nothing yet.

T3 Code (`docs/internals/remote.md`, `environment-auth.md`, `t3-connect.md`, `docs/user/remote-access.md`):

- **One server, many routes.** A client joins one environment over HTTP and WebSocket (`/ws`, Effect RPC with JSON, `apps/server/src/ws.ts`). Direct, LAN, Tailscale, SSH, and T3 Connect only change the route. A saved environment keeps an ordered list of routes, each checked against the server's public descriptor before a credential is sent, and the server reports its LAN and tailnet addresses as more routes.
- **Auth.** Pairing is a one-time link, QR code, or code from Settings or `t3 pair`. The client trades it for a session at `/oauth/token` (`packages/client-runtime/src/authorization/remote.ts`). Sessions are cookie, bearer, or DPoP, and a WebSocket opens with a short-lived `wsTicket` so tokens stay out of URLs. Every RPC declares a scope. There is no mDNS discovery.
- **Tailscale** is just a route: `t3 serve --tailscale-serve` runs `tailscale serve --bg --https=443` (`packages/tailscale/src/tailscale.ts`).
- **SSH** (`packages/ssh/src/tunnel.ts`): the desktop app installs the server into `~/.t3/runtime/versions/<version>` with `curl` or `wget` and a SHA-256 check, gets a pairing credential over SSH, forwards the port with `ssh -N -L`, and stops the server on cleanup only if it started it. Linux and Apple Silicon Macs only.
- **Web.** app.t3.codes is a static client that keeps its environments in the browser and connects to each directly. It needs an HTTPS route.
- **T3 Connect** (`apps/server/src/cloud/`, `infra/relay/`): Clerk sign-in. The relay sets up a managed Cloudflare tunnel per environment (`cloudflared`, pinned), and mints a bootstrap credential bound to the client's DPoP key. After that the relay is out of the data path. It forwards webhooks at `/v1/hooks/<environmentId>/<hookId>/<token>`, and with an opt-in holds them up to 24 hours and 1 MiB while the environment is offline, replaying them when its tunnel reconnects (`apps/server/src/relay/HeldHooksWaker.ts`). The server publishes per-thread activity, signed with its environment key (`AgentAwarenessRelay.ts`), and the relay sends APNs and FCM pushes and iOS Live Activities. It runs as a Cloudflare Worker with Postgres and queues.
- **Mobile** (`apps/mobile`): Expo on the shared `@t3tools/client-runtime`. Push needs T3 Connect.
- **Outside agents** reach `<environment>/mcp` with OAuth and PKCE, approved with a pairing code, read-only or capped at a mode (`apps/server/src/auth/McpOAuth.ts`).

Ryan chose all of it for Parallax on 2026-10-09 (PLX-635).

## Decision

### An HTTP and WebSocket listener in plxd

- A host setting, `remote`, off by default, opens an HTTP listener (port 7341) on the addresses the user picks: loopback, a private LAN address, or both. It serves `/ws` (0007's JSON-RPC, one message per WebSocket frame, the same methods and limits as a socket connection), `/oauth/token`, the web client's files, `/api/hooks` ([0063](0063-schedules-pr-watches-and-delegation.md)), and `/mcp`.
- WebSocket support comes from `tokio-tungstenite`, and the handful of HTTP routes are plxd's own code. plxd has no TLS. HTTPS comes from `tailscale serve` or the relay's tunnel, as in T3. PLX-651 measures the binary size it adds.
- `plxd attach`, SSH hosts, and Connect's raw TCP (0056) stay as they are for the desktop app.

### Pairing and sessions

- T3's flow: Settings > Connections > Pair a device, or `plxd pair`, shows a one-time link, QR code, and code, valid 10 minutes. The client trades it at `/oauth/token` for a session. A session is a bearer token stored hashed in plxd's store, and a WebSocket opens with a 30 s `wsTicket`. Settings lists sessions by device and revokes them.
- Each JSON-RPC method gets a scope (`read`, `operate`, `admin`), and a session is created with one. Outside agents at `/mcp` pair the same way and are read-only or capped at an access level.
- No mDNS, as in T3. The pairing link carries the address.
- A client keeps routes per host, as T3's: LAN, tailnet, relay. It tries them in order, checking plxd's public descriptor (`/.well-known/parallax`, host id and version) before sending a credential. plxd reports its LAN and tailnet addresses as routes.

### SSH install

- When `LOCATE_PLXD` finds no plxd, or an older one, the SSH host dialog offers Install or Update. The app installs plxd into `~/.parallax/runtime/versions/<version>/` on the host with `curl` or `wget`, checks its SHA-256, and links `~/.parallax/runtime/current`. Then it connects with `plxd attach` as today, so no port is forwarded. Linux x64 and arm64, and macOS arm64, as T3.
- `release.yml` attaches a standalone `plxd` archive per OS and arch, with its checksum in `SHA256SUMS`.

### The web client

- plxd serves the app's renderer build at `/`, with a browser bridge that implements the preload API over `/ws`. Electron-only features (native menus, local file pickers, the updater) are hidden in a browser. The renderer files ship beside plxd in the app bundle and in the standalone archive.
- A hosted copy of the same client, on the relay's domain, keeps its hosts in the browser and connects to each directly, as app.t3.codes does.

### The relay

- **Parallax Relay** is a hosted service, separate from Parallax Connect (0056, Tailscale). Sign-in is the Parallax account (0037, Supabase), in place of T3's Clerk.
- It does what T3 Connect does: a managed Cloudflare tunnel per host (plxd runs a pinned `cloudflared`, downloaded on first use), a bootstrap credential bound to the client's DPoP key, and no data path after bootstrap. It forwards webhooks at `/v1/hooks/<hostId>/<hookId>/<token>`, holds them up to 24 hours and 1 MiB while plxd is offline if the user opts in, and plxd asks for held ones when its tunnel reconnects. plxd publishes each thread's activity (working, needs you, done, failed), signed with a host key, and the relay sends APNs and FCM pushes.
- It runs as T3's does: a Cloudflare Worker with Postgres and queues, in `infra/relay/`.
- It needs Ryan's accounts: Cloudflare, a domain, Apple push credentials, and Firebase. PLX-652 is blocked on them.

### Mobile

- `apps/mobile`, Expo, on a client package taken out of the renderer (the protocol client and its stores), shared by the desktop renderer, the web client, and mobile. It reaches hosts by the same routes and pairing, queues messages while offline, and gets push and Live Activities through the relay only. PLX-653 is blocked on the relay and on Apple and Google developer accounts.

## Consequences

- PLAN.md's non-goal changes: a hosted service is in scope for remote access, webhooks, and push.
- plxd gains a network listener that isn't Tailscale-checked. It is off by default, every connection needs a paired session, and on a LAN it is plain HTTP, as T3's. Anyone on that network can see the traffic, so the app recommends the tailnet or relay route.
- The relay is infrastructure Ryan pays for and operates, with its own uptime and security. Running it is part of shipping.
- SSH hosts no longer need a manual install. Releases gain standalone plxd archives.
- The app's protocol client and stores become one package that Electron, the browser, and React Native share.
