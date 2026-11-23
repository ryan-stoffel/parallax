// The hosted browser client's tokens, CORS, and stream marks, and guest links' passes and budgets
// (0108, PLX-1616).
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { base64url, sha256 } from "../src/crypto";
import { GUEST_LIMITS, HostRelay, LIMITS, MAX_DAILY_BYTES, registerMessage } from "../src/host";
import worker, { type Env } from "../src/index";
import { MIN_FRAME_BYTES, REPORT_BYTES, StreamRelay } from "../src/stream";
import {
  BASE,
  call,
  connectHost,
  type Host,
  newHost,
  opened,
  register,
  session,
  type Socket,
  socket,
  testEnv,
} from "./helpers";

type Open = { t: string; stream: string; token: string; spare?: boolean; client?: string; guest?: string };

const APP = "https://app.parallax.codes";
const MiB = 1_048_576;

/** A token from the hosted client's OAuth application for `user`. */
const hostedToken = (user: string) => session(user, { client_id: "hosted_app", sid: undefined });

/** A registered, connected host, its owner's full token, and its object. */
async function online() {
  const user = `guests_${crypto.randomUUID()}`;
  const host = await newHost();
  const token = await session(user);
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  expect(JSON.parse((await control.next()) as string)).toMatchObject({ t: "ready" });
  return { host, user, token, control, stub: testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id)) };
}

/** The next message on plxd's control socket, parsed. */
const next = async (control: Socket) => JSON.parse((await control.next()) as string) as Open;

/** plxd's spare stream, joined. */
async function spare(host: Host, control: Socket) {
  control.ws.send(JSON.stringify({ t: "spare" }));
  const open = await next(control);
  expect(open.spare).toBe(true);
  opened(await join(host, open));
  return open;
}

function join(host: Host, open: Open) {
  return socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`);
}

/** A stream opened with `ticket`: the client's socket and the `open` plxd got for it. */
async function redeem(host: Host, control: Socket, ticket: string) {
  const client = opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${ticket}`));
  return { client, open: await next(control) };
}

/** Both ends of a stream opened with `ticket`, joined and ready. */
async function joined(host: Host, control: Socket, ticket: string) {
  const { client, open } = await redeem(host, control, ticket);
  const side = opened(await join(host, open));
  expect(await client.next()).toBe("ready");
  expect(await side.next()).toBe("ready");
  return { client, side, open };
}

/** A guest link as plxd makes one: its id, its relay pass as the guest sends it, and the pass's
 *  SHA-256 in hex as plxd sends the relay. */
async function newLink() {
  const pass = crypto.getRandomValues(new Uint8Array(32));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pass));
  return {
    id: base64url(crypto.getRandomValues(new Uint8Array(16))),
    pass: base64url(pass),
    hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
type Link = Awaited<ReturnType<typeof newLink>>;

/** The guest links the host's object holds. */
const stored = (host: Host) =>
  runInDurableObject(testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id)), async (_: HostRelay, state) =>
    Object.keys((await state.storage.get<object>("guests")) ?? {}),
  );

/** plxd's list of live links, sent on its control socket, once the host's object holds it. */
async function share(host: Host, control: Socket, links: Link[], expires = Date.now() / 1000 + 3600) {
  control.ws.send(JSON.stringify({ t: "guests", links: links.map((link) => ({ link: link.id, pass: link.hash, expires })) }));
  const expected = expires * 1000 > Date.now() ? links.map((link) => link.id).sort() : [];
  await expect.poll(async () => (await stored(host)).sort()).toEqual(expected);
}

