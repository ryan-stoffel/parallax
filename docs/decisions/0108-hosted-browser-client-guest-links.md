# 0108: A hosted browser client runs plxd's TLS in WebAssembly, and a guest link shows one thread

- Status: accepted, with two calls left to Ryan (below). Amends [0068](0068-relay.md)'s Identity section and its line on web clients, and [0091](0091-connect-over-relay.md)'s read-only amendment (PLX-1364). Replaces [0065](0065-remote-reach.md)'s line that a hosted copy of the web client lives on the relay's domain
- Date: 2026-11-22
- Issue: PLX-1607

## Context

On 2026-11-22 Ryan brought two things into scope that were out of it: a hosted browser client, as T3 has `app.t3.codes`, and expiring guest access to one thread, as T3 has guest links. T3's guest link shares one thread with one browser for 24 hours, and each message the guest sends waits until the owner sends or dismisses it ([T3 guest links](https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md)).

Parallax's rule is that end-to-end encryption, host-key pinning, and the relay's connect limiter are never weakened. Today every client runs TLS 1.3 to plxd's own P-256 key inside the relay's stream, pinned to the host id (the key's JWK thumbprint), so the relay carries ciphertext only ([0068](0068-relay.md), [0091](0091-connect-over-relay.md)). The phone does this natively (`apps/mobile/modules/pinned-tls`). A browser can't: its own TLS checks a certificate against public roots and offers no pin, and its WebSocket can't carry a TLS session it runs itself.

0068 already named the catch: a web client is end to end only when its JavaScript comes from somewhere the relay's operator doesn't control. Code served from an origin can read whatever it decrypts.

The relay's gates today (`relay/src/index.ts`, `host.ts`): every stream open first passes Cloudflare's rate limit binding, 120 a minute per address (an IPv6 /64) and host, before any object runs. Then the host's object requires a Clerk token for the host's own user, and counts 30 opens a minute per host, at most 16 open streams, and 2 GiB a day. This record calls all of that the connect limiter.

## Decision

### TLS in the browser: rustls compiled to WebAssembly

The hosted client runs rustls 0.23 with ring, the same library and version plxd and `plxd dial` use, compiled to `wasm32-unknown-unknown` through wasm-bindgen. JavaScript feeds it the relay WebSocket's binary frames and takes its records back. It speaks TLS 1.3 only and checks the certificate with plxd's own pin code (`key_id` in `daemon/src/remote.rs`), shared rather than copied: the JWK thumbprint of the certificate's P-256 key must equal the host id, and nothing is sent before it does. Inside the TLS, the client writes its own HTTP, so the `/ws` upgrade carries its DPoP proof and may use `plxd-early-ws`, as `plxd dial` does (0091). Session tickets stay in memory for the page's life, per pin, so a reconnect within an hour resumes with 0-RTT on 0091's terms (PLX-1585), and nothing is kept across reloads.

Measured for this record on the Mac mini (Apple M6) with rustls 0.23.46, ring 0.17.14, wasm-bindgen 0.2.100, `opt-level = "s"`, LTO, and no `wasm-opt`:

| | Result |
| --- | --- |
| Client module with the pin check | 459 KB, 186 KB gzipped, 150 KB with Brotli |
| The same, with only the algorithms plxd uses (P-256 signatures, X25519 and P-256 key exchange, AES-128-GCM and ChaCha20-Poly1305) | 447 KB, 180 KB gzipped, 147 KB with Brotli |
| A full TLS 1.3 handshake, both ends in WASM, Node 22.23 | 0.57 ms (median of 5 runs of 100, range 0.55 to 0.59) |
| Bulk data, encrypted by one end and decrypted by the other, both in WASM | 44.5 MiB/s (median of 5 runs of 64 MiB), so the client's decrypt alone is about twice that |

For scale, the renderer build is 3.3 MB (0065), so the module adds about 5%, loaded once and cached. A connect's cost is its round trips through the relay (tens of milliseconds each), not the handshake's half a millisecond, and the relay's 2 GiB a day caps traffic far below what the module can decrypt. Not measured: Chrome, Firefox, and Safari themselves (V8 in Node should match Chrome, Safari's JavaScriptCore wasn't run), and a handshake against plxd through the relay. Building ring's C for WASM needs clang with the wasm32 target and `llvm-ar` (rustup's `llvm-tools`), and rustls needs `rustls-pki-types`' `web` feature for the clock, getrandom's `js` feature, and ring's `wasm32_unknown_unknown_js`.

Why rustls and not the others:

- **subtls**, a TypeScript TLS 1.3 client on WebCrypto, which 0068 named. Its README calls it a proof of concept, "not ready to be used in production", and says it needs auditing. It supports P-256 key exchange and AES-128-GCM only, verifies a chain up to public roots with no pinning hook, and would put a second TLS implementation beside plxd's. Its size wasn't measured, and would be smaller.
- **Other TypeScript clients** (`reclaimprotocol/tls`, node-forge): forge stops at TLS 1.2, which plxd doesn't speak. The rest are unaudited, as subtls is.
- **WebTransport with `serverCertificateHashes`** pins natively, but needs HTTP/3 over UDP straight to plxd, which the relay's Workers don't carry, and the certificate it pins may last at most two weeks, so the pin would change every two weeks instead of being the host id.
- **WebRTC with a DTLS fingerprint** pins natively too, but needs ICE, a TURN server, and a WebRTC stack in plxd beside its TLS. That is new crypto, which 0068 rules out.
- **A protocol of our own** (Noise, libsodium) would mean a second handshake in plxd. Also new crypto.

### Where the pin comes from

- **A browser device takes its first host from a device the user already trusts.** Settings > Connections > Open in a browser, on the desktop or the phone, shows a link and a QR code to the hosted client with the computer's host id in the URL fragment (`#connect=<hostId>`). The fragment isn't sent in any HTTP request (RFC 3986 §3.5), and it holds no secret, since approval (below) still needs the user's Allow. The pin therefore never comes from the relay.
- **Further hosts come from that host's lists**, by pinned id, as on the desktop: a host in its `approvedHosts`, never `allowedHosts`, and never one the relay lists alone. The relay's list says only which of them are online.
- **A guest takes its pin from the link** (below).
- **What stops the relay's operator substituting a key:** the pin is the thumbprint of the key, and the TLS handshake proves possession of it, so a relay that presents another key fails the handshake before a byte of HTTP. The relay can list a host of its own, but the browser never pins a host from the relay's list. What the pinning can't stop is code served to the browser that pins something else, which is the next sections' subject.

### A browser becomes a device

- **Off by default, per computer.** A host setting, `hostedClient` (Settings > Connections), is off until the user turns it on. While it's off, plxd refuses every key it approved through the hosted client, and every guest, and closes their sockets. Turning it on lets them back in, as 0065's `remoteWeb` does.
- **Sign-in.** The hosted client signs in with Clerk as an OAuth public client with PKCE, as the desktop does (0067), in a new OAuth application whose redirect is the client's own origin. Its access token carries that application's `client_id`, signed by Clerk, so plxd knows a request came through the hosted client from the token, not from anything the client says. Code on another origin can't get that token, and the hosted client can't get the desktop's, whose redirect is loopback only.
- **Reaching a host.** A browser's WebSocket can't carry an `Authorization` header, so the client gets a one-time ticket with `fetch` (`POST /v1/hosts/<id>/tickets`, which the relay will answer with CORS for the client's origin only) and opens `/connect?ticket=`. That is 0068's ticket path, unchanged: the anonymous limit at the open, the host's owner, its 30 opens a minute, 16 streams, and 2 GiB a day. It costs one round trip more than `plxd dial`'s token-in-header open.
- **Approval.** Inside the pinned TLS, the client posts its token and a DPoP proof to `/api/auth/account`, as any new device does, and gets a pending answer. Its screen and the user's approved devices show 0091's commit-reveal code, and the user clicks Allow on one of them if the codes match. A token alone gets nothing.
- **Read-only by default.** The Allow dialog names the request as a web browser and has Read only ticked. Approved that way, the key gets 0091's one-way read-only mark. Unticking it gives full access. Since the mark can't be lifted later, a browser approved read-only reaches full access only by starting over with a new key and a new Allow, as 0091 has it.
- **The key** is a WebCrypto ECDSA P-256 key generated with `extractable: false` and kept in IndexedDB, and the client asks for persistent storage. Script on the page can't read its private part, but can use it while the page is open, so "non-extractable" stops the key being copied out, not being used by the code that runs there. Safari deletes a site's script-writable storage after 7 days without a visit, unless the client is installed to the home screen, and then the browser asks again as a new device.
- **Revocation.** A browser is listed in Settings > Connections with its kind and removed as any device is: it joins the removed lists, plxd signs a removal for the user's other computers (0091, PLX-1367), and its sessions end. Signing out in the browser deletes its key. Turning `hostedClient` off cuts every browser on that computer at once.
- A user who types a LAN pairing code into the hosted client gets an ordinary paired session, since inside the browser's own TLS plxd can't tell which code sent the request. The hosted client offers no such form.

### What the hosted code can do, and what limits it

The browser runs whatever the client's origin serves on each load. Whoever can publish to that origin can ship code that reads every thread the browser opens, sends it anywhere, uses the device's key and Clerk session while the page is open, and with full access runs agents and terminals on the user's computers. Pinning and end-to-end TLS don't help, because that code is one end of the TLS. Nothing on the page can prevent it: Subresource Integrity and a Content Security Policy are declared by the same HTML the publisher serves, and a published hash protects only someone who checks it at the moment of the load. A bad version can also be served to one visitor once and leave no trace.

That publisher is the honest boundary. The desktop app, the phone app, and plxd also run code Ryan publishes, so a hosted client published the same way adds no new party. Two things still make it weaker than an installed app: a page is fetched on every load, so a bad version reaches users at once, and it can be served to one person, where an app update is one signed file that everyone gets.

What limits it, and is real:

- **Not the relay's operator.** The client is served from outside the Cloudflare account that runs the relay (below), so a compromised relay, Worker deploy, or Cloudflare account still can't read a thread, which is 0068's promise. This is the narrowest form that keeps it.
- **One pipeline, in public.** The client is built by `release.yml` from a tagged commit of the public repository, the same run that builds the desktop app, and deployed as exactly those files. Changing it means a public commit and a release, as changing the desktop app does.
- **Published hashes.** Each release lists every file's SHA-256 in its `SHA256SUMS`, and the site serves the same list. `plx web verify` fetches the live site and compares. This detects a swap after the fact. It doesn't stop one.
- **A separate origin** that serves nothing else, so its keys and sign-in are reachable only by its own code. A CSP meta tag allows only its own scripts, `wasm-unsafe-eval`, and connections to the relay and Clerk, and the page refuses to run in a frame. Subresource Integrity covers the built tags. These keep out injected and third-party code. They don't stop the publisher.
- **Off by default, read-only by default.** A computer is exposed only after its user turns `hostedClient` on, and a read-only browser can't write, start agents, or open terminals, so code gone bad can read what that browser could, not act on the computer.

The desktop app and the phone stay the clients that need no trust in a served page.

### Where the client is hosted

- **Recommended, and what this record assumes: GitHub Pages**, on a `github.io` origin that serves only this client, with no custom domain. GitHub already holds the code and the releases the desktop updater installs, so it adds no party, and its DNS isn't on the relay's Cloudflare account, as `parallax.codes`' is. A user's project sites all share one origin (`<user>.github.io`), so the client needs a GitHub organization of its own, whose site is the client.
- **The alternative: `app.parallax.codes`**, a Cloudflare Worker with static assets, apart from the relay's Worker. It has a better address and can send headers (a real `frame-ancestors`), but it is on the same Cloudflare account and zone as the relay, so whoever controls that account controls the code and the relay together. A compromised relay account could then read what browsers open, which is the weakening Ryan's rule forbids. It's Ryan's call (below).
- **Build and publish.** `release.yml` builds the client once per release and attaches it with its manifest. A deploy workflow, run only by hand (`workflow_dispatch`), publishes exactly that release's files. Production deploys are Ryan's. Agents never run that workflow, as they never deploy the relay's production Worker. Under the alternative, the deploy is `wrangler deploy` by Ryan from the client's own directory.

### Guest links: one thread, one browser

- **Who.** The owner of a thread, from a full-access session on the desktop or the phone: the thread's menu has Share with guest. A read-only device can't make one, as it makes no pairing codes. It needs `hostedClient` on for that computer, since guests use the hosted client.
- **The link** is `https://<client>/g#<hostId>.<linkId>.<secret>`: the host id (the pin), a 16-byte link id, and a 32-byte random secret, base64url. All of it is in the fragment, so no server gets it in a request, though the client's own code reads it, and the browser's history and sync keep it. plxd derives two keys from the secret with HKDF-SHA256: a relay pass and a host key, under different labels, so one tells nothing about the other.
- **Passing the relay without an account.** plxd sends the relay, over its authenticated control socket, the link id, the SHA-256 of the relay pass, and the expiry, and withdraws them on revoke. The guest's client asks `POST /v1/hosts/<id>/guest-tickets` with `Authorization: Guest <linkId>.<pass>`. That request goes through the anonymous limit (120 a minute per address and host) before any object runs, then the pass and its expiry, then the host's own 30 opens a minute, online check, 2 GiB a day, and 16 streams, and then a link's own 6 tickets a minute and 2 open streams. The ticket opens `/connect?ticket=` once. Guests count against the owner's host budget. At most 20 links are live per host at the relay. Nothing in the connect limiter is skipped, so a guest is gated as a signed-in client is, and more tightly.
- **Passing plxd.** Inside the TLS pinned to the link's host id, the guest posts the host key and a DPoP proof from a non-extractable WebCrypto key to `/api/auth/guest`. The first browser's key binds the link, opening it again in that browser works, and any other key is refused, as T3's link works in one browser. The relay saw only the pass's hash, and the pass doesn't derive the host key, so the relay can count a guest but can't be one.
- **Expiry and revocation.** A link lasts 24 hours, as T3's does. Stop sharing, a new link for the same thread (one live link per thread), archiving or deleting the thread, and turning `hostedClient` off end it. Each closes its session at once. plxd decides, and the relay's copy only limits traffic, so a relay that ignored a revoke still gets a refusal from plxd.
- **What a guest sees: read-only by default.** The thread's transcript and its live events, filtered on plxd, as T3's guest sees: messages, replies, tool calls and their output. Anything the agent read or printed can show, and the share dialog says so. With "can suggest messages" ticked (off by default), the guest's message waits at the end of the thread until the owner sends or dismisses it, as T3 has it, and a sent message runs as the owner's turn with the thread's permissions.
- **What a guest never reaches.** A `guest` level in plxd's exhaustive method match, beside full and read-only: any other thread or project, files, diffs, terminals, settings, secrets, approvals, starting or stopping a run, device and host lists, other computers, the push key (0100), and the account. Each allowed method checks the thread id. A guest isn't a device: it never joins the approved lists and never syncs.
- **Limits.** A link leaked before its guest opens it gives the thread to whoever opens it first, and the owner sees who opened it and when. A leaked link after that can still spend the link's 6 tickets a minute of the host's 30 until it's revoked. The hosted client's publisher can read what a guest sees, as above.

### Ryan's calls

1. **Hosting.** GitHub Pages on an organization of its own, which keeps 0068's promise (recommended), or `app.parallax.codes` on Cloudflare, with the cost above. Pages needs Ryan to create the organization.
2. **Clerk.** A new OAuth application on the production instance for the hosted client: public, PKCE required, scopes `profile email offline_access`, redirect `https://<client origin>/oauth/callback`. Only Ryan has the dashboard.

## Rejected

- **Serving the client from `parallax.codes` without saying so.** It weakens 0068's promise for every browser user, and the rule says never.
- **Taking a browser's first host from the relay's list**, as a new phone does (0091, PLX-1316). The browser is the client whose code is least fixed, so its first pin comes from a device the user holds.
- **Guest links as devices with a read-only mark.** A device spans every computer and syncs. A guest gets one thread on one computer, which the read-only level doesn't express.
- **A guest message that runs without the owner.** It would let anyone with the link direct an agent with the thread's permissions.
- **A service worker that pins the bundle after the first visit.** The server can replace the service worker, so it adds no protection a published hash doesn't.

## Work

One pull request each, in order. 1, 2, and 3 can run in parallel, and 7 beside 6.

| Order | Issue | Part | Size |
| --- | --- | --- | --- |
| 1 | PLX-1615 | Browser TLS: rustls in WebAssembly, pinned to a host | M |
| 2 | PLX-1616 | Relay: browser tickets over CORS and guest passes (Ryan deploys) | M |
| 3 | PLX-1617 | plxd: `hostedClient` and browser devices | M |
| 4 | PLX-1618 | plxd: guest links to one thread | L |
| 5 | PLX-1619 | Hosted web client: relay transport, sign-in, guest view (waits on both calls) | L |
| 6 | PLX-1620 | Desktop and phone: open in a browser, browser devices, share with guest | M |
| 7 | PLX-1621 | Build, publish, and verify the hosted client (waits on call 1) | M |

## Consequences

- A browser reaches the user's computers from anywhere, through the relay only, so every byte counts against the host's 2 GiB a day.
- The relay learns which guest links exist, when they're used, and from which address. Not their content, and not the host key.
- Thread content stays unreadable to the relay and Cloudflare. It isn't private from whoever publishes the hosted client, the same party that publishes the apps, and a browser user trusts each page load where an app user trusts each update.
- Safari users without the home-screen install re-approve after a week away.

## Sources

- [rustls/rustls#808](https://github.com/rustls/rustls/issues/808), rustls on `wasm32`, and the [rustls docs](https://docs.rs/rustls/0.23.46/rustls/)
- [jawj/subtls](https://github.com/jawj/subtls), its README's scope and warnings
- [WebTransport `serverCertificateHashes`](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport), and the [two-week limit](https://community.letsencrypt.org/t/two-week-lasting-certificates-to-comply-with-webtransport-requirements/209345)
- [Web Cryptography API](https://w3c.github.io/webcrypto/), `extractable`
- [RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5), fragments stay with the user agent
- [Subresource Integrity](https://www.w3.org/TR/SRI/)
- [`frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors) is ignored in a meta tag, and [GitHub Pages can't set headers](https://github.com/orgs/community/discussions/49832)
- [WebKit's 7-day cap on script-writable storage](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
- [Meta's Code Verify](https://engineering.fb.com/2022/03/10/security/code-verify/) and [Cloudflare's part in it](https://blog.cloudflare.com/cloudflare-verifies-code-whatsapp-web-serves-users), hash checks of served code, which detect rather than prevent
- [T3 guest links](https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md)
