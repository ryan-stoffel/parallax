# 0065: Parallax is reachable from any device, through LAN pairing, SSH install, a web client, a hosted relay, and a mobile app

- Status: accepted; amends PLAN.md's non-goal on hosted services, extends [0007](0007-editor-plxd-protocol.md) (a WebSocket transport beside `plxd attach`) and [0056](0056-parallax-connect.md), and records PLX-642's SSH install, and builds on [0037](0037-accounts.md)'s accounts
- Date: 2026-10-09
- Issue: PLX-636, for PLX-641, PLX-642, PLX-651, PLX-652, and PLX-653

## Context

A Parallax app reaches plxd in two ways. `plxd attach` over a child's stdio, locally or as `ssh … plxd attach`, speaks 0007's newline-delimited JSON-RPC (`apps/desktop/src/main/connection.ts`). Parallax Connect has plxd listen on its Tailscale address, port 7340, for the user's own untagged nodes, checked with `tailscale whois`, and the app runs `plxd dial` (0056, `daemon/src/server/tailnet.rs`). Since PLX-642, Settings > Connections installs or updates plxd on an SSH host (`apps/desktop/src/main/installPlxd.ts`). plxd has no HTTP or WebSocket server, no web client, and no relay. Phones can't reach it at all. PLAN lists "a hosted cloud service, except Parallax accounts" as a non-goal, and accounts (Supabase Auth, 0037) back nothing yet.

T3 Code (`docs/internals/remote.md`, `environment-auth.md`, `t3-connect.md`, `docs/user/remote-access.md`):

- **One server, many routes.** A client joins one environment over HTTP and WebSocket (`/ws`, Effect RPC with JSON, `apps/server/src/ws.ts`). Direct, LAN, Tailscale, SSH, and T3 Connect only change the route. A saved environment keeps an ordered list of routes, each checked against the server's public descriptor before a credential is sent, and the server reports its LAN and tailnet addresses as more routes.
- **Auth.** Pairing is a one-time link and QR code from Settings or `t3 pair`, valid 5 minutes (`DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES`, `apps/server/src/auth/PairingGrantStore.ts`). The client trades it for a session at `/oauth/token` (`packages/client-runtime/src/authorization/remote.ts`). Sessions are cookie, bearer, or DPoP, and a WebSocket opens with a `wsTicket`, valid 5 minutes, so tokens stay out of URLs. Every RPC declares a scope. There is no mDNS discovery. Direct LAN routes are plain HTTP, with no TLS anywhere in the server (`apps/server/src/environment/DirectEndpoints.ts`).
- **Tailscale** is just a route: `t3 serve --tailscale-serve` runs `tailscale serve --bg --https=443` (`packages/tailscale/src/tailscale.ts`).
- **SSH** (`packages/ssh/src/tunnel.ts`): the desktop app installs the server into `~/.t3/runtime/versions/<version>` with `curl` or `wget` and a SHA-256 check, gets a pairing credential over SSH, forwards the port with `ssh -N -L`, and stops the server on cleanup only if it started it. Linux and Apple Silicon Macs only.
- **Web.** app.t3.codes is a static client that keeps its environments in the browser and connects to each directly. It needs an HTTPS route.
- **T3 Connect** (`apps/server/src/cloud/`, `infra/relay/`): Clerk sign-in. The relay sets up a managed Cloudflare tunnel per environment (`cloudflared`, pinned), and mints a bootstrap credential bound to the client's DPoP key. After that the relay is out of the data path. It forwards webhooks at `/v1/hooks/<environmentId>/<hookId>/<token>`, and with an opt-in holds them up to 24 hours and 1 MiB while the environment is offline, replaying them when its tunnel reconnects (`apps/server/src/relay/HeldHooksWaker.ts`). Held webhooks live in a Durable Object per environment, with SQLite storage. The server publishes per-thread activity, signed with its environment key (`AgentAwarenessRelay.ts`), and the relay sends APNs and FCM pushes and iOS Live Activities. The rest runs as a Cloudflare Worker with Postgres and queues.
- **Mobile** (`apps/mobile`): Expo on the shared `@t3tools/client-runtime`. Push needs T3 Connect.
- **Outside agents** reach `<environment>/mcp` with OAuth and PKCE, approved with a pairing code (the only use of a code; device pairing is the link or QR code), read-only or capped at a mode (`apps/server/src/auth/McpOAuth.ts`).

Ryan chose all of it for Parallax on 2026-10-09 (PLX-635), with one change from T3: LAN traffic is encrypted. A sniffed session token on a plain-HTTP LAN would give an operator session on a host that runs agents with full access. PLX-641 already requires it.

## Decision

### An HTTP and WebSocket listener in plxd

