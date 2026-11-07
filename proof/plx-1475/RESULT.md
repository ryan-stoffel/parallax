# Execution result: STOP_COMMON_CAP_GATE

Source: develop 265b931bb592bd0bbb0131b55f248d67a30c9f2d. This result supersedes the original HANDOFF.md's proposed next step, not its historical evidence.

The required common-authority gate failed before implementing a native host carrier. In local Cloudflare Miniflare, a generated fake account/host requested a legacy spare, then issued 17 concurrent real HostRelay.open RPCs. All 17 returned distinct stream ids, with 17 durable slots and zero refusals. No cap table/model was substituted. The first normal test failure is in authority-first-failure.json. The second run's observations/log and report are in local/. The cap test is deliberately `it.fails`: green CI means the known violation reproduced, NOT that the cap passed. Fix tracked separately as PLX-1476.

Concrete transition: `take` checks the stream count before `newStream` awaits another object's `arm`; insertion happens after that await. There is no durable pending reservation spanning that boundary. This suggests the race location, rather than proving its precise scheduling in production. It violates the proof's prerequisite, so no mixed-route capacity or comparative timing claim is valid.

Other executable API observations:

- Public `open` returns only after the new StreamRelay is armed. A wrapper reusing that API has not removed that dependency.
- Discard a committed `report(id, 16384, true)` acknowledgment, then call it again: usage becomes 32768. It is a delta API, not a cumulative deduplicated carrier settlement API.
- Move the registered host to a second fake user, then submit an old-owner report: current-owner usage increases by 16384. The API has no owner epoch. This is not a claim that today's StreamRelay executes this synthetic stale sequence or has an exploitable external reporting endpoint.

Reproduction: from relay, `node scripts/proof-authority.mjs`. It allowlists environment variables, uses disposable HOME/XDG/TMPDIR and a failing tailscale first in PATH, and invokes only local Miniflare with generated JWKS. Local dependencies were reused read-only from plx-1466 through an owned symlink, with no install, native rebuild or cleanup of others' files. The normal Linux relay integration step also runs the probe and uploads logs/results/source pins using the existing pinned artifact action. Native baseline output is retained separately; it is not candidate evidence.

Unimplemented/unproved: native host adapter; candidate routing; fresh outer WSS and inner TLS/WS; Relay.streams metadata on a candidate; wrong-pin, fresh/replayed DPoP, pending/removed/revoked device and revoke during open; stale OPEN after epoch changes; mixed legacy/new 17-way cap; cumulative report dedup/ack loss and bounded debt; quota exhaustion/UTC rollover; pending expiry races; slow readers/control flood/queue memory/fairness; directional FIN/final HTTP response/WS close drain with delayed settlement; lost carrier/restart/hibernation reconciliation; startup/unavailable/restarted-host cases; AB/BA 30 fresh connects and 50 identical health RPCs at ordered 0/20/50 ms delays, initialize and actual first event. No samples or pass markers for these are fabricated.

This is a negative prerequisite result, not a transport feasibility run or a falsification of host-only routing. It does not establish that a faithful implementation requires unbounded redesign. No security/adoption/T3 parity, production savings, release or deployment. PLX-1475 remains open. Parent owns independent review/CI disposition and any further implementation decision. Do not merge as completed transport work.
