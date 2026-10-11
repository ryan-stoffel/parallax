# 0068: Parallax Relay passes plxd's own TLS between a client and its host, so it never reads a thread

- Status: accepted; replaces [0065](0065-remote-reach.md)'s relay section, and uses [0067](0067-clerk-accounts.md)'s accounts
- Date: 2026-10-11
- Issue: PLX-652, for PLX-653

## Context

0065 planned Parallax Relay as T3 Connect is built: a managed Cloudflare tunnel per host, a bootstrap credential, and no relay in the data path after that. A tunnel ends TLS at Cloudflare, so Cloudflare, and the relay's operator, could read every thread. On 2026-10-11 Ryan chose Cloudflare Workers with Durable Objects, `relay.parallx.dev`, and Clerk sign-in ([0067](0067-clerk-accounts.md)), and asked that the relay never see thread content.

plxd already has what end-to-end encryption needs (0065): a self-signed P-256 certificate per host, TLS 1.3 to it, a client that pins its fingerprint after SPAKE2 pairing with a one-time code, and DPoP-bound sessions with 30-second WebSocket tickets.

## Decision

### The relay is a byte pipe for plxd's TLS

- plxd keeps one outbound WebSocket to the relay while its `relay` and `remote` settings are both on. Off by default.
- A client asks the relay for a stream to a host. The relay tells plxd over that WebSocket, and plxd opens a second WebSocket for the stream and joins it to a loopback connection to its own remote listener. The relay passes binary frames between the two.
- The client runs TLS to plxd's certificate inside the stream, pinned as on the LAN. Pairing (SPAKE2 with the code), sessions, tickets, and `/ws` are 0065's, unchanged. The relay carries TLS records only, so it can't read or change a thread, and it can't stand in for the host: a client that pinned the host's fingerprint refuses any other certificate.
- A client that has never paired pairs through the relay too, with the code from Settings, over the same stream. SPAKE2 gives a relay in the middle one online guess per code and no fingerprint.
- No new crypto. A `relay:<hostId>` route goes in the host's route list, after its LAN and tailnet addresses. `plxd dial` signs in to the relay with `PLXD_RELAY_TOKEN`, which the app sets from the account's access token.
- A browser or React Native client needs a TLS 1.3 implementation over a WebSocket, such as subtls on WebCrypto, to use the relay. For the mobile app (PLX-653), that is end to end: its code ships in the app, and it can scan a QR code that carries the host's fingerprint and a pairing code where SPAKE2 isn't available. For a web client, it is end to end only when its JavaScript comes from somewhere the relay's operator doesn't control. A web client served from `parallx.dev`, by the same operator, could be changed to send its keys or plaintext anywhere.

### Identity

- **A host is its key.** Its relay id is the JWK thumbprint (RFC 7638) of plxd's certificate key. `POST /v1/hosts` registers it under the Clerk user of the request's token, with the key's ES256 signature over `parallax-relay-register`, the id, and the SHA-256 of that token. Nobody can register a key they don't hold, or replay a registration under another user. Registering under a new user moves the host and closes its connections.
- **plxd proves the key on every connection.** It opens its control socket with a proof in a header: `parallax-relay-host`, its id, and the time in milliseconds, signed with the key. The relay takes it only from 5 minutes behind its own clock, as 0065's DPoP proofs, to 30 seconds ahead, and only if it is newer than the last one it took, so each proof works once. The window ahead is small because a proof far ahead would make every later one look old until plxd's clock caught up. No socket opens without one. The host id is public, since it is in every webhook URL, but there is no challenge to wait on and no pending socket a stranger could hold open or push out, so strangers can't keep plxd off the relay. The newest connection replaces any other.
- **A wrong clock is corrected, not locked out.** A signed proof outside that window gets a 401 that carries the relay's time, in the `x-parallax-relay-time` header and the body. plxd logs that its clock is off, keeps the difference, signs again by the relay's clock at once, and keeps signing by it.
- **A client must be the host's own user.** It needs a Clerk token for the user that registered the host, checked by `packages/clerk-verify` (0067): a session token from the web or Expo SDK, or the desktop app's OAuth access token. With it, the client gets a ticket for one stream, valid once for 30 seconds. Another user's host answers as if it didn't exist. plxd's side of the stream joins with a one-time token the relay sent only over plxd's authenticated connection.
- The desktop app registers the host from Settings > Connections > Reach from anywhere. Main sends the token straight to plxd (`relay/register`), so it never reaches a renderer, and plxd keeps nothing of it.

### Cloudflare

