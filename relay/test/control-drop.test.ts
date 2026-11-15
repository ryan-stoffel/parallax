// A dropped control link doesn't fail a client's connect (PLX-1547).
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { accountOf } from "../src/clerk";
import { HOST_WAIT, type HostRelay, LIMITS, MAX_STREAMS } from "../src/host";
import { connectHost, type Host, newHost, opened, register, session, socket, testEnv } from "./helpers";

type Open = { t: string; stream: string; token: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A registered host with its control socket open, its owner's token and account, and its object. */
async function online() {
  const user = `drop_${crypto.randomUUID()}`;
  const host = await newHost();
  const token = await session(user);
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  expect(JSON.parse((await control.next()) as string)).toMatchObject({ t: "ready" });
  const stub = testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id));
  return { host, token, control, stub, user: accountOf("https://clerk.test", user) };
}

/** A client's stream opened with its Clerk token: the socket or the refusal. */
function connect(host: Host, token: string) {
  return socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}` });
}

/** plxd's side of the stream `open` announced. */
function join(host: Host, open: Open) {
  return socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`);
}

/** plxd's control socket again, holding no streams, and the `ready` it opens with. */
async function reconnect(host: Host) {
  const { control } = await connectHost(host, []);
  expect(JSON.parse((await control.next()) as string)).toMatchObject({ t: "ready" });
  return control;
}

it("gives a client that connects 1 s into a silent control link its stream once plxd reconnects", async () => {
  const { host, token, control } = await online();
  // The link goes silent with no close: nothing plxd's socket is sent arrives, and plxd sends nothing.
  await sleep(1_000);
  const client = opened(await connect(host, token));
  const lost = JSON.parse((await control.next()) as string) as Open;
  expect(lost.t).toBe("open");

  // plxd notices and reconnects. It never heard of the stream, so it doesn't list it.
  const again = await reconnect(host);
  expect(await control.closed).toBe(4409);
  const open = JSON.parse((await again.next()) as string) as Open;
  expect(open).toMatchObject({ t: "open", stream: lost.stream });
  expect(open.token).not.toBe(lost.token);
  // The lost `open`'s token no longer joins.
  const stale = await join(host, lost);
  expect(stale instanceof Response && stale.status).toBe(404);

  const side = opened(await join(host, open));
  expect(await client.next()).toBe("ready");
  expect(await side.next()).toBe("ready");
  client.ws.send(new Uint8Array([1, 2]));
  expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
});

it("closes at reconnect a stream plxd was asked to join longer ago than its client waits", async () => {
  const { host, token, control, stub } = await online();
  const client = opened(await connect(host, token));
  const { stream } = JSON.parse((await control.next()) as string) as Open;
  await runInDurableObject(stub, async (_: HostRelay, state) => {
    await state.storage.put("streams", { [stream]: { at: Date.now() - 31_000 } });
  });
  await reconnect(host);
  expect(await client.closed).toBe(1000);
});

it("holds a connect while plxd reconnects, and it gets its stream", async () => {
  const { host, token, control } = await online();
  control.ws.close(1000);
  await control.closed;
  const started = Date.now();
  const connecting = connect(host, token);
  await sleep(500);
  const again = await reconnect(host);
  const client = opened(await connecting);
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(Date.now() - started).toBeLessThan(HOST_WAIT);
  const open = JSON.parse((await again.next()) as string) as Open;
  const side = opened(await join(host, open));
  expect(await client.next()).toBe("ready");
  expect(await side.next()).toBe("ready");
});

it("counts a waiting connect, so the limit still answers at once, and holds no more than fit", async () => {
  const { host, control, stub, user } = await online();
  control.ws.close(1000);
  await control.closed;
  const started = Date.now();
  const opens = Array.from({ length: LIMITS.opens }, () => stub.open(user));
  expect(await stub.open(user)).toEqual({ status: 429, error: "rate_limited" });
  // Past the 16 a host's streams can take, the rest don't wait.
  const extra = opens.slice(MAX_STREAMS);
  expect(await Promise.all(extra)).toEqual(
    Array(LIMITS.opens - MAX_STREAMS).fill({ status: 503, error: "host_offline" }),
  );
  expect(Date.now() - started).toBeLessThan(1_000);
  await reconnect(host);
  const waited = await Promise.all(opens.slice(0, MAX_STREAMS));
  expect(waited.filter((r) => "stream" in r)).toHaveLength(MAX_STREAMS);
});

it("answers host_offline after the wait when plxd stays away, and at once when it's been gone", async () => {
  const { host, token, control } = await online();
  control.ws.close(1000);
  await control.closed;
  const started = Date.now();
  const refused = await connect(host, token);
  expect(refused instanceof Response && refused.status).toBe(503);
  expect(Date.now() - started).toBeGreaterThanOrEqual(HOST_WAIT - 100);

  // A host whose plxd this object hasn't seen leave, as after the object was evicted.
  const user = `drop_${crypto.randomUUID()}`;
  const absent = await newHost();
  const absentToken = await session(user);
  expect((await register(absent, absentToken)).status).toBe(200);
  const at = Date.now();
  const offline = await connect(absent, absentToken);
  expect(offline instanceof Response && offline.status).toBe(503);
  expect(Date.now() - at).toBeLessThan(1_000);
}, HOST_WAIT + 10_000);