- A host setting, `remote`, off by default, opens a listener (port 7341) on the addresses the user picks: loopback, a private LAN address, or both. On a LAN address it speaks only HTTPS. On loopback, where `tailscale serve` and the relay's `cloudflared` connect, it speaks HTTP. It serves `/ws` (0007's JSON-RPC, one message per WebSocket frame, the same methods and limits as a socket connection), `/oauth/token`, the web client's files, `/api/hooks` ([0063](0063-schedules-pr-watches-and-delegation.md)), and `/mcp`.
- **TLS with a pinned key**, Parallax's own, in place of T3's plain LAN HTTP. When `remote` is first turned on, plxd generates a self-signed certificate (ECDSA P-256), kept in its data folder. The pairing link carries the certificate's SHA-256 fingerprint, and the client pins it for that host: the LAN route is used only when the presented certificate matches, and nothing (not even the public descriptor) is sent before that. A new key needs a new pairing.
- WebSocket support comes from `tokio-tungstenite`, TLS from `rustls` with the `ring` provider, and the certificate from `rcgen`. The handful of HTTP routes are plxd's own code. Tailnet and relay routes get publicly trusted HTTPS from `tailscale serve` and the relay's tunnel, as in T3. PLX-641 and PLX-651 measure the binary size these add.
- A browser can't pin a key, so the web client reaches plxd over the tailnet or relay routes. On the LAN, a browser works only after the user trusts plxd's certificate in the OS, whose fingerprint the pairing page shows.
- `plxd attach`, SSH hosts, and Connect's raw TCP (0056) stay as they are for the desktop app.

### Pairing and sessions

- T3's flow: Settings > Connections > Pair a device, or `plxd pair`, shows a one-time link and QR code, valid 5 minutes, carrying the address and the certificate fingerprint. The client trades it at `/oauth/token` for a session. A session is DPoP-bound, as T3 supports, so a stolen token is useless without the client's key, and it is stored hashed in plxd's store. A WebSocket opens with a `wsTicket` valid 30 s. That is Parallax's choice. T3's lasts 5 minutes. Settings lists sessions by device and revokes them.
- Each JSON-RPC method gets a scope (`read`, `operate`, `admin`), and a session is created with one. Outside agents at `/mcp` sign in with OAuth and PKCE, approved with a one-time pairing code, and are read-only or capped at an access level, as in T3.
- No mDNS, as in T3. The pairing link carries the address. PLX-641's approach still names mDNS and changes to match.
- A client keeps routes per host, as T3's: LAN, tailnet, relay. It tries them in order, checking plxd's public descriptor (`/.well-known/parallax`, host id and version) before sending a credential. plxd reports its LAN and tailnet addresses as routes.

### SSH install

- Built by PLX-642, like T3's: a host without plxd, or with an older one, gets Install or Update plxd in Settings > Connections. A POSIX script over ssh picks the release asset with `uname`, downloads it with `curl` or `wget`, checks it against its `.sha256`, and installs it in `~/.parallax-plxd`, which `LOCATE_PLXD` tries first. The app then connects with `plxd attach`, so no port is forwarded. This record keeps that design.
- The web client's files (below) ship beside that plxd asset, so an SSH-installed plxd can serve them.

### The web client

- plxd serves the app's renderer build at `/`, with a browser bridge that implements the preload API over `/ws`. Electron-only features (native menus, local file pickers, the updater) are hidden in a browser. The renderer files ship beside plxd in the app bundle and beside the standalone plxd release asset.
- A hosted copy of the same client, on the relay's domain, keeps its hosts in the browser and connects to each directly, as app.t3.codes does.

### The relay

- **Parallax Relay** is a hosted service, separate from Parallax Connect (0056, Tailscale). Sign-in is the Parallax account (0037, Supabase), in place of T3's Clerk.
- It does what T3 Connect does: a managed Cloudflare tunnel per host (plxd runs a pinned `cloudflared`, downloaded on first use), a bootstrap credential bound to the client's DPoP key, and no data path after bootstrap. It forwards webhooks at `/v1/hooks/<hostId>/<hookId>/<token>`, holds them up to 24 hours and 1 MiB in a Durable Object per host while plxd is offline if the user opts in, and plxd asks for held ones when its tunnel reconnects. plxd publishes each thread's activity (working, needs you, done, failed), signed with a host key, and the relay sends APNs and FCM pushes.
- It runs as T3's does: a Cloudflare Worker with Postgres and queues, and a Durable Object per host for held webhooks, in `infra/relay/`.
- It needs Ryan's accounts: Cloudflare, a domain, Apple push credentials, and Firebase. PLX-652 is blocked on them.

### Mobile

- `apps/mobile`, Expo, on a client package taken out of the renderer (the protocol client and its stores), shared by the desktop renderer, the web client, and mobile. It reaches hosts by the same routes and pairing, queues messages while offline, and gets push and Live Activities through the relay only. PLX-653 is blocked on the relay and on Apple and Google developer accounts.

## Consequences

- PLAN.md's non-goal changes: a hosted service is in scope for remote access, webhooks, and push.
- plxd gains a network listener that isn't Tailscale-checked. It is off by default, every connection needs a paired, DPoP-bound session, and LAN traffic is TLS with a pinned key, unlike T3's plain HTTP. plxd gains three crates (`tokio-tungstenite`, `rustls`, `rcgen`).
- The relay is infrastructure Ryan pays for and operates, with its own uptime and security. Running it is part of shipping.
- The app's protocol client and stores become one package that Electron, the browser, and React Native share.
