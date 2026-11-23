// The host object takes plxd's control socket by its proof tag, not by its being open (PLX-1641).
// workerd #7595 can make a socket the relay closed read open again after two hibernations. These
// tests stand in for it by overriding a replaced socket's `readyState`.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import type { HostRelay } from "../src/host";
import { connectHost, type Host, newHost, opened, register, session, type Socket, socket, testEnv } from "./helpers";

type Open = { t: string; stream: string; token: string; spare?: boolean };

/**
 * A registered host whose control socket a second one replaced, with the first made to read open
 * again, as #7595 leaves it. The first is a socket the object holds with the first control
 * socket's tags, whose other end never answers the relay's close, so the object keeps listing it.
 */
async function replaced() {
  const user = `control_${crypto.randomUUID()}`;
  const host = await newHost();
  const token = await session(user);
  expect((await register(host, token)).status).toBe(200);
  const stub = testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id));
  const { control: first } = await connectHost(host);
  await first.next();
  let stale: WebSocket | undefined;
  let silent: WebSocket | undefined;
  await runInDurableObject(stub, (_: HostRelay, state) => {
    const tags = state.getTags(state.getWebSockets("host")[0]!);
    [silent, stale] = Object.values(new WebSocketPair());
    state.acceptWebSocket(stale!, tags);
  });
  const { control } = await connectHost(host);
  await control.next();
  expect(await first.closed).toBe(4409);
  await runInDurableObject(stub, (_: HostRelay, state) => {
    expect(state.getWebSockets("host")).toContain(stale);
    Object.defineProperty(stale!, "readyState", { get: () => WebSocket.OPEN });
  });
  return { host, token, stub, stale: stale!, silent: silent!, control };
}

/** The next message on `control` within `ms`, or "none". */
const within = (control: Socket, ms = 2_000) =>
  Promise.race([control.next(), new Promise<string>((resolve) => setTimeout(() => resolve("none"), ms))]);

function connect(host: Host, token: string) {
  return socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}` });
}

/** The streams `host`'s object counts as open. */
const streams = (stub: DurableObjectStub<HostRelay>) =>
  runInDurableObject(stub, async (_: HostRelay, state) => Object.keys((await state.storage.get<object>("streams")) ?? {}));

/** A client's stream through `control`, which must get its `open` within 2 s, joined and ready. */
async function streamThrough(host: Host, token: string, control: Socket) {
  const client = opened(await connect(host, token));
  const message = await within(control);
  expect(message).not.toBe("none");
  const open = JSON.parse(message as string) as Open;
  const side = opened(await socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`));
  expect(await client.next()).toBe("ready");
  expect(await side.next()).toBe("ready");
}

it("sends a client's open to the current control socket, not a replaced one that reads open", async () => {
  const { host, token, control } = await replaced();
  await streamThrough(host, token, control);
});

it("still knows the current control socket after its object is evicted", async () => {
  const user = `control_${crypto.randomUUID()}`;
  const host = await newHost();
  const token = await session(user);
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  await control.next();
  await evictDurableObject(testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id)));
  await streamThrough(host, token, control);
});

it("ignores a replaced socket's frames even while it reads open: a guest list, a spare request", async () => {
  const { stub, stale, control } = await replaced();
  const guests = JSON.stringify({
    t: "guests",
    links: [{ link: "A".repeat(22), pass: "0".repeat(64), expires: Date.now() / 1000 + 3600 }],
  });
  await runInDurableObject(stub, async (relay: HostRelay) => {
    await relay.webSocketMessage(stale, guests);
    await relay.webSocketMessage(stale, JSON.stringify({ t: "spare" }));
  });
  const stored = await runInDurableObject(stub, async (_: HostRelay, state) => state.storage.get("guests"));
  expect(stored).toBeUndefined();
  expect(await streams(stub)).toEqual([]);

  // The current socket's frames still count, and its first message is this spare's open.
  control.ws.send(JSON.stringify({ t: "spare" }));
  const spare = JSON.parse((await control.next()) as string) as Open;
  expect(spare).toMatchObject({ t: "open", spare: true });
  expect(await streams(stub)).toEqual([spare.stream]);
});
