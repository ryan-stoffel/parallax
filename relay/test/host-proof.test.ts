// PLX-1475: observed authority behavior, not desired carrier guarantees or transport timings.
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { accountOf } from "../src/clerk";
import { type HostRelay, MAX_STREAMS } from "../src/host";
import type { StreamRelay } from "../src/stream";
import { connectHost, newHost, register, session, testEnv } from "./helpers";

async function fixture() {
  const user = `proof_${crypto.randomUUID()}`;
  const host = await newHost();
  expect((await register(host, await session(user))).status).toBe(200);
  const { control } = await connectHost(host);
  await control.next();
  const stub = testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id));
  return { host, control, stub, user: accountOf("https://clerk.test", user) };
}
function observation(code: string, detail: Record<string, unknown>) {
  console.log(JSON.stringify({ issue: "PLX-1475", kind: "authority-gate", code, ...detail }));
}

it("public admission still arms a separate StreamRelay before returning a fresh slot", async () => {
  const { host, stub, user, control } = await fixture();
  try {
    const result = await stub.open(user);
    if ("error" in result) throw new Error(result.error);
    const stream = testEnv.STREAMS.get(testEnv.STREAMS.idFromString(result.stream));
    const armed = await runInDurableObject(stream, (_: StreamRelay, state) =>
      state.storage.get<{ hostId: string; stream: string }>("armed"));
    expect(armed?.hostId).toBe(host.id);
    expect(armed?.stream).toBe(result.stream);
    observation("STREAM_AUTHORITY_RETAINS_ARM", { armedBeforeOpenReturned: true });
  } finally { await stub.unregister(user); control.ws.close(); }
});

it("a committed report cannot be retried exactly once after losing its acknowledgment", async () => {
  const { stub, user, control } = await fixture();
  try {
    // Commit, then discard the answer. This probes a new carrier reusing the delta API,
    // not a claim that the current StreamRelay retries a final report this way.
    await stub.report("proof-closed-slot", 16384, true);
    const first = (await stub.status(user))!.usage.bytes;
    await stub.report("proof-closed-slot", 16384, true);
    const retried = (await stub.status(user))!.usage.bytes;
    expect(first).toBe(16384);
    expect(retried).toBe(32768);
    observation("REPORT_RETRY_DOUBLE_CHARGES", { first, retried });
  } finally { await stub.unregister(user); control.ws.close(); }
});

it("a delayed old-owner report has no epoch with which to reject its charge", async () => {
  const { host, stub, user, control } = await fixture();
  const next = `proof_${crypto.randomUUID()}`;
  const nextUser = accountOf("https://clerk.test", next);
  try {
    expect((await register(host, await session(next))).status).toBe(200);
    expect(await stub.status(user)).toBeNull();
    const before = (await stub.status(nextUser))!.usage.bytes;
    await stub.report("old-owner-stream", 16384, true);
    const after = (await stub.status(nextUser))!.usage.bytes;
    expect(after - before).toBe(16384);
    observation("REPORT_HAS_NO_OWNER_EPOCH", { chargedCurrentOwner: after - before });
  } finally { await stub.unregister(nextUser); control.ws.close(); }
});

it.fails("17 concurrent public opens share the legacy spare and pending 16-slot ledger", async () => {
  const { stub, user, control } = await fixture();
  try {
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse(await control.next() as string) as { stream: string; spare: boolean };
    expect(spare.spare).toBe(true);
    const results = await Promise.all(Array.from({ length: 17 }, () => stub.open(user)));
    const accepted = results.filter((r) => !("error" in r));
    const refused = results.filter((r) => "error" in r);
    const count = await runInDurableObject(stub, async (_: HostRelay, state) =>
      Object.keys((await state.storage.get<object>("streams")) ?? {}).length);
    const distinct = new Set(accepted.map((r) => "stream" in r ? r.stream : "")).size;
    observation("COMMON_CAP_GATE_FAILED", { attempts: 17, accepted: accepted.length,
      distinct, slots: count, refusals: refused.length,
      spareTaken: accepted.some((r) => "stream" in r && r.stream === spare.stream),
      candidateClaimExercised: false });
    // Expected failure is intentional: keep the proof reviewable without changing the
    // production authority in this issue. A fix must turn this into an ordinary passing test.
    expect(accepted).toHaveLength(MAX_STREAMS);
    expect(refused).toEqual([{ status: 429, error: "too_many_streams" }]);
    expect(distinct).toBe(MAX_STREAMS);
    expect(count).toBe(MAX_STREAMS);
  } finally { await stub.unregister(user); control.ws.close(); }
});
