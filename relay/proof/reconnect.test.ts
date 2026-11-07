import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { accountOf } from "../src/clerk";
import { MIN_FRAME_BYTES } from "../src/stream";
import type { ProofHost } from "./worker";
import { newHost, session, register, connectHost, opened, socket, testEnv, call, type Socket } from "../test/helpers";

async function fixture() {
  const name = `proof_${crypto.randomUUID()}`;
  const token = await session(name), host = await newHost();
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  await control.next();
  const carrier = await carrierFrom(control, host.id);
  const stub = testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id)) as unknown as DurableObjectStub<ProofHost>;
  const user = accountOf("https://clerk.test", name);
  return { host, token, control, carrier, stub, user };
}
async function carrierFrom(control: Socket, host: string) {
  const proof = JSON.parse(await control.next() as string);
  expect(proof.t).toBe("proof");
  const carrier = opened(await socket(`/v1/hosts/${host}/proof-data?token=${proof.token}`));
  expect(JSON.parse(await carrier.next() as string).t).toBe("ready");
  return carrier;
}
async function logical(f: Awaited<ReturnType<typeof fixture>>, carrier: Socket, control = f.control) {
  const response = socket(`/v1/hosts/${f.host.id}/proof-connect`, {authorization:`Bearer ${f.token}`});
  const message = JSON.parse(await control.next() as string);
  expect(message.proof).toBe(true);
  carrier.ws.send(JSON.stringify({t:"join",id:message.stream,token:message.token}));
  const client = opened(await response);
  expect(await client.next()).toBe("ready");
  expect(JSON.parse(await carrier.next() as string).t).toBe("ready");
  return { client, id:message.stream, token:message.token };
}
async function chargedBothWays(client: Socket, carrier: Socket, id: string) {
  client.ws.send(new Uint8Array([1,2,3]));
  const frame = new Uint8Array(await carrier.next() as ArrayBuffer);
  expect(new TextDecoder().decode(frame.slice(0,64))).toBe(id);
  expect([...frame.slice(64)]).toEqual([1,2,3]);
  carrier.ws.send(frame);
  expect([...new Uint8Array(await client.next() as ArrayBuffer)]).toEqual([1,2,3]);
}
async function ledger(f: Awaited<ReturnType<typeof fixture>>) {
  return runInDurableObject(f.stub, async (_, state) => ({
    traffic: await state.storage.get<{bytes:number}>("traffic"),
    streams: await state.storage.get<object>("streams"),
    proof: await state.storage.get<number>("lastProof"),
  }));
}
async function close(...sockets: Socket[]) {
  for (const s of sockets) s.ws.close();
  await Promise.all(sockets.map(s => s.closed));
}
it("authority reconnect settles buffered charged bytes without resetting traffic", async () => {
  const f = await fixture();
  const old = await logical(f, f.carrier);
  let replacement: Socket | undefined, next: Socket | undefined;
  try {
    await chargedBothWays(old.client, f.carrier, old.id);
    expect((await ledger(f)).traffic?.bytes ?? 0).toBe(0);
    const connected = await connectHost(f.host);
    next = connected.control;
    expect(JSON.parse(await next.next() as string).t).toBe("ready");
    replacement = await carrierFrom(next, f.host.id);
    expect(await old.client.closed).toBe(1000);
    old.client.ws.close();
    const kept = await ledger(f);
    expect(kept.traffic?.bytes).toBe(2 * MIN_FRAME_BYTES);
    expect(Object.keys(kept.streams ?? {})).toHaveLength(0);
    expect((await f.stub.status(f.user))?.online).toBe(true);
    const fresh = await logical(f, replacement, next);
    await chargedBothWays(fresh.client, replacement, fresh.id);
    expect(fresh.id).not.toBe(old.id);
    await close(fresh.client);
    await expect.poll(async () => (await ledger(f)).traffic?.bytes).toBe(4 * MIN_FRAME_BYTES);
  } finally {
    await close(old.client, f.control, f.carrier, ...[next,replacement].filter((s): s is Socket => !!s));
    await f.stub.unregister(f.user);
  }
});
it("data carrier replacement keeps control online, settles once, and never replays old logical bytes", async () => {
  const f = await fixture();
  const old = await logical(f, f.carrier);
  let replacement: Socket | undefined;
  try {
    const before = (await ledger(f)).proof;
    await chargedBothWays(old.client, f.carrier, old.id);
    // The peer data socket disappears without changing the authority/control connection.
    f.carrier.ws.close();
    await old.client.closed;
    await close(old.client, f.carrier);
    expect((await f.stub.status(f.user))?.online).toBe(true);
    expect((await ledger(f)).proof).toBe(before);
    await expect.poll(async () => (await ledger(f)).traffic?.bytes).toBe(2 * MIN_FRAME_BYTES);
    const unavailable = await socket(`/v1/hosts/${f.host.id}/proof-connect`, {authorization:`Bearer ${f.token}`});
    expect(unavailable).toBeInstanceOf(Response);
    expect((unavailable as Response).status).toBe(503);
    expect((await call(`/v1/hosts/${f.host.id}/proof-carrier`, {
      method:"POST", token:f.token, body:JSON.stringify({replace:true}),
    })).status).toBe(200);
    replacement = await carrierFrom(f.control, f.host.id);
    replacement.ws.send(JSON.stringify({t:"join",id:old.id,token:old.token}));
    const stale = new Uint8Array(67);
    stale.set(new TextEncoder().encode(old.id)); stale.set([9,9,9],64);
    replacement.ws.send(stale);
    const fresh = await logical(f, replacement);
    expect(fresh.id).not.toBe(old.id);
    await chargedBothWays(fresh.client, replacement, fresh.id);
    await close(fresh.client);
    await expect.poll(async () => (await ledger(f)).traffic?.bytes).toBe(4 * MIN_FRAME_BYTES);
    expect((await ledger(f)).proof).toBe(before);
  } finally {
    await close(old.client,f.carrier,f.control,...(replacement ? [replacement] : []));
    await f.stub.unregister(f.user);
  }
});
