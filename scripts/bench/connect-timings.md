# Connect timing audit (PLX-1466)

For a future authorized comparison, pin both versions:

```
node scripts/bench/t3-compare.mjs --version 0.1.7 --parallax-tag <exact-tag> --connects 30 --trips 50 --timings --token-file <test-account-file> --out comparison.jsonl
```

This enrolls disposable hosts as before. Do not run it against a personal account. No extra run or enrollment is needed to review this PR. The JSONL now retains both products, the Parallax tag, sample counts, medians and nearest-rank p95. Without `--parallax-tag`, the probe retains its newest-nightly-at-least-one-hour-old selection. Without `--timings`, there are no new diagnostic stderr lines or request headers. Older releases simply provide no stage rows.

| Measurement | Start | Stop | Included / excluded |
| --- | --- | --- | --- |
| T3 connect | Immediately before ticket request | WebSocket open event | New HTTPS ticket POST, then WebSocket connection, within existing Node process. Excludes issuing the saved session, provisioning tunnel, sign-in. |
| Parallax connect | Immediately before spawning `plxd dial` | Observer receives stderr `connected over relay:` | Process launch, CLI/runtime, credential read, outer connection/relay admission, readiness, pinned inner TLS, DPoP WebSocket upgrade. Excludes sign-in/approval, registration and downloading binary. |
| T3 first event | Same start as connect | First `Chunk` for `subscribeServerLifecycle` | Subscription after open. No AI work. |
| Parallax first event | Same start as connect | Stdout observer sees first `events/event` | Includes `attach` sending initialize with events/subscribe right behind it (PLX-1480), one round trip, and replay of a precreated orchestrator event. This is not the lifecycle subscription T3 uses. |
| T3 round trip | Before `server.probe` send | Successful `Exit` | Open socket, Effect RPC framing/ack semantics. |
| Parallax round trip | Before `host/health` call | JSON-RPC result | Open socket, different method and framing. |

Both servers run on the measuring computer, so the access network is traversed twice. T3 terminates TLS at Cloudflare. Parallax has pinned end-to-end TLS and DPoP. Equal sample counts do not make these protocols or security guarantees identical. Keep the process-inclusive measurements, rather than subtracting stages to claim a win.

The comparison forwards the same connect/trip counts and gap to the Parallax probe. Each performs one uncounted connection and RPC warm-up, 2200 ms gaps before counted connects, and 100 ms before counted RPCs. T3 takes an extra uncounted connection for RPCs; Parallax uses its final measured connection. The standalone probe still defaults to 5 connects / 6 trips. Increasing to 30 uses 2200 ms gaps to leave room under the 30 opens/minute limit. Approval opens and relay-object checks are separate. OS DNS, host/JWKS caches, and the T3 Node process may be warm. Each Parallax dial is a new process with fresh TLS state. A gap gives spare refill time but does not prove that a spare is ready. The relay timing flag records actual spare selection. Earlier results (5/6 vs 30/50, no Parallax warm-up) are not matched before/after evidence, and earlier even-count Parallax medians selected the upper middle sample.

`PLXD_CONNECT_TIMINGS=1` emits at most 64 fixed-name numeric stderr lines per process. Client `connect-timing` values are cumulative milliseconds from first instrumentation in main. Ordered differences locate CLI/runtime/credential setup, outer DNS/TCP/proxy, outer TLS configuration/handshake, authenticated relay upgrade, stream-ready wait, pinned TLS, inner WebSocket upgrade, and first inbound text frame. A first frame is usually initialize's response, not the first subscription event. The probe independently retains its first-event timer. Failed stages have no completion marker. Fallbacks/retries repeat stage names, so interpret in order, not as a map. `outer_tls_ready` on local HTTP means transport ready without TLS.

The probe records each stage's value and `observedMs` from the external spawn timer. The main marker's receipt is an upper bound for launch/loader time, including pipe scheduling, not an exact OS process creation timestamp. Other checkpoints also incur small stderr overhead. Do not use instrumented vs uninstrumented runs to claim small improvements.

Clients cannot split relay authentication from host object admission and spare selection. When opted in, they request `x-parallax-timing: 1`; a successful authenticated upgrade returns six numeric `Server-Timing` entries: `auth` (Clerk verification, including any JWKS fetch), `host_open` (host RPC including admission and selection), `stream_join` (stream-object client upgrade RPC), `admit`, `take` (inside host_open), and `spare` (1 or 0, a flag, not a duration). These overlap: do not sum host_open with admit/take. They use local durations, not synchronized clocks. Worker routing/rate-limit time before the handler, transit and scheduling remain in the client/server difference. No persisted logs or IDs are added. The client prints only allowlisted finite numeric entries in 0..60000 ms, within the same 64-line cap.

Since PLX-1493 the upgrade also returns `limit` (the anonymous rate limit's answer), `jwks` (the JWKS read, present only when this request made one), `host_hop` (a call to the host object that does nothing, made beside the stream's join) and `worker` (the request's start through the stream's 101). `limit` and `auth` both start with the request and run side by side, so they overlap, and the time before `host_open` is the longer of the two. `host_open` minus `host_hop` is the host object's own work, with its claim write's confirmation. The client's relay upgrade minus `worker` is one round trip plus what Cloudflare spends outside the Worker. Cloudflare's timers advance only after I/O, so a stage with no I/O reads 0: an `auth` of 0 means the isolate had the keys.

A manual run of the Relay probe workflow keeps each connect's stages in its artifact, from a GitHub runner, with no token on anyone's computer. Its `relay` input picks production or staging, and `connects` set to 30 gives enough samples to compare two runs. The older fields come from plxd's output, so they need no new plxd. The four new ones need a plxd from after PLX-1493 there, and until then the probe's object rows (`relay-objects.mjs`) carry them for its own timed streams, as `spare: relay limit` and the like.

Local proof (build first):

```
node relay/scripts/e2e.mjs node scripts/bench/connect-timing-proof.mjs
```

It uses real plxd processes, disposable data directories, fake tailscale first on PATH, local signed test tokens, SPAKE2 approval, pinned TLS and DPoP. No provider threads or real credentials. Local HTTP lacks production outer TLS and production Durable Object/network/JWKS costs. It validates boundaries and preservation of the encrypted stream, not production speed or the cause of Ryan's remaining gap. A production authenticated stage sample, with this reviewed relay instrumentation manually deployed, is still missing. No concrete transport change is justified yet.
