# PLX-1475 host-only experiment

Start pin: `98c78ca4e5a735c22c12c24148e6eed126fd88c4` (cap fix #1200).
Historical #1199 and the earlier client-carrier proposal are not included.
See TRANSITIONS.md for state transitions and unsupported invariants.

Production uses its existing entry point, bindings and native features. Only
`relay/proof.toml` imports ProofHost. `host-routing-proof` refuses release builds.
The subclass delegates admission, durable pending reservations, common capacity,
publication, teardown and delta accounting to HostRelay. A legacy spare stays in
that same ledger. Client opens allocate a new outer TCP/TLS/WS and pinned inner
TLS/DPoP WS. The host alone retains a data socket. Native logical sockets feed
stream(), including registration in Relay.streams before the loopback connect,
unchanged authenticated listener and final-byte pipe/Holding cleanup.

Removed candidate dependency: the separate StreamRelay arm/client-fetch/host-join
object boundary. Remaining candidate dependency: host control OPEN -> data JOIN
-> both ends READY for each fresh client. This may cost more than a ready legacy
spare. The experiment does not assert an RTT reduction or production speedup.

## Run

On a disposable Linux checkout with normal PR dependencies/build cache:

```
cd relay
node --test scripts/delay-duplex.test.mjs
pnpm exec tsc -p proof/tsconfig.json
pnpm exec vitest run --config proof/vitest.config.ts
node scripts/host-proof.mjs
```

The runner removes inherited credentials/proxy configuration, uses a temporary
HOME/XDG/data, puts a failing tailscale first in PATH, and invokes the existing
fake-RSA/JWKS e2e harness with local-only Wrangler. A separate ephemeral CA
(CA:TRUE, certificate-signing usage) signs the localhost/IP-SAN server leaf
(CA:FALSE, digitalSignature/keyEncipherment, serverAuth EKU). Only the CA goes
in the isolated SSL_CERT_FILE; the HTTPS server serves the leaf. Before native
registration, the actual fixture checks CA/end-entity roles and runs OpenSSL
strict chain/server-purpose verification for both localhost and 127.0.0.1 using
only this CA. These preflights do not replace acceptance by rustls in Linux CI.
Ordered raw TCP directional delivery adds 0/20/50 ms to each leg. Both routes use the same listener, host, handler and payload. No remote
Wrangler, real identity, real daemon, tailnet or secret is needed.

Relay gates run before the native proof in normal Linux PR CI. The actual delay
helper is covered at 0/20/50 ms with each side half-closing first. Ordered Transform
pipelines finish pending writes before forwarding EOF; both sockets allow half-close.

Each counted sample launches the already-built test executable as a fresh child
process. The host stays resident. The child opens a fresh outer TCP/TLS/WS and
inner pinned TLS/authenticated WS, then initializes, receives an actual replay
event and runs 50 identical health RPCs. AB/BA alternates over 30 pairs per delay.
The parent clock begins before spawn and records launch-to-ready, initialize and
replay markers received over stdout, including process-launch and IPC overhead.
Each sample includes a child PID and child-measured network-connect duration.
No helper, client process, TLS configuration or client socket survives between
counted samples. Admission pacing is outside intent and preserves real limits.

Startup records control-online separately from host-start through the first usable
candidate connection in a fresh child. This startup case explicitly includes fake
fixture enrollment/pairing and replay-event seeding; it is not an attribution of
carrier-only setup cost. Native correctness gates (wrong pin, final HTTP body/EOF,
and carrier-only loss/replacement) precede comparative trials. Data-only loss must
close old logical connections, refuse candidate opens while control/legacy routing
remain online, and recover through a new authenticated connection. Replacement
timing includes token issuance, observed carrier readiness and child launch to ready.
Live-session revoke/redial assertions follow the trials. Existing published
benchmark markers are unchanged. No T3 or production comparison is claimed.

CI retains source SHA256, exact merge HEAD, native binary SHA256, authority JSON
and unedited native stdout/stderr in the host-routing-proof artifact. Raw samples
are JSON following `host-proof sample`; failures remain explicit. A panic or
missing artifact means unsupported validation, not pass. Stage values are not
summed, and local/CI delay results do not predict deployed latency.

## Validation status before Linux CI

- Standard relay suite: 74 passed, exit 0. Existing injected-failure tests log
  expected exceptions and the suite logged Network connection lost while exiting 0.
- Candidate real-DO tests: 4 passed, exit 0. Shared cap/final bytes with delayed
  reporting, authority reconnect with live traffic/usage preserved, and peer carrier
  loss/replacement with control online/unchanged proof epoch and stale logical ids.
- Actual delay helper: 6 Node tests passed at 0/20/50 ms with both half-close orders.
- Prior head `3849c7c5df253dffec923c355f8f1fc83e4ba87c` failed Clippy before native
  execution in run `42343135560`. Its in-process client timings were not executed
  and would not satisfy fresh-process sampling. This revision extracts stream
  identity validation without lint suppression. Run `42383198803` on subsequent
  head `4abe9191e3305322c2622027ec256ef5870e264b` passed that lint boundary and
  the other four Rust platforms. Linux passed 13 existing native relay tests and
  6 actual-delay tests, then rejected the proof's first registration with rustls
  `CaUsedAsEndEntity`. No proof samples were produced. The fixture had served its
  CA as the leaf; this focused revision separates them with explicit constraints.
- Corrected fixture: local strict OpenSSL purpose/chain/name preflight and isolated
  TLS smoke inspecting the actual served leaf passed. Node-only TLS smoke on the
  old certificate did not exercise rustls's rejection and was insufficient.
- Production and fixture TypeScript checks, Node syntax, Rust format and diff
  whitespace checks passed.
- Native proof runtime beyond registration, final HTTP/WS drain, AB/BA samples, startup/unavailable/
  carrier replacement and native revocation are **not yet validated**. CI is required.
- No security parity or adoption recommendation. No production gain established.

Beyond the implemented slice, unproved invariants include DPoP replay/approval
races, owner change during OPEN/report, duplicate report/commit-ack loss, durable
crash debt, quota exhaustion/UTC rollover, pending expiry races, hibernation and
restart reconciliation, slow-reader/control-flood bounds and fairness, proxy
coverage and total resident memory. The carrier is a serial feasibility adapter
with shared head-of-line blocking, not a deployable transport.

## Reconnect accounting provenance

The interrupted review probe hit send-after-close before reaching accounting, so
it did not establish accounting loss. After guarding token sends, an isolated
negative run retained the old candidate close(report=false) callback: two forwarded
frames left no saved traffic after authority reconnect, versus 32,768 bytes expected.
The candidate callback now reports its buffered count through HostRelay.report
before discarding the local slot. A passing reconnect test reads saved usage before
unregister, then proves a fresh generation adds exactly its own two frames. This is
a bounded fixture correction. Legacy StreamRelay.close and inherited delta-report
retry/ack-loss semantics are unchanged and are not claimed safe under new failures.
