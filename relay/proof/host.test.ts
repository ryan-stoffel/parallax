import { expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { accountOf } from "../src/clerk";
import { HostRelay } from "../src/host";
import { MIN_FRAME_BYTES } from "../src/stream";
import type { ProofHost } from "./worker";
import { newHost, session, register, connectHost, opened, socket, testEnv } from "../test/helpers";

async function fixture() {
  const name = `proof_${crypto.randomUUID()}`;
  const token = await session(name), host = await newHost();
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  await control.next();
  const proof = JSON.parse(await control.next() as string);
  const carrier = opened(await socket(`/v1/hosts/${host.id}/proof-data?token=${proof.token}`));
  expect(JSON.parse(await carrier.next() as string).t).toBe("ready");
  const stub = testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id)) as unknown as DurableObjectStub<ProofHost>;
  const user = accountOf("https://clerk.test", name);
  return { host, token, control, carrier, stub, user };
}
// Closes the test's sockets before removing the host, as reconnect.test.ts does. Removing it first
// has the relay close the control socket while the test closes it too, and that crossed close can
// leave workerd unable to shut down after the run (PLX-1536).
async function closeThenUnregister(f: Awaited<ReturnType<typeof fixture>>) {
  f.control.ws.close(); f.carrier.ws.close();
  await Promise.all([f.control.closed, f.carrier.closed]);
  await f.stub.unregister(f.user);
}
it("shares 16 durable claims with a legacy spare and refuses the 17th pending proof open", async () => {
  const f = await fixture();
  try {
    f.control.ws.send(JSON.stringify({t:"spare"}));
    expect(JSON.parse(await f.control.next() as string).spare).toBe(true);
    const results = await Promise.all(Array.from({length:17}, () => f.stub.fetch("https://proof/proof-client", {headers:{upgrade:"websocket", "x-proof-user":f.user}})));
    expect(results.filter(r => r.status === 101)).toHaveLength(15);
    expect(results.filter(r => r.status === 429)).toHaveLength(2);
    const ledger = await runInDurableObject(f.stub, async (_, state) => state.storage.get<object>("streams"));
    expect(Object.keys(ledger!)).toHaveLength(16);
    for (const r of results) if (r.webSocket) { r.webSocket.accept(); r.webSocket.close(); }
  } finally { await closeThenUnregister(f); }
});
it("forwards final bytes before FIN, accounts original frame minimum, and keeps carrier for a fresh stream", async () => {
  const f = await fixture();
  const report = HostRelay.prototype.report;
  let release!: () => void;
  let waiting = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(HostRelay.prototype, "report").mockImplementation(async function(this: HostRelay, ...args) {
    await waiting;
    return report.apply(this, args);
  });
  try {
    for (let n = 0; n < 2; n++) {
      const clientPromise = socket(`/v1/hosts/${f.host.id}/proof-connect`, {authorization:`Bearer ${f.token}`});
      const message = JSON.parse(await f.control.next() as string);
      expect(message.proof).toBe(true);
      f.carrier.ws.send(JSON.stringify({t:"join",id:message.stream,token:message.token}));
      const client = opened(await clientPromise);
      expect(await client.next()).toBe("ready");
      expect(JSON.parse(await f.carrier.next() as string).t).toBe("ready");
      const payload = new TextEncoder().encode("final response");
      const frame = new Uint8Array(64 + payload.length);
      frame.set(new TextEncoder().encode(message.stream)); frame.set(payload, 64);
      f.carrier.ws.send(frame);
      f.carrier.ws.send(JSON.stringify({t:"fin",id:message.stream}));
      expect(new TextDecoder().decode(await client.next() as ArrayBuffer)).toBe("final response");
      expect(await client.closed).toBe(1000);
      client.ws.close();
      release();
      expect(JSON.parse(await f.carrier.next() as string).t).toBe("fin");
      await expect.poll(async () => (await f.stub.status(f.user))?.usage.bytes).toBe((n + 1) * MIN_FRAME_BYTES);
      waiting = new Promise<void>(resolve => { release = resolve; });
    }
  } finally { release(); spy.mockRestore(); await closeThenUnregister(f); }
});
// A client's TLS ClientHello goes right behind its upgrade (PLX-1568). The stream object holds it
// until plxd joins (PLX-1579), so the proof host must too, or every candidate's first stream ends.
it("holds a client's frame from before plxd's join and passes it on after", async () => {
  const f = await fixture();
  try {
    const response = socket(`/v1/hosts/${f.host.id}/proof-connect`, {authorization:`Bearer ${f.token}`});
    const message = JSON.parse(await f.control.next() as string);
    const client = opened(await response);
    client.ws.send(new Uint8Array([1,2,3]));
    await expect.poll(() => runInDurableObject(f.stub, (host: ProofHost) =>
      (host as unknown as {slots: Map<string, {early?: ArrayBuffer[]}>}).slots.get(message.stream)?.early?.length)).toBe(1);
    f.carrier.ws.send(JSON.stringify({t:"join",id:message.stream,token:message.token}));
    expect(await client.next()).toBe("ready");
    expect(JSON.parse(await f.carrier.next() as string).t).toBe("ready");
    const frame = new Uint8Array(await f.carrier.next() as ArrayBuffer);
    expect(new TextDecoder().decode(frame.slice(0,64))).toBe(message.stream);
    expect([...frame.slice(64)]).toEqual([1,2,3]);
    client.ws.close();
    await client.closed;
  } finally { await closeThenUnregister(f); }
});
// plxd drops a `fin` for a stream it hasn't joined yet, then joins it (PLX-1605). Without a second
// `fin`, plxd's end of that stream stays forever, and the 16th such end refuses every new stream.
it("answers plxd's join or fin of a stream that already ended with fin", async () => {
  const f = await fixture();
  try {
    const response = socket(`/v1/hosts/${f.host.id}/proof-connect`, {authorization:`Bearer ${f.token}`});
    const message = JSON.parse(await f.control.next() as string);
    const client = opened(await response);
    client.ws.close();
    await client.closed;
    const fin = {t:"fin", id:message.stream};
    expect(JSON.parse(await f.carrier.next() as string)).toEqual(fin);
    f.carrier.ws.send(JSON.stringify({t:"join",id:message.stream,token:message.token}));
    expect(JSON.parse(await f.carrier.next() as string)).toEqual(fin);
    f.carrier.ws.send(JSON.stringify(fin));
    expect(JSON.parse(await f.carrier.next() as string)).toEqual(fin);
  } finally { await closeThenUnregister(f); }
});
