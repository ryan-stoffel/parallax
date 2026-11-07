# PLX-1475: persistent opaque carrier feasibility

Decision: return the task's authorized concrete-design fallback. No executable candidate, comparative local timings, invariant runtime tests, production implementation, PR, release or deployment. Parent must review this design before implementation. Do not mark transport/security acceptance criteria as runtime-validated.

## Scope and evidence

Owned worktree `/Users/ryan-stoffel/.parallax/worktrees/plx-1475`, branch `feature/PLX-1475-persistent-carrier-proof`, from freshly fetched origin/develop `265b931bb592bd0bbb0131b55f248d67a30c9f2d`. Read AGENTS.md, PLAN.md, decision0091, PLX-1475 and its Plan, PLX-1470 RESEARCH.md, PLX-1471 HANDOFF.md and COLD-PATH-ADDENDUM.md. Other worktrees are read-only. No T3 source copied. Public T3 release/main pins and license analysis remain in the referenced research, not a new experiment here.

`evidence.json` records source hashes, the supplied production artifact hash, binary hash/reference, all 30 derived stage rows, and empty candidate sample arrays. Reproduce without installing anything or starting a daemon:

```
cd /Users/ryan-stoffel/.parallax/worktrees/plx-1475
python3 proof/plx-1475/reproduce.py > proof/plx-1475/evidence.json
```

This verifies evidence only. Product end-to-end quantiles are copied from stored summaries, not recomputed from unavailable raw end-to-end samples. Per-stage deltas are computed within each recorded connection; p95 uses nearest rank, median averages the two middle values. Differences between stage medians are not used.

Supplied production artifact: `/Users/ryan-stoffel/.parallax/uploads/01a1b44f-82d5-778a-bb40-921006432c27/connect-timings-wifi-join.jsonl`, SHA256 `8990fbae2fbe914a32736172f172e5996dc3ed82ce557b69907ec052cb14f81e`. Stored connect median/p95: Parallax582/743ms, T3362/460ms. Stored first event744/887 vs415/509; stored steady RPC70/102 vs50/134. Different product handlers, process boundaries and security boundaries prevent causal transport conclusions.

Matched Parallax stage median/p95 milliseconds:

| Stage | Median | p95 |
| --- | ---: | ---: |
| Outer TCP/proxy | 32.085 | 117.798 |
| Outer TLS | 32.2765 | 49.422 |
| Outer relay upgrade | 233.5 | 384.9 |
| Whole stream join RPC | 42.5 | 93 |
| Pinned inner TLS | 110.111 | 251.245 |
| Authenticated inner WS | 72.406 | 131.156 |

All30 selected a spare. All join_read/join_ready/join_delete_alarm/join_total fields report0. **Timer-invisible does not mean negligible, submillisecond, or zero work.** Cloudflare's production performance.now/Date.now advance after I/O rather than during CPU execution: https://developers.cloudflare.com/workers/runtime-apis/performance/ (checked November6 Pacific). The42.5/93ms whole RPC remains unresolved across local CPU, pre-entry gates, queueing, network, wake and response. No attribution of that interval entirely outside the object, and no measured storage-wait removal. No additional production diagnostic deployment proposed.

## Why no faithful executable in this boundary

Read-only candidate binary `/Users/ryan-stoffel/.parallax/worktrees/plx-1466/target/debug/plxd`, SHA256 `93daf8fea63862a82b4d62bd523819c439ded6d693b5c96d8594283be475ba8a`, source reference `447d2567db13b6a1c0cbdb970854fe69c4c3a88f`. Relevant relay.rs, remote.rs, server/remote.rs and server/connection.rs match develop exactly. Across daemon/Cargo inputs only connect_timing.rs differs. Hash/source matching does not independently attest binary build provenance. Binary was not executed here.

Concrete boundaries at the pinned source:

- daemon/src/remote.rs:1046 open_pinned accepts a relay route or TCP and calls unchanged tls_over; :2056 dial_pinned loads saved credentials and freshly signs the inner upgrade. There is no runtime plug-in for logical relay streams.
- daemon/src/relay.rs:722 open_stream creates a fresh authenticated outer WS and waits for ready. :600 pipe maps one WS's lifetime to one DuplexStream, so it cannot multiplex by configuration.
- relay.rs:1892 stream registers its loopback peer in Relay.streams before connecting. server/remote.rs:1390 onward uses that metadata for over_relay serving and termination. A generic TCP shim is not equivalent to this route.
- relay.rs:600–695 and :1945 onward preserve final-frame/close acknowledgment ordering before gone (PLX-1456). Carrier close and logical close must become separate state machines.
- relay/src/host.ts:337 admit, :388 take and :411 report own admission, durable exclusive spare claim, shared16cap, daily accounting and slot release. stream.ts owns join, accounting attachments/alarms and reporting. Keeping these objects unmodified retains per-stream arm/join; bypassing them loses their enforcement.

