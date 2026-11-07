# Host-only proof transitions

This supersedes the client-carrier proposal for this experiment only. Test code is not an adoption protocol.

| Event | Required transition before bytes / capacity release |
| --- | --- |
| OPEN | Current session + owner + online + budget admission; durable claim in common legacy/spare/pending 16-slot ledger before OPEN to host. |
| READY | Host registers loopback peer in Relay.streams before connect. Only that claim may become live. Expired/cancelled claim cannot revive. |
| CANCEL / expiry | Stop accepting DATA, cancel native stream. Keep capacity/debt until authoritative settlement. CANCEL dominates later READY. |
| Directional FIN | Drain earlier DATA to local reader, then acknowledge that direction. Delivery acknowledgment is separate from accounting. Both FINs close the logical stream, never the carrier. |
| Final report | Generation-bound cumulative total + report sequence committed once; lost acknowledgment retries do not add bytes again. Only settlement releases capacity. Timeout fails closed and retains debt. |
| Carrier loss | Cancel all logical streams, no application write replay. Unsettled debt remains charged against capacity. |
| Owner epoch | Invalidate carrier/claims on move, unregister, re-register. Stale OPEN/report cannot affect the new owner or claims. |

First falsification gate: can existing common authority provide these claim/report semantics without the separate StreamRelay lifecycle? Existing public `open` retains `take -> newStream -> StreamRelay.arm` on no-spare and `taken` on spare. Existing `report(stream, delta, closed)` has no generation/report identity. Probe those exact APIs before transport timing. Do not replace them with an independent cap or model. If this gate fails, return the concrete transition/API reason and no timing/parity claims.