const guestTicket = (host: Host, authorization?: string) =>
  call(`/v1/hosts/${host.id}/guest-tickets`, {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

/** A guest's ticket for `link`, which must be granted. */
async function granted(host: Host, link: Link) {
  const response = await guestTicket(host, `Guest ${link.id}.${link.pass}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { ticket: string }).ticket;
}

/** What the relay answers a guest's ticket request for `link`. */
async function refusal(host: Host, link: Link, pass = link.pass) {
  const response = await guestTicket(host, `Guest ${link.id}.${pass}`);
  return { status: response.status, ...((await response.json()) as object) };
}

describe("the hosted client's token", () => {
  it("lists hosts and gets a ticket for a stream marked hosted, never the spare", async () => {
    const { host, user, control } = await online();
    const token = await hostedToken(user);
    const list = await call("/v1/hosts", { token });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { hosts: { hostId: string }[] }).hosts.map((h) => h.hostId)).toEqual([host.id]);
    const waiting = await spare(host, control);

    const ticket = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token });
    expect(ticket.status).toBe(200);
    const { client, open } = await redeem(host, control, ((await ticket.json()) as { ticket: string }).ticket);
    expect(open).toMatchObject({ t: "open", client: "hosted" });
    expect(open.stream).not.toBe(waiting.stream);
    expect(open.spare).toBeUndefined();
    const side = opened(await join(host, open));
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
  });

  // Each signed-in route but those two, and the header-token connect (`relayed()`), which could
  // otherwise take the spare or open an unmarked stream.
  const refused: [string, string, (host: Host) => string][] = [
    ["POST", "register", () => "/v1/hosts"],
    ["DELETE", "remove a host", (host) => `/v1/hosts/${host.id}`],
    ["POST", "move a host", (host) => `/v1/hosts/${host.id}/move`],
    ["POST", "register a device", () => "/v1/devices"],
    ["DELETE", "remove a device", () => "/v1/devices/device"],
    ["GET", "an unknown route", (host) => `/v1/hosts/${host.id}`],
  ];
  it.each(refused)("gets 401 for %s, to %s", async (method, _, path) => {
    const { host, user, token } = await online();
    const response = await call(path(host), { method, token: await hostedToken(user), body: method === "POST" ? "{}" : undefined });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 401, body: { error: "unauthorized" } });
    // Nothing it asked happened: the host is still its owner's.
    const list = (await (await call("/v1/hosts", { token })).json()) as { hosts: unknown[] };
    expect(list.hosts).toHaveLength(1);
  });

  it("gets 401 opening /connect with it in the Authorization header, and takes nothing", async () => {
    const { host, user, control, stub } = await online();
    const waiting = await spare(host, control);
    const open = vi.spyOn(HostRelay.prototype, "open");
    try {
      const response = await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${await hostedToken(user)}` });
      expect(response instanceof Response && response.status).toBe(401);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
    const streams = await runInDurableObject(stub, async (_: HostRelay, state) => state.storage.get("streams"));
    expect(streams).toEqual({ [waiting.stream]: { spare: true } });
  });

  it("can't stand in for the account a move takes a host from", async () => {
    const { host, user, token } = await online();
    const signature = await host.sign(registerMessage(host.id, await sha256(token)));
    const move = async (from: string) => {
      const response = await call(`/v1/hosts/${host.id}/move`, {
        method: "POST",
        token,
        body: JSON.stringify({ hostId: host.id, jwk: host.jwk, signature, from }),
      });
      return { status: response.status, ...((await response.json()) as object) };
    };
    expect(await move(await hostedToken(user))).toEqual({ status: 401, error: "unauthorized" });
    expect(await move(token)).toMatchObject({ status: 200 });
  });
});

