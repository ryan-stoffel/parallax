# Host-only feasibility slice

Base: 98c78ca4e5a735c22c12c24148e6eed126fd88c4. Production default unchanged.

| Event | Action before forwarding | Completion / failure |
|---|---|---|
| Claim | Original HostRelay admit + durable pending reservation, common 16 ledger | Local arm replaces separate StreamRelay arm only for proof route |
| Readiness | Single-use data-carrier token issued on authenticated host control, per-stream token checked on JOIN | Both client and host must join before ready or ciphertext |
| Cancel / expiry | Mark ending, stop accepting DATA | Ordered FIN then existing delta report and slot release |
| Directional FIN | Prior DATA sent before FIN notification | Native pipe drains and waits for close response before Holding cleanup. No replay |
| Carrier loss | Stop all streams | Ordered drain cannot be asserted on loss, close and settle once locally |
| Report | Original frame minimum / byte threshold / timer and HostRelay.report | No retry/dedup semantics added, report failure is unsupported |
| Epoch change | Original control proof and settleStreams | Close proof streams, invalidate carrier token; no stream migration |

Test-only subclass and debug-only native adapter. Local per-stream sockets bridge native pipe into
one persistent host network socket. Client sockets remain fresh. This serial feasibility adapter
has bounded channel queues but shared head-of-line blocking. Not production parity.

Unproved: report commit/ack loss and crash debt, stale-owner delayed reports, hibernation/restart
reconciliation, total resident memory, slow-reader fairness, control floods, full revocation races,
UTC rollover, proxy diversity. These block adoption/security parity. No comparative timing may be
accepted until implemented-slice cap/accounting/final HTTP response/WS drain gates pass.