A Node WS/TCP multiplexer around the existing binary could demonstrate TLS bytes and actual RPC, but would either skip relay admission/accounting/metadata/close semantics or retain the old per-stream coordination. Neither proves this carrier. Implementing the genuine alternative requires changes to both native ends, durable relay lifecycle and shared old/new accounting. That is a transport redesign, not a bounded wrapper experiment with the available executable. Free disk at inspection562MiB. No full Cargo rebuild is authorized, no disk cleanup of others' artifacts, and no cloudflared credentials/provisioning allowed. This is a constraint of this proof environment, not a claim the design is impossible.

## Smallest concrete design to review (all proposed, none implemented)

Choose WSS multiplexing, not cloudflared or raw QUIC. One host data carrier into a dedicated per-host CarrierRelay DO; one client carrier per account+host into that same object. Keep existing host control socket separate. A native client helper must survive multiple dial attempts: persistence in only the host connector leaves the current fresh client outer setup intact. No reuse of a healthy application WS is counted as a new open.

HostRelay remains the sole old/new stream-slot and daily-budget authority. Add a tagged claim type to its durable streams record, including carrier generation, logical id, owner epoch and pending/live state. A new claimMux method shares admit/cap accounting with old take, but does not arm a StreamRelay. It commits a pending slot before any READY/data; cancel/error releases via an idempotent final report. Legacy spare/prepared/pending streams count toward the same16cap. CarrierRelay still calls HostRelay per logical open. This design removes a separate StreamRelay object's per-stream arm/client join, not all DO coordination.

Carrier endpoints negotiate v1 explicitly. Client carrier authentication alone never authorizes future opens indefinitely. Each OPEN supplies a current Clerk token inside WSS, freshly verified with the existing verifier, followed by authoritative ownership, online, rate and budget checks. No credentials in URLs/logs. Host carrier proof must be domain-separated for carrier-v1 and replay-checked, bound to host/account generation; reuse of the control-socket signature format on a new endpoint is not acceptable. Owner move/unregister invalidates the carrier generation and all old/new streams.

Frame envelope: version, opcode, carrier generation, logical id, sequence, length, payload. OPEN/OPEN_OK/REFUSE, DATA, WINDOW, FIN/FIN_ACK, CANCEL and GOAWAY are distinct. Bounds and validation precede allocation. Logical ids are not reused within a generation. Never accept DATA before a durably admitted OPEN and host readiness. New logical opens create new native byte channels, host loopback sockets, pinned TLS and inner authenticated WS. Keep existing Pin/DPoP/approval/replay/revocation handlers untouched. Native host adapter registers each loopback peer in Relay.streams with per-logical EndSlot/cancellation, as existing stream() does.

Use initially proposed64KiB max DATA,64KiB per-direction stream window, at most16 active/pending logical streams per host. Enforce windows at relay and both native ends, not just client promises. Schedule at most one DATA chunk per ready stream per round; bounded control queue must allow cancellation without starving data. WS library/OS buffering adds memory beyond the proposed2MiB of directional payload windows and must be measured/bounded. WSS/TCP still has connection-wide head-of-line blocking. Fair scheduling cannot remove that.

Forward ciphertext through CarrierRelay on every DATA frame. There is still per-frame DO execution/transit and now a shared-host scheduling point. No claim of T3's byte-path topology or steady-RPC gain. Charge each logical DATA independently at least max(payload,16KiB) as today, with additional envelope overhead accounted conservatively; packing streams into one WS frame must not discount logical frames. Control flooding needs its own bounded rate and charge policy.

Pending claims expire at30s and release durably. Carrier close cancels all associated native byte streams, no TLS byte replay/resume. FIN_ACK follows forwarding all earlier sequence numbers, final accounting and slot release, preserving the last-response ordering needed by PLX-1456. Abrupt loss records cumulative per-stream totals and generation-bound report sequence durably, retries idempotently and releases only after settlement. Hibernation attachments retain logical maps/counters, alarms report within existing8MiB/5minute bounds. On recovery, do not continue forwarding until admitted slots/counters reconcile. Over-budget closes all host carriers and legacy streams. These crash/hibernation/report transitions are the principal unsolved implementation work, not assumed facts.

First start includes native helper start, host carrier availability, client outer TCP/proxy/TLS/WS, carrier auth/negotiation, logical admission, pinned TLS and inner WS. Later fresh logical streams avoid client outer TCP/TLS/WS and StreamRelay-specific join only while both carriers remain healthy. They retain current authentication, HostRelay admission RPC, durable claim, host readiness, fresh pinned TLS and DPoP upgrade, initialize and subscribe. No numerical saving follows from this stage inventory.

## Coverage matrix

Nothing in the candidate column below has executable coverage. Source inspection of the existing path is not a new runtime security test.