- One Worker in `relay/` routes requests. One Durable Object per host holds its registration, plxd's connection, its clients' streams, and its held webhooks. One per user holds the user's host list, push devices, and request budget. Both are SQLite-backed. Every WebSocket uses hibernation, so an idle host costs no duration.
- Limits per minute: per address and host, 120 anonymous requests (webhooks and the WebSockets that prove themselves), counted by Cloudflare's Rate Limiting binding before any object runs. An IPv6 address counts by its /64, since one machine commonly holds a whole /64. Per user, 120 signed-in requests and 120 pushes. Per host, 10 registrations by the key's holder, 12 control connections with a valid proof, 30 tickets, 600 webhooks, 60 pushes, and at most 16 open streams. Per webhook URL, 60. The objects' counters are in memory, so an evicted object starts its windows over.
- Cost ceilings, since Ryan pays for the relay: a user owns at most 10 hosts, checked and reserved in one call to the user's object, so parallel registrations can't overrun it. A registration that is refused or fails gives its slot back, and a host that moves to another user stops counting for its old one. A host's streams carry at most 2 GiB a UTC day, both ways together, with each frame counted as at least 16 KiB, since Cloudflare bills incoming WebSocket messages, not bytes. That is at most 131,072 frames a host a day, after which its streams close and it gets no tickets until the next day. One user's streams therefore cost at most 20 GiB, or 1,310,720 frames (about 65,536 billed requests at 20 messages a request), a day. The count is saved every 8 MiB, so a host's object that hibernates mid-stream can miss at most 512 frames. A host id nobody registered stores nothing: its object answers from an empty storage, and the held webhooks' table is made on a registered host's first hold.
- plxd pings once a minute, which the host's object answers without waking. Cloudflare closes a WebSocket idle for 100 seconds.

### Webhooks

- plxd sends the relay the SHA-256 of each webhook URL it serves (`<hookId>/<token>`) when it connects and whenever a scheduled task is saved or deleted. The relay keeps the list. A request to any other URL gets 404 before it counts against a budget or is held, so guesses and junk can't use up a real sender's budget or fill the inbox. The relay already sees tokens in URLs, so the list tells it nothing new.
- `/v1/hooks/<hostId>/<hookId>/<token>` (GET, POST, PUT, PATCH) goes to plxd over its connection: method, path with query, headers without hop-by-hop, cookie, `cf-*`, `x-forwarded-*`, and `proxy-*`, and the raw body. The Worker reads the body, up to 1 MiB and for at most 10 seconds, and answers 413 or 408 past either. plxd runs the request through 0063's `/api/hooks` check, so the token and HMAC signature are checked on the host against the exact bytes the sender signed. The sender gets plxd's answer.
- While plxd is away, or when it doesn't answer within 10 seconds, the host's object holds requests with T3's limits: bodies to 1 MiB, 24 hours, 1,000 requests, 50 MiB, and 100 per hook. It sends them oldest first when plxd reconnects. One plxd took (2xx, or a 4xx other than 429) is deleted. One it couldn't take (429, 5xx, or no answer) is tried again from the object's alarm while plxd stays connected, after 10 seconds, doubling to 10 minutes, as T3's inbox does, and holds back the rest of its hook so they keep their order. The alarm is set from each hook's oldest webhook only, since the rest wait behind it, and never sooner than a second away, since each wake is a billed request. Each carries a relay delivery id, which keys the fire (0063), so a request delivered twice fires once. Unlike T3, holding needs no opt-in.
- A webhook's sender talks HTTPS to the relay, so the relay sees what the sender sends. A webhook is not thread content.
- A webhook task's URL in the app is the relay's while plxd is connected to it, and the LAN address otherwise.

### Push

- plxd tells the relay when a run asks for approval (`needsYou`), finishes (`done`), or fails (`failed`), with the run id only. The relay sends the user's registered iOS devices a fixed text per state, with the host and run ids for the app to open. No title or text from a thread.
- Devices register at `POST /v1/devices` with an APNs token. APNs is a stub that logs until Ryan's key exists (PLX-653). FCM waits for Android.

### Deploy

- `relay/wrangler.toml` is the infrastructure: the Worker, both Durable Object classes and their migration, the rate limit, and the `relay.parallx.dev` custom domain with no `workers.dev` URL. Its top level sets no Clerk instance, so a deploy refuses every token until production's issuer, JWKS URL, and the desktop app's client id are added. Clerk's development instance is only in `[env.dev]`, which `pnpm dev` runs. `relay/README.md` lists what Ryan provides and the deploy commands, with a custom API token of exactly the four permissions the deploy needs. No workflow deploys it.
- CI type-checks the Worker and runs its tests in Miniflare, and the Linux Rust job runs plxd against `wrangler dev` end to end.

## Consequences

- The relay adds no trusted party for thread content: a compromised relay can drop or delay streams, and learn which user's hosts are online when, but can't read or forge a stream.
- Webhooks are different. The relay sees them, as any public webhook endpoint does, and it sees their tokens. A compromised relay can fire any webhook task that has no signature secret, and replay a signed request under a new delivery id, so it fires again. A task that must not be fired by the relay's operator needs a signature and a sender-side check of what it acts on.
- A mobile client reaches a host through the relay only once it runs TLS over a WebSocket and pairs with SPAKE2 or a QR code, and a web client only with JavaScript the relay's operator doesn't serve. Until then they use the tailnet route, as 0065 has it.
- Relay traffic goes through Cloudflare's edge and the host's Durable Object both ways, so a stream adds a round trip to its nearest point of presence. Cloudflare bills its bytes as Durable Object WebSocket messages.
- plxd needs `remote` on to use the relay, since streams end at the remote listener. That listener also answers on the LAN.
- plxd gains `webpki-roots` for the relay's public certificate.
- A user removes a host of theirs with `DELETE /v1/hosts/<id>`, from Settings > Connections, which lists the account's hosts on the relay through plxd (`relay/hosts`, `relay/remove`) with Remove on each. Removing it closes its connections, deletes everything the relay keeps for it, and frees its slot, so a user whose plxd lost its data (a new key, a new host id) can always free the old one. Turning the switch off only disconnects a host, and its registration stays so webhook URLs don't change.