describe("CORS", () => {
  const paths: [string, (host: Host) => string][] = [
    ["GET", () => "/v1/hosts"],
    ["POST", (host) => `/v1/hosts/${host.id}/tickets`],
    ["POST", (host) => `/v1/hosts/${host.id}/guest-tickets`],
  ];
  it.each(paths)("answers a %s preflight from the hosted client's origin only", async (method, path) => {
    const host = await newHost();
    const preflight = (origin: string, requested = method) =>
      call(path(host), { method: "OPTIONS", headers: { origin, "access-control-request-method": requested } });
    const allowed = await preflight(APP);
    expect(allowed.status).toBe(204);
    expect(Object.fromEntries(allowed.headers)).toMatchObject({
      "access-control-allow-origin": APP,
      "access-control-allow-methods": method,
      "access-control-allow-headers": "authorization",
    });
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
    for (const refused of [
      await preflight("https://evil.example"),
      await preflight("https://parallax-web-staging.stoffel-thomas-ryan.workers.dev"),
      await preflight("null"),
      await preflight(APP, method === "GET" ? "DELETE" : "GET"),
    ]) {
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("lets the client's origin read every answer on its routes, refusals too, and no other origin", async () => {
    const { host, user } = await online();
    const token = await hostedToken(user);
    const list = await call("/v1/hosts", { token, headers: { origin: APP } });
    expect(list.status).toBe(200);
    expect(list.headers.get("access-control-allow-origin")).toBe(APP);
    expect(list.headers.get("vary")).toContain("origin");
    expect(list.headers.get("access-control-expose-headers")).toBe("retry-after");
    const unsigned = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", headers: { origin: APP } });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("access-control-allow-origin")).toBe(APP);
    const other = await call("/v1/hosts", { token, headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    // Any other route answers no origin, the client's included.
    const removal = await call(`/v1/hosts/${host.id}`, { method: "DELETE", token, headers: { origin: APP } });
    expect(removal.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await call(`/v1/hosts/${host.id}`, {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "DELETE" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("guest links", () => {
  it("gives the pass's holder a ticket, once, for a new stream marked with its link, never the spare", async () => {
    const { host, control } = await online();
    const link = await newLink();
    await share(host, control, [link]);
    const waiting = await spare(host, control);
    const ticket = await granted(host, link);
    const { client, open, side } = await joined(host, control, ticket);
    expect(open).toMatchObject({ t: "open", guest: link.id });
    expect(open.client).toBeUndefined();
    expect(open.stream).not.toBe(waiting.stream);
    client.ws.send(new Uint8Array([7]));
    expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(new Uint8Array([7]));
    const again = await socket(`/v1/hosts/${host.id}/connect?ticket=${ticket}`);
    expect(again instanceof Response && again.status).toBe(401);
  });

  it("refuses no pass, a malformed one, a wrong one, an expired link, and an unknown one alike", async () => {
    const { host, control } = await online();
    const [link, expired, unknown] = [await newLink(), await newLink(), await newLink()];
    await share(host, control, [link]);
    const { pass: wrong } = await newLink();
    const unauthorized = { status: 401, error: "unauthorized" };
    for (const header of [undefined, `Bearer ${link.pass}`, `Guest ${link.id}`, `Guest ${link.id}.${link.pass}x`, `Guest x.${link.pass}`])
      expect({ status: (await guestTicket(host, header)).status }).toEqual({ status: 401 });
    expect(await refusal(host, link, wrong)).toEqual(unauthorized);
    expect(await refusal(host, unknown)).toEqual(unauthorized);
    // A link listed already expired isn't kept, and one that expires after is refused from then.
    await share(host, control, [link, expired], Date.now() / 1000 - 1);
    expect(await stored(host)).toEqual([]);
    await share(host, control, [expired], Date.now() / 1000 + 1);
    expect(await refusal(host, expired)).toEqual({ status: 200, ticket: expect.any(String) });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await refusal(host, expired)).toEqual(unauthorized);
  });

  it("forgets a link plxd withdraws, and its ticket no longer opens", async () => {
    const { host, control } = await online();
    const [kept, removed] = [await newLink(), await newLink()];
    await share(host, control, [kept, removed]);
    const ticket = await granted(host, removed);
    await share(host, control, [kept]);
    expect(await refusal(host, removed)).toEqual({ status: 401, error: "unauthorized" });
    const late = await socket(`/v1/hosts/${host.id}/connect?ticket=${ticket}`);
    expect(late instanceof Response && late.status).toBe(401);
    await granted(host, kept);
  });

  it("forgets every link when plxd's control socket closes or is replaced, until plxd sends them again", async () => {
    const { host, control } = await online();
    const link = await newLink();
    await share(host, control, [link]);
    control.ws.close(1000);
    await control.closed;
    await expect.poll(() => stored(host)).toEqual([]);

    const { control: back } = await connectHost(host);
    await back.next();
    await share(host, back, [link]);
    const { control: replaced } = await connectHost(host);
    await replaced.next();
    expect(await back.closed).toBe(4409);
    expect(await stored(host)).toEqual([]);
    await share(host, replaced, [link]);
    // The replaced socket's close, which arrives after, leaves the new one's links.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stored(host)).toEqual([link.id]);
  });

  it("takes a list only from the current control socket, so a replaced one's can't bring a link back", async () => {
    const { host, control, stub } = await online();
    const [kept, revoked] = [await newLink(), await newLink()];
    await share(host, control, [kept, revoked]);
    // The relay's end of the first control socket, which a list may still be in flight on.
    let first: WebSocket | undefined;
    await runInDurableObject(stub, (_: HostRelay, state) => void (first = state.getWebSockets("host")[0]));
    const { control: replaced } = await connectHost(host);
    await replaced.next();
    await share(host, replaced, [kept]);
    const stale = JSON.stringify({
      t: "guests",
      links: [kept, revoked].map((link) => ({ link: link.id, pass: link.hash, expires: Date.now() / 1000 + 3600 })),
    });
    await runInDurableObject(stub, (relay: HostRelay) => relay.webSocketMessage(first!, stale));
    expect(await stored(host)).toEqual([kept.id]);
    expect(await refusal(host, revoked)).toEqual({ status: 401, error: "unauthorized" });
  });

  it("keeps at most 20 links, and only well-formed ones", async () => {
    const { host, control } = await online();
    const links = await Promise.all(Array.from({ length: GUEST_LIMITS.links + 2 }, () => newLink()));
    const expires = Date.now() / 1000 + 3600;
    control.ws.send(JSON.stringify({
      t: "guests",
      links: [
        { link: "short", pass: links[0]!.hash, expires },
        { link: links[0]!.id, pass: "not hex", expires },
        { link: links[0]!.id, pass: links[0]!.hash, expires: String(expires) },
        null,
        ...links.map((link) => ({ link: link.id, pass: link.hash, expires })),
      ],
    }));
    await expect.poll(async () => (await stored(host)).length).toBe(GUEST_LIMITS.links);
    expect((await stored(host)).sort()).toEqual(links.slice(0, GUEST_LIMITS.links).map((link) => link.id).sort());
  });

  it("counts against the anonymous limit before any object runs", async () => {
    const { host, control } = await online();
    const link = await newLink();
    await share(host, control, [link]);
    const asked = vi.spyOn(HostRelay.prototype, "guestTicket");
    try {
      const ANON = { limit: async () => ({ success: false }) };
      const response = await worker.fetch(
        new Request(`${BASE}/v1/hosts/${host.id}/guest-tickets`, { method: "POST", headers: { authorization: `Guest ${link.id}.${link.pass}` } }),
        { ...testEnv, ANON } as Env,
      );
      expect(response.status).toBe(429);
      expect(asked).not.toHaveBeenCalled();
    } finally {
      asked.mockRestore();
    }
  });

  it("refuses a guest while plxd is offline", async () => {
    const { host, control, stub } = await online();
    const link = await newLink();
    control.ws.close(1000);
    await control.closed;
    // A link left from before, as plxd's last list would be had its close not arrived, and plxd
    // gone long enough that a request doesn't wait for it.
    await runInDurableObject(stub, async (relay: HostRelay, state) => {
      (relay as unknown as { hostLeft: number }).hostLeft = 0;
      await state.storage.put("guests", { [link.id]: { pass: link.hash, expires: Date.now() + 60_000 } });
    });
    expect(await refusal(host, link)).toEqual({ status: 503, error: "host_offline" });
  });
});

describe("guest budgets", () => {
  it("give each link 6 tickets a minute and all guests 10, and leave the owner the rest of the host's 30", async () => {
    const { host, token, control } = await online();
    const [first, second] = [await newLink(), await newLink()];
    await share(host, control, [first, second]);
    for (let i = 0; i < GUEST_LIMITS.linkTickets; i++) await granted(host, first);
    expect(await refusal(host, first)).toEqual({ status: 429, error: "rate_limited" });
    for (let i = GUEST_LIMITS.linkTickets; i < GUEST_LIMITS.opens; i++) await granted(host, second);
    expect(await refusal(host, second)).toEqual({ status: 429, error: "rate_limited" });
    // The guests spent 10 of the host's opens, and the owner still gets every one of the other 20.
    for (let i = GUEST_LIMITS.opens; i < LIMITS.opens; i++)
      expect((await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token })).status).toBe(200);
    expect((await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token })).status).toBe(429);
  });

  it("give each link 2 streams and all guests 4, and the owner still opens", async () => {
    const { host, token, control } = await online();
    const links = [await newLink(), await newLink(), await newLink()];
    await share(host, control, links);
    const [a, b, c] = links as [Link, Link, Link];
    for (const link of [a, a, b]) await joined(host, control, await granted(host, link));
    expect(await refusal(host, a)).toEqual({ status: 429, error: "too_many_streams" });
    // A ticket granted while there was room still can't open past it.
    const late = await granted(host, b);
    await joined(host, control, await granted(host, c));
    const over = await socket(`/v1/hosts/${host.id}/connect?ticket=${late}`);
    expect(over instanceof Response && over.status).toBe(429);
    expect(await refusal(host, c)).toEqual({ status: 429, error: "too_many_streams" });
    const owner = opened(await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}` }));
    opened(await join(host, await next(control)));
    expect(await owner.next()).toBe("ready");
  });

  it("leave a link's other stream open when one closes with nothing counted", async () => {
    const { host, control } = await online();
    const link = await newLink();
    await share(host, control, [link]);
    const first = await joined(host, control, await granted(host, link));
    const second = await joined(host, control, await granted(host, link));
    first.client.ws.close(1000);
    await first.side.closed;
    await expect.poll(async () => Object.keys((await runInDurableObject(testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id)),
      async (_: HostRelay, state) => state.storage.get<object>("streams"))) ?? {}).length).toBe(1);
    second.client.ws.send(new Uint8Array([5]));
    expect(new Uint8Array((await second.side.next()) as ArrayBuffer)).toEqual(new Uint8Array([5]));
  });

  it("close a link past 128 MiB, then all guests past 256 MiB, until 00:00 UTC, and never the owner's stream", async () => {
    // Each report is within 8 MiB of the truth, so the guests stop below 288 MiB.
    expect((MAX_DAILY_BYTES - GUEST_LIMITS.bytes - GUEST_LIMITS.streams * REPORT_BYTES) / MiB).toBe(1_760);
    const { host, token, control, stub } = await online();
    const [heavy, light, third] = [await newLink(), await newLink(), await newLink()];
    await share(host, control, [heavy, light, third]);
    const owner = opened(await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}` }));
    const ownerSide = opened(await join(host, await next(control)));
    expect(await owner.next()).toBe("ready");
    await ownerSide.next();
    const heavyOne = await joined(host, control, await granted(host, heavy));
    const heavyTwo = await joined(host, control, await granted(host, heavy));
    const lightOne = await joined(host, control, await granted(host, light));

    /** Brings `stream` one frame short of its 8 MiB report, sends two, and returns the second's
     *  fate. Each one-byte frame counts as 16 KiB. */
    const report = async ({ client, side, open }: Awaited<ReturnType<typeof joined>>) => {
      await runInDurableObject(testEnv.STREAMS.get(testEnv.STREAMS.idFromString(open.stream)), (relay: StreamRelay) => {
        (relay as unknown as { unreported: number }).unreported = REPORT_BYTES - 2 * MIN_FRAME_BYTES;
      });
      client.ws.send(new Uint8Array([0]));
      await side.next();
      client.ws.send(new Uint8Array([1]));
    };
    const traffic = (bytes: number, links: Record<string, number>) =>
      runInDurableObject(stub, async (_: HostRelay, state) => {
        await state.storage.put("guestTraffic", { day: new Date().toISOString().slice(0, 10), bytes, links });
      });

    // The heavy link's report takes it past its 128 MiB: both its streams close, and nobody else's.
    await traffic(GUEST_LIMITS.linkBytes - REPORT_BYTES + 1, { [heavy.id]: GUEST_LIMITS.linkBytes - REPORT_BYTES + 1 });
    await report(heavyOne);
    expect(await heavyOne.client.closed).toBe(4429);
    expect(await heavyTwo.client.closed).toBe(4429);
    expect(await refusal(host, heavy)).toEqual({ status: 429, error: "daily_limit" });
    lightOne.client.ws.send(new Uint8Array([2]));
    expect(new Uint8Array((await lightOne.side.next()) as ArrayBuffer)).toEqual(new Uint8Array([2]));
    owner.ws.send(new Uint8Array([3]));
    expect(new Uint8Array((await ownerSide.next()) as ArrayBuffer)).toEqual(new Uint8Array([3]));

    // Then all guests pass 256 MiB: every guest stream closes, and every link is refused.
    const thirdOne = await joined(host, control, await granted(host, third));
    await traffic(GUEST_LIMITS.bytes - REPORT_BYTES + 1, { [heavy.id]: GUEST_LIMITS.linkBytes + 1 });
    await report(lightOne);
    expect(await lightOne.client.closed).toBe(4429);
    expect(await thirdOne.client.closed).toBe(4429);
    expect(await refusal(host, third)).toEqual({ status: 429, error: "daily_limit" });

    // The owner's stream carries on, and the owner opens a new one.
    owner.ws.send(new Uint8Array([4]));
    expect(new Uint8Array((await ownerSide.next()) as ArrayBuffer)).toEqual(new Uint8Array([4]));
    const again = opened(await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}` }));
    opened(await join(host, await next(control)));
    expect(await again.next()).toBe("ready");

    // A new UTC day starts the guests from nothing.
    await runInDurableObject(stub, async (_: HostRelay, state) => {
      await state.storage.put("guestTraffic", { day: "2000-01-01", bytes: GUEST_LIMITS.bytes + 1, links: {} });
    });
    await granted(host, third);
  });
});

describe("marks", () => {
  it("go again with an open plxd never heard, after its control link dropped (PLX-1547)", async () => {
    const { host, user, control } = await online();
    const link = await newLink();
    await share(host, control, [link]);
    const guest = opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${await granted(host, link)}`));
    const lost = await next(control);
    expect(lost.guest).toBe(link.id);
    const ticket = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token: await hostedToken(user) });
    const browser = opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${((await ticket.json()) as { ticket: string }).ticket}`));
    expect((await next(control)).client).toBe("hosted");

    // plxd reconnects holding neither, so both are announced again, each with its mark.
    const { control: again } = await connectHost(host, []);
    await again.next();
    const announced = [await next(again), await next(again)];
    expect(announced.map((open) => open.guest ?? open.client).sort()).toEqual(["hosted", link.id].sort());
    for (const open of announced) opened(await join(host, open));
    expect(await guest.next()).toBe("ready");
    expect(await browser.next()).toBe("ready");
  });

  it("stay on a stream's record while it waits to be announced again", async () => {
    const { host, control, stub } = await online();
    const link = await newLink();
    await share(host, control, [link]);
    opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${await granted(host, link)}`));
    const { stream } = await next(control);
    // The new `open` waits on its arm, so the record stays pending until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const arm = StreamRelay.prototype.arm;
    const spy = vi.spyOn(StreamRelay.prototype, "arm").mockImplementation(async function (this: StreamRelay, armed) {
      await held;
      return arm.call(this, armed);
    });
    try {
      const { control: again } = await connectHost(host, []);
      await again.next();
      const record = () => runInDurableObject(stub, async (_: HostRelay, state) =>
        (await state.storage.get<Record<string, object>>("streams"))?.[stream]);
      await expect.poll(() => spy.mock.calls.length).toBe(1);
      expect(await record()).toEqual({ pending: true, mark: { guest: link.id } });
      release();
      expect((await next(again)).guest).toBe(link.id);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it.each(["hosted", "guest"])("never retake after a %s stream's join answers 409", async (kind) => {
    const { host, user, control } = await online();
    await spare(host, control);
    const link = await newLink();
    await share(host, control, [link]);
    const ticket = kind === "guest"
      ? await granted(host, link)
      : ((await (await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token: await hostedToken(user) })).json()) as { ticket: string }).ticket;
    // The client's join finds the stream taken, as a spare whose claim was lost would be (PLX-1506).
    const fetch = StreamRelay.prototype.fetch;
    const joining = vi.spyOn(StreamRelay.prototype, "fetch").mockImplementation(async function (this: StreamRelay, request) {
      if (new URL(request.url).pathname === "/client") return Response.json({ error: "taken" }, { status: 409 });
      return fetch.call(this, request);
    });
    const retake = vi.spyOn(HostRelay.prototype, "retake");
    try {
      const response = await socket(`/v1/hosts/${host.id}/connect?ticket=${ticket}`);
      expect(response instanceof Response && response.status).toBe(409);
      expect(retake).not.toHaveBeenCalled();
    } finally {
      joining.mockRestore();
      retake.mockRestore();
    }
  });
});