| Invariant | Existing implementation inspected | Candidate state and required proof |
| --- | --- | --- |
| TLS/host pin before credentials | remote.rs open_pinned/tls_over, dial_pinned | Proposed same functions; wrong-pin and host-id-pin refusal after carrier reuse required |
| DPoP, approval, removed device | server/remote.rs authorize/serve_socket/session checks | Proposed unchanged; replay, pending/denied, revoke between watch/check, removed key tests required |
| Ownership | Worker verifySession + HostRelay.admit/register/unregister | Per-OPEN current token+owner epoch and carrier invalidation unimplemented |
| Durable exclusive16cap | HostRelay streams/take, spare included | Shared legacy+mux transaction and duplicate OPEN/idempotency unimplemented;17-way races/restart tests required |
| Rate enforcement | crypto.ts Limiter + HostRelay.admit | Existing per-minute Limiter is volatile, not a durable rate guarantee. Shared per-OPEN enforcement proposed; durable windows would be additional work |
| Budget | HostRelay.count/report + StreamRelay.pending/report | Durable deduped cumulative reports, min-frame charge, restart and day rollover unimplemented |
| Queues/cancellation/fairness | Native64KiB duplex per separate stream; independent stream DOs | Shared bounded windows/scheduler/control queue unimplemented; fairness is a new regression risk |
| Connection loss/final frames | native pipe/Holding/gone, stream close/report | Per-logical FIN acknowledgment, carrier epoch fail-close/reconcile unimplemented |
| Proxy/fallback | Base.connect proxy/outer TLS handling and existing relay route | Proposed same HTTPS-compatible WSS and existing old route; proxy-only test unrun |
| Old clients/migration | Existing routes/ticket fallback remain available | Explicit capability v1, mixed-cap accounting, rollback/drain unimplemented |

## Cost, migration and staged validation

Implementation surface: a new native carrier/session manager on both client and host; new CarrierRelay DO and binding/migration; HostRelay tagged slots/idempotent reporting; Worker negotiation routes; local integration harness; then desktop helper lifecycle. Mobile requires its own native carrier adapter before opt-in. At least two interacting native/relay implementations, plus helper supervision, must be reviewed. No numeric effort or cloud bill estimated without implementation/load measurements.

Operational cost: persistent client sockets and a resident helper, host carrier heartbeats, carrier DO message/storage calls, one HostRelay admission RPC per open, durable reporting, reconnect fanout, mixed-version state and rollback. Dedicated StreamRelay per-stream wake/joins may be avoided, but shared CarrierRelay activity concentrates CPU/queues and may worsen p95. No cloudflared download, tunnel/DNS allocation, account credentials or new secrets for this option.

Keep old /connect, /streams, ticket and proxy paths during opt-in. Capability refusal falls back once to existing WSS. A security refusal must not trigger an auth bypass or unpinned retry. Only fresh attempts migrate between transports; never replay an application write after carrier loss. Share cap/budget with old streams before enabling any new client. Rollback stops new mux opens, drains or explicitly closes admitted mux streams, settles counters and leaves old transport usable. No schema deletion while old-generation claims remain.

1. Parent and independent reviewer decide whether the described scope is justified. Do not ship any transport change based on these results. Obtain a disposable build environment with enough disk for native changes; current artifact-only constraints preclude it here. Keep this issue open pending parent disposition.
2. Implement the smallest real native+relay slice in isolation, including shared16cap, owner invalidation, budget reports, bounded windows and FIN ordering before timing. Use scratch HOME/XDG/TMPDIR inside owned worktree, fake failing tailscale first PATH, local fake identity, disposable daemon data and loopback-only Wrangler. Never run production daemon/tailnet or provision tunnels.
3. Exercise wrong pin, DPoP replay, unapproved/removed/revoked device, account move, token expiry,16/17 opens mixed with legacy spare, duplicate/replayed OPEN/report, quota across streams/day rollover, join timeout, slow reader, stalled stream, FIN with last response, connector drop and DO restart. Verify no cross-stream/account bytes and bounded memory. Failed security cases preclude parity claims even if TLS/RPC works.
4. Compare exact same daemon handler/payload, not T3 probe vs health. Use host/health and one seeded real events/event replay on the same disposable daemon. Interleave old/mux AB then BA pairs across30 fresh opens and50 identical RPCs per carrier. Inject ordered20ms and50ms one-way delays on each client-relay and relay-host leg, plus no-delay control. Apply identical directional byte delivery rules, never a global gate that serializes unrelated traffic. Record raw per-sample order, carrier/generation/logical/TLS connection identity and failures without credentials/payloads. Fresh logical opens must close the previous inner TLS/WS while retaining only the outer carrier. Separate concurrent-stream contention run. No performance sample accepted before correctness checks pass.
5. Report helper start and first carrier establishment separately AND first intent→connected including startup. Report later intent→connected, initialize result, first actual events/event and steady health RPC, p50/p95/raw samples separately. Preserve original published relay-probe markers/output as an independent series. Existing connected ends at inner WS, first_frame is merely first text. Never replace either with carrier READY. Report RSS, WS buffering, reconnect loss and fallback failures. No interleaved candidate samples exist in this handoff.
6. Only after independent review and explicit authorization consider an isolated non-production Cloudflare routing/load validation. Local delay experiments cannot establish production geography, proxy diversity or gain. No request for another production diagnostic deployment.

Recommendation: parent review the shared-slot/accounting and final-frame protocol first, then authorize a native-capable disposable proof environment if this scope is acceptable. Do not implement a storage-wait removal, loopback shim substitute, or production carrier from this evidence. Production gain remains unproved.
