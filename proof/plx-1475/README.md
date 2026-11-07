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
pnpm exec tsc -p proof/tsconfig.json
pnpm exec vitest run --config proof/vitest.config.ts
node scripts/host-proof.mjs
```

The runner removes inherited credentials/proxy configuration, uses a temporary
HOME/XDG/data, puts a failing tailscale first in PATH, and invokes the existing
fake-RSA/JWKS e2e harness with local-only Wrangler. A fresh loopback CA signs the
outer TLS endpoint. Ordered raw TCP directional delivery adds 0/20/50 ms to each
leg. Both routes use the same listener, host, handler and payload. No remote
Wrangler, real identity, real daemon, tailnet or secret is needed.

Relay gates run before the native proof in normal Linux PR CI. Native proof gates
execute actual pairing HTTP replies, complete final descriptor HTTP response,
three fresh authenticated WS connections with 50 health RPCs each, and wrong pin.
Then the experiment alternates AB/BA over 30 pairs (30 opens per route) at each
delay, collecting connection-ready, initialize completion, actual events/event
replay and 50 individual health RPC durations. Admission pacing remains outside
intent and does not bypass the real 30/minute limiter. Existing published
benchmark markers are unchanged. Startup, unavailable and re-enabled host cases
are separate. Revocation must close a live candidate and refuse a fresh redial.

CI retains source SHA256, exact merge HEAD, native binary SHA256, authority JSON
and unedited native stdout/stderr in the host-routing-proof artifact. Raw samples
are JSON following `host-proof sample`; failures remain explicit. A panic or
missing artifact means unsupported validation, not pass. Stage values are not
summed, and local/CI delay results do not predict deployed latency.

## Validation status before Linux CI

- Standard relay suite: 74 passed, exit 0. Existing injected-failure tests log
  expected exceptions and the suite logged Network connection lost while exiting 0.
- Candidate real-DO tests: 2 passed, exit 0. Mixed legacy spare/candidate pending
  ledger capped at 16, and final bytes before FIN while report completion is held.
- Production and fixture TypeScript checks, Node syntax, Rust format and diff
  whitespace checks passed.
- Native compile/execution, final HTTP/WS drain, AB/BA samples, startup/unavailable/
  restart and native revocation are **not yet validated**. CI is required.
- No security parity or adoption recommendation. No production gain established.

Beyond the implemented slice, unproved invariants include DPoP replay/approval
races, owner change during OPEN/report, duplicate report/commit-ack loss, durable
crash debt, quota exhaustion/UTC rollover, pending expiry races, hibernation and
restart reconciliation, slow-reader/control-flood bounds and fairness, proxy
coverage and total resident memory. The carrier is a serial feasibility adapter
with shared head-of-line blocking, not a deployable transport.
