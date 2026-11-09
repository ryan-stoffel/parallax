import { SELF } from "cloudflare:test";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { accountOf, DEVELOPMENT, verifySession } from "../src/clerk";
import { sha256 } from "../src/crypto";
import {
  hookKey,
  HostRelay,
  LIMITS,
  MAX_DAILY_BYTES,
  MAX_HOOK_BYTES,
  MAX_REMOVAL,
  MAX_STREAMS,
} from "../src/host";
import worker, { type Env, network } from "../src/index";
import { logged } from "../src/log";
import { MIN_FRAME_BYTES, REPORT_BYTES, StreamRelay } from "../src/stream";
import { apnsPayload, MAX_SEALED, sendApns } from "../src/push";
import { MAX_HOSTS, UserAccount, USER_LIMITS } from "../src/user";
import {
  BASE,
  call,
  connectHost,
  hostProof,
  hostSocket,
  hookFrame,
  type Host,
  newHost,
  opened,
  peerHeader,
  register,
  session,
  type Socket,
  socket,
  testEnv,
} from "./helpers";

/** The relay's account for `user` of this test's Clerk instance. */
const account = (user: string) => accountOf("https://clerk.test", user);

/** A registered, connected host for `user`, a new one by default, and that user's token. */
async function online(user = `user_${crypto.randomUUID()}`) {
  const host = await newHost();
  const token = await session(user);
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready", check: true });
  return { host, token, control };
}

type Open = { t: string; stream: string; token: string; spare?: boolean };

/** A client's stream to `host`, opened with a ticket as clients before 0091 do, not yet joined. */
async function stream(host: Host, token: string, control: Socket) {
  const ticket = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token });
  expect(ticket.status).toBe(200);
  const { ticket: value } = (await ticket.json()) as { ticket: string };
  const client = opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${value}`));
  const open = JSON.parse((await control.next()) as string) as Open;
  expect(open.t).toBe("open");
  return { client, open, ticket: value };
}

/** A client's stream opened with its Clerk token in the header (0091): the socket or refusal. */
function connect(host: Host, token: string) {
  return socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}` });
}

/** plxd's side of the stream `open` announced. */
function join(host: Host, open: Open) {
  return socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`);
}

/** The streams `host`'s object counts as open. */
function openStreams(host: Host) {
  return runInDurableObject(hosts.get(hosts.idFromName(host.id)), async (_: HostRelay, state) =>
    (await state.storage.get<Record<string, { spare?: true }>>("streams")) ?? {},
  );
}

function streamObject(stream: string) {
  return streams.get(streams.idFromString(stream));
}

const hosts = testEnv.HOSTS;
const streams = testEnv.STREAMS;
const users = testEnv.USERS;

describe("sign-in", () => {
  it("takes a session or the desktop app's OAuth token from the configured Clerk, and nothing else", async () => {
    const otherIssuer = await session("user_a", { iss: "https://evil.test" });
    const tampered = (await session("user_a")).replace(/\.[^.]+$/, ".AAAA");
    const otherApp = await session("user_a", { sid: undefined, client_id: "someone_else" });
    for (const token of [otherIssuer, tampered, otherApp]) {
      expect((await call("/v1/hosts", { token })).status).toBe(401);
    }
    expect((await call("/v1/hosts")).status).toBe(401);
    expect((await call("/v1/hosts", { token: await session("user_a") })).status).toBe(200);
    const desktop = await session("user_a", { sid: undefined, client_id: "mp9Q72aAbB0LC83O" });
    expect((await call("/v1/hosts", { token: desktop })).status).toBe(200);
  });

  it("says how long reading the JWKS took only when a token's check had to read it", async () => {
    const issuer = `https://clerk-${crypto.randomUUID()}.test`;
    const env = { ...testEnv, CLERK_ISSUER: issuer } as Env;
    const reads: number[] = [];
    const check = async () => verifySession(env, await session("user_keys", { iss: issuer }), (ms) => reads.push(ms));
    expect(await check()).toBe(accountOf(issuer, "user_keys"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBeGreaterThanOrEqual(0);
    // The isolate keeps the keys, so the next check reads nothing.
    expect(await check()).toBe(accountOf(issuer, "user_keys"));
    expect(reads).toHaveLength(1);
  });

  it("takes two Clerk instances at once, each checked against its own JWKS (PLX-1049)", async () => {
    const env = {
      ...testEnv,
      CLERK_JWKS: undefined,
      CLERK_ISSUER: "https://clerk-next.test, https://clerk-old.test",
      CLERK_JWKS_URL: "https://keys.test/next, https://keys.test/old",
      CLERK_CLIENT_IDS: "next_app",
    } as Env;
    // The new instance's keys are served; the old one's JWKS is down.
    const fetched: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url === "https://keys.test/next") return new Response(testEnv.CLERK_JWKS);
      throw new TypeError("fetch failed");
    });
    const list = async (claims: Record<string, unknown>) =>
      (
        await worker.fetch(
          new Request(`${BASE}/v1/hosts`, {
            headers: { authorization: `Bearer ${await session("user_two", claims)}` },
          }),
          env,
        )
      ).status;
    try {
      expect(await list({ iss: "https://clerk-next.test" })).toBe(200);
      expect(await list({ iss: "https://clerk-next.test", sid: undefined, client_id: "next_app" })).toBe(200);
      // Each issuer has its own keys: the old one's outage is its own, and a third fetches nothing.
      expect(await list({ iss: "https://clerk-old.test" })).toBe(503);
      expect(await list({ iss: "https://clerk.test" })).toBe(401);
      expect(fetched).toEqual(["https://keys.test/next", "https://keys.test/old"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the sign-in code page", () => {
  it("shows the code escaped, with a copy script only the response's nonce lets run", async () => {
    const response = await call(`/connect/code?code=${encodeURIComponent('<b>"x"')}`);
    const page = await response.text();
    const nonce = response.headers.get("content-security-policy")!.match(/script-src 'nonce-([^']+)'/)![1];
    expect(page).toContain("<output>&lt;b&gt;&quot;x&quot;</output>");
    expect(page).toContain(`<script nonce="${nonce}">`);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("hides what Clerk sent when sign-in fails, and shows the command to try again", async () => {
    const page = await (await call("/connect/code?error=access_denied&error_description=Secret%20detail")).text();
    expect(page).not.toContain("access_denied");
    expect(page).not.toContain("Secret detail");
    expect(page).toContain("<output>plx connect</output>");
    expect(await (await call("/connect/code?code=")).text()).toContain("<output>plx connect</output>");
  });
});

describe("one host can't impersonate another", () => {
  it("registers only a key the host id names, signed over this user's token", async () => {
    const host = await newHost();
    const other = await newHost();
    const token = await session("user_a");
    // Another key's signature, or a signature made for another user's token, is refused.
    expect((await register(host, token, other)).status).toBe(401);
    const theirs = await session("user_b");
    const replayed = await call("/v1/hosts", {
      method: "POST",
      token,
      body: JSON.stringify({
        hostId: host.id,
        jwk: host.jwk,
        signature: await host.sign(
          `parallax-relay-register\n${host.id}\n${await sha256(theirs)}`,
        ),
      }),
    });
    expect(replayed.status).toBe(401);
    // A key that isn't the one the id names.
    const wrongKey = await call("/v1/hosts", {
      method: "POST",
      token,
      body: JSON.stringify({ hostId: host.id, jwk: other.jwk, signature: "x" }),
    });
    expect(wrongKey.status).toBe(400);
    expect((await register(host, token)).status).toBe(200);
  });

  it("opens a control socket only with a fresh proof signed by the host's key", async () => {
    const { host } = await online();
    const impostor = await newHost();
    const refused = async (proof: string) => ((await hostSocket(host, proof)) as Response).status;
    expect(await refused(await hostProof(host, impostor))).toBe(401);
    expect(await refused("")).toBe(401);
    expect(await refused(await hostProof(host, host, Date.now() - 6 * 60_000))).toBe(401);
    expect(await refused(await hostProof(host, host, Date.now() + 60_000))).toBe(401);
    // A proof works once: the same one again, or an older one, is a replay.
    const proof = await hostProof(host);
    opened(await hostSocket(host, proof));
    expect(await refused(proof)).toBe(401);
    expect(await refused(await hostProof(host, host, Date.now() - 60_000))).toBe(401);
  });
});

describe("clock skew", () => {
  it("answers a proof at the wrong time with the relay's clock, and takes one a little ahead", async () => {
    const { host } = await online();
    const ahead = (await hostSocket(host, await hostProof(host, host, Date.now() + 10 * 60_000))) as Response;
    expect(ahead.status).toBe(401);
    const { error, now } = (await ahead.json()) as { error: string; now: number };
    expect(error).toBe("clock_skew");
    expect(ahead.headers.get("x-parallax-relay-time")).toBe(String(now));
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
    // plxd retries at the relay's time, corrected for its own clock.
    opened(await hostSocket(host, await hostProof(host, host, now + 1)));
    opened(await hostSocket(host, await hostProof(host, host, Date.now() + 20_000)));
    // A foreign signature learns nothing.
    const forged = (await hostSocket(host, await hostProof(host, await newHost()))) as Response;
    expect(await forged.json()).toEqual({ error: "unauthorized" });
  });
});

describe("clock creep", () => {
  it("never accepts a proof more than 30 s ahead of the relay, however many come in a row", async () => {
    const { host } = await online();
    let at = Date.now() + 25_000;
    opened(await hostSocket(host, await hostProof(host, host, at)));
    for (let i = 0; i < 11; i++) {
      at += 25_000;
      const ahead = (await hostSocket(host, await hostProof(host, host, at))) as Response;
      expect(ahead.status).toBe(401);
    }
    const stub = hosts.get(hosts.idFromName(host.id));
    const last = await runInDurableObject(stub, (_: HostRelay, state) => state.storage.get<number>("lastProof"));
    expect(last!).toBeLessThanOrEqual(Date.now() + 30_000);
  });
});

describe("one user can't reach another user's host", () => {
  it("keeps the same user id from two Clerk instances apart, and development's bare (PLX-1049)", async () => {
    const { host } = await online("user_same");
    const dev = await session("user_same", { iss: DEVELOPMENT });
    // The development instance's user with the same id sees no host, and can't open one.
    const list = async (token: string) =>
      ((await (await call("/v1/hosts", { token })).json()) as { hosts: { hostId: string }[] }).hosts;
    expect(await list(dev)).toEqual([]);
    expect((await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token: dev })).status).toBe(404);
    expect(((await connect(host, dev)) as Response).status).toBe(404);
    // Theirs isn't this instance's either, and is kept under the bare id hosts registered before.
    const theirs = await newHost();
    expect((await register(theirs, dev)).status).toBe(200);
    expect((await list(dev)).map((h) => h.hostId)).toEqual([theirs.id]);
    expect((await list(await session("user_same"))).map((h) => h.hostId)).toEqual([host.id]);
    const owner = (id: string) =>
      runInDurableObject(hosts.get(hosts.idFromName(id)), (_: HostRelay, state) =>
        state.storage.get<{ user: string }>("owner"),
      );
    expect((await owner(theirs.id))?.user).toBe("user_same");
    expect((await owner(host.id))?.user).toBe("https://clerk.test|user_same");
  });

  it("takes an OAuth token only with its own instance's client id (PLX-1049)", async () => {
    const status = async (claims: Record<string, unknown>) =>
      (await call("/v1/hosts", { token: await session("user_app", { sid: undefined, ...claims }) })).status;
    expect(await status({ client_id: "mp9Q72aAbB0LC83O" })).toBe(200);
    expect(await status({ iss: DEVELOPMENT, client_id: "SXDueyOLOJ2v4Vmq" })).toBe(200);
    expect(await status({ client_id: "SXDueyOLOJ2v4Vmq" })).toBe(401);
    expect(await status({ iss: DEVELOPMENT, client_id: "mp9Q72aAbB0LC83O" })).toBe(401);
  });

  it("hides the host and refuses tickets for another user", async () => {
    const { host } = await online("user_listed");
    const intruder = await session("user_b");
    const tickets = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token: intruder });
    expect(tickets.status).toBe(404);
    const list = (await (await call("/v1/hosts", { token: intruder })).json()) as { hosts: unknown[] };
    expect(list.hosts).toEqual([]);
    const own = await call("/v1/hosts", { token: await session("user_listed") });
    expect(await own.json()).toEqual({
      hosts: [{ hostId: host.id, name: "Ryan's Mac", online: true, usage: expect.anything() }],
      removed: [],
    });
  });

  it("lists a host's bytes today, the limit, and the next 00:00 UTC, from nothing on a new day", async () => {
    const { host, token } = await online();
    const listedUsage = async () => {
      const list = (await (await call("/v1/hosts", { token })).json()) as { hosts: { usage: object }[] };
      return list.hosts[0]!.usage;
    };
    const saved = async (day: string) =>
      runInDurableObject(hosts.get(hosts.idFromName(host.id)), async (relay: HostRelay, state) => {
        await state.storage.put("traffic", { day, bytes: 1_234 });
        (relay as unknown as { traffic?: object }).traffic = undefined;
      });
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const resetsAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    await saved(today);
    expect(await listedUsage()).toEqual({ bytes: 1_234, limit: MAX_DAILY_BYTES, resetsAt });
    await saved(new Date(Date.parse(today) - 1).toISOString().slice(0, 10));
    expect(await listedUsage()).toEqual({ bytes: 0, limit: MAX_DAILY_BYTES, resetsAt });
  });

  it("refuses a stream without a ticket, or with a used one", async () => {
    const { host, token, control } = await online();
    const none = await socket(`/v1/hosts/${host.id}/connect?ticket=guess`);
    expect(none instanceof Response && none.status).toBe(401);
    const { ticket } = await stream(host, token, control);
    const reused = await socket(`/v1/hosts/${host.id}/connect?ticket=${ticket}`);
    expect(reused instanceof Response && reused.status).toBe(401);
  });
});

describe("connection check", () => {
  it("gives plxd a ticket to itself over its control socket, which opens a real stream", async () => {
    const { host, control } = await online();
    control.ws.send(JSON.stringify({ t: "check" }));
    const answer = JSON.parse((await control.next()) as string) as { t: string; ticket: string };
    expect(answer.t).toBe("check");
    const client = opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${answer.ticket}`));
    const open = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, open));
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    const reused = await socket(`/v1/hosts/${host.id}/connect?ticket=${answer.ticket}`);
    expect(reused instanceof Response && reused.status).toBe(401);
  });

  it("answers with the refusal when the host has opened too many streams this minute", async () => {
    const { control } = await online();
    let answer: { ticket?: string; error?: string } = {};
    for (let sent = 0; sent <= LIMITS.opens; sent++) {
      control.ws.send(JSON.stringify({ t: "check" }));
      answer = JSON.parse((await control.next()) as string) as typeof answer;
    }
    expect(answer).toEqual({ t: "check", error: "rate_limited" });
  });
});

describe("a plxd reaches another with its host key", () => {
  /** Two hosts of one user, the second online. */
  async function pair(user: string) {
    const caller = await newHost();
    const { host: target, token } = await online(user);
    await register(caller, token);
    return { caller, target };
  }
  const connect = async (caller: Host, target: Host, signer: Host = caller, at = Date.now()) =>
    socket(`/v1/hosts/${target.id}/connect`, await peerHeader(caller, `connect/${target.id}`, signer, at));

  it("lists its owner's hosts and opens a stream to one, with no token", async () => {
    const { caller, target } = await pair("user_peers");
    const listed = await call("/v1/hosts", { headers: await peerHeader(caller, "hosts") });
    const { hosts } = (await listed.json()) as { hosts: { hostId: string }[] };
    expect(hosts.map((host) => host.hostId).sort()).toEqual([caller.id, target.id].sort());
    expect((await connect(caller, target)) instanceof Response).toBe(false);
  });

  it("refuses a host of another owner as if it weren't there", async () => {
    const { host: target } = await online("user_theirs");
    const { host: caller } = await online("user_mine");
    const refused = await connect(caller, target);
    expect(refused instanceof Response && refused.status).toBe(404);
  });

  it("refuses a wrong signature and a proof for another route", async () => {
    const { caller, target } = await pair("user_forged");
    const forged = await connect(caller, target, await newHost());
    expect(forged instanceof Response && forged.status).toBe(401);
    const list = await call("/v1/hosts", { headers: await peerHeader(caller, "hosts", await newHost()) });
    expect(list.status).toBe(401);
    const elsewhere = await socket(`/v1/hosts/${target.id}/connect`, await peerHeader(caller, "hosts"));
    expect(elsewhere instanceof Response && elsewhere.status).toBe(401);
  });

  it("refuses a stale proof and answers the relay's time", async () => {
    const { caller, target } = await pair("user_stale");
    const stale = await connect(caller, target, caller, Date.now() - 6 * 60_000);
    if (!(stale instanceof Response)) throw new Error("a stale proof opened a stream");
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: string }).error).toBe("clock_skew");
    expect(Number(stale.headers.get("x-parallax-relay-time"))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("refuses a host the relay doesn't know", async () => {
    const stranger = await newHost();
    const refused = await call("/v1/hosts", { headers: await peerHeader(stranger, "hosts") });
    expect(refused.status).toBe(401);
  });
});

describe("streams", () => {
  it("joins plxd's side only with the token sent to plxd, and passes bytes unread", async () => {
    const { host, token, control } = await online();
    const { client, open } = await stream(host, token, control);
    const wrong = await socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=nope`);
    expect(wrong instanceof Response && wrong.status).toBe(404);
    const side = opened(await join(host, open));
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    // A second join with the same token is refused: the stream already has its side.
    const again = await join(host, open);
    expect(again instanceof Response && again.status).toBe(404);

    const record = new Uint8Array([0x16, 0x03, 0x01, 0, 4, 1, 2, 3, 4]);
    client.ws.send(record);
    expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(record);
    side.ws.send(record.slice().reverse());
    expect(new Uint8Array((await client.next()) as ArrayBuffer)).toEqual(record.slice().reverse());

    // The relay keeps nothing of a stream's bytes: the host's object only counts it as open.
    const stub = hosts.get(hosts.idFromName(host.id));
    const stored = await runInDurableObject(stub, async (_: HostRelay, state) => ({
      keys: [...(await state.storage.list()).keys()],
      held: state.storage.sql.exec("SELECT count(*) AS n FROM held").one().n,
    }));
    expect(stored).toEqual({ keys: ["lastProof", "owner", "streams"], held: 0 });
    expect(Object.keys(await openStreams(host))).toEqual([open.stream]);

    client.ws.close(1000);
    expect(await side.closed).toBe(1000);
    // The stream's object reports its close, which frees its place, and keeps nothing.
    await expect.poll(() => openStreams(host)).toEqual({});
    const left = await runInDurableObject(streamObject(open.stream), async (_: StreamRelay, state) =>
      (await state.storage.list()).size,
    );
    expect(left).toBe(0);
  });

  it("opens with the Clerk token in the Authorization header, never the URL", async () => {
    const { host, token, control } = await online();
    for (const query of [`token=${token}`, `access_token=${token}`, `ticket=`]) {
      const inUrl = await socket(`/v1/hosts/${host.id}/connect?${query}`);
      expect(inUrl instanceof Response && inUrl.status).toBe(401);
    }
    const forged = await connect(host, `${token}x`);
    expect(forged instanceof Response && forged.status).toBe(401);
    const intruder = await connect(host, await session("user_intruder"));
    expect(intruder instanceof Response && intruder.status).toBe(404);

    const client = opened(await connect(host, token));
    const open = JSON.parse((await control.next()) as string) as Open;
    expect(open).toMatchObject({ t: "open" });
    expect(open.spare).toBeUndefined();
    const side = opened(await join(host, open));
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    client.ws.send(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns numeric timing headers only on opted-in authenticated upgrades", async () => {
    const { host, token, control } = await online();
    for (const timed of [false, true]) {
      control.ws.send(JSON.stringify({ t: "spare" }));
      const spare = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, spare));
      const response = await SELF.fetch(`${BASE}/v1/hosts/${host.id}/connect`, {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}`, ...(timed ? { "x-parallax-timing": "1" } : {}) },
      });
      expect(response.status).toBe(101);
      const timing = response.headers.get("server-timing");
      if (timed) {
        expect(timing).toMatch(/^auth;dur=[\d.]+, host_open;dur=[\d.]+, stream_join;dur=[\d.]+, admit;dur=[\d.]+, take;dur=[\d.]+, spare;dur=1, join_read;dur=[\d.]+, join_ready;dur=[\d.]+, join_delete_alarm;dur=[\d.]+, join_total;dur=[\d.]+/);
        // What runs beside those comes last, so a plxd from before PLX-1493 reads what it did.
        expect(timing).toMatch(/, limit;dur=[\d.]+, (jwks;dur=[\d.]+, )?host_hop;dur=[\d.]+, worker;dur=[\d.]+$/);
      } else expect(timing).toBeNull();
      response.webSocket!.accept();
      expect(await side.next()).toBe("ready");
      response.webSocket!.close();
      side.ws.close();
    }
    const refused = await SELF.fetch(`${BASE}/v1/hosts/${host.id}/connect`, { headers: { upgrade: "websocket", "x-parallax-timing": "1" } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("server-timing")).toBeNull();
  });

  it("separates local read and alarm-delete delay from pre-entry RPC delay", async () => {
    const { host, token, control } = await online();
    const armed = StreamRelay.prototype as unknown as { armed(): Promise<unknown> };
    const originalRead = armed.armed;
    const originalFetch = StreamRelay.prototype.fetch;
    for (const stage of ["read", "alarm", "rpc"] as const) {
      control.ws.send(JSON.stringify({ t: "spare" }));
      const open = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, open));
      const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
      let deleteSpy: ReturnType<typeof vi.spyOn> | undefined;
      if (stage === "alarm") await runInDurableObject(streamObject(open.stream), (_, state) => {
        const originalDelete = state.storage.deleteAlarm.bind(state.storage);
        deleteSpy = vi.spyOn(state.storage, "deleteAlarm").mockImplementation(async () => {
          await pause();
          return originalDelete();
        });
      });
      const readSpy = vi.spyOn(armed, "armed").mockImplementation(async function (this: StreamRelay) {
        if (stage === "read") await pause();
        return originalRead.call(this);
      });
      const fetchSpy = vi.spyOn(StreamRelay.prototype, "fetch").mockImplementation(async function (this: StreamRelay, request) {
        if (stage === "rpc") await pause();
        return originalFetch.call(this, request);
      });
      try {
        const response = await SELF.fetch(`${BASE}/v1/hosts/${host.id}/connect`, {
          headers: { upgrade: "websocket", authorization: `Bearer ${token}`, "x-parallax-timing": "1" },
        });
        expect(response.status).toBe(101);
        const times = Object.fromEntries(response.headers.get("server-timing")!.split(", ").map((part) => {
          const [name, value] = part.split(";dur=");
          return [name, Number(value)];
        }));
        expect(times.stream_join).toBeGreaterThanOrEqual(70);
        if (stage === "read") {
          expect(times.join_read).toBeGreaterThanOrEqual(70);
          expect(times.join_total).toBeGreaterThanOrEqual(times.join_read!);
        } else if (stage === "alarm") {
          expect(times.join_delete_alarm).toBeGreaterThanOrEqual(70);
          expect(times.join_total).toBeGreaterThanOrEqual(times.join_delete_alarm!);
        } else {
          expect(times.stream_join! - times.join_total!).toBeGreaterThanOrEqual(70);
        }
        response.webSocket!.accept();
        await side.next();
        response.webSocket!.close();
        side.ws.close();
      } finally {
        deleteSpy?.mockRestore();
        readSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    }
  });

  it("snapshots taken-first stages and leaves unfinished join-first work absent", async () => {
    const { host, control } = await online();
    for (const order of ["taken-first", "join-first", "unavailable"] as const) {
      const takenFirst = order === "taken-first";
      control.ws.send(JSON.stringify({ t: "spare" }));
      const open = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, open));
      const object = streamObject(open.stream);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const armed = StreamRelay.prototype as unknown as { armed(): Promise<unknown> };
      const original = armed.armed;
      let reading = false;
      const spy = vi.spyOn(armed, "armed").mockImplementation(async function (this: StreamRelay) {
        if (order === "join-first" && !reading) {
          reading = true;
          await gate;
        }
        return original.call(this);
      });
      let pending: Promise<void> | undefined;
      try {
        if (takenFirst) await object.taken(Date.now() + 30_000, true);
        else if (order === "join-first") {
          pending = object.taken(Date.now() + 30_000, true);
          await expect.poll(() => reading).toBe(true);
        }
        const response = await object.fetch("https://stream/client", {
          headers: { upgrade: "websocket", "x-parallax-timing": "1" },
        });
        expect(response.status).toBe(101);
        const header = response.headers.get("server-timing")!;
        if (order === "unavailable") expect(header).not.toContain("taken_");
        else expect(header).toContain("taken_entry;dur=1.000");
        if (takenFirst) {
          expect(header).toContain("taken_read;dur=");
          expect(header).toContain("taken_alarm;dur=");
          expect(header).toContain("taken_outcome;dur=1.000");
          expect(header).toContain("taken_total;dur=");
        } else {
          expect(header).not.toContain("taken_read");
          expect(header).not.toContain("taken_outcome");
          expect(header).not.toContain("taken_total");
        }
        response.webSocket!.accept();
        await side.next();
        release();
        await pending;
        if (order === "join-first") {
          const timing = await runInDurableObject(object, (relay) =>
            (relay as unknown as { takenTiming: Record<string, number> }).takenTiming);
          expect(timing.taken_outcome).toBe(2);
          expect(timing.taken_alarm).toBeUndefined();
        }
        expect(await runDurableObjectAlarm(object)).toBe(false);
        response.webSocket!.close();
        side.ws.close();
      } finally {
        release();
        await pending;
        spy.mockRestore();
      }
    }
  });

  it("joins a client to plxd's spare stream without asking plxd first", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse((await control.next()) as string) as Open;
    expect(spare).toMatchObject({ t: "open", spare: true });
    const side = opened(await join(host, spare));
    expect(await openStreams(host)).toEqual({ [spare.stream]: { spare: true } });

    const client = opened(await connect(host, token));
    // Joined at once: both ends hear it, and plxd was sent nothing new.
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    expect(await openStreams(host)).toEqual({ [spare.stream]: {} });
    side.ws.send(new Uint8Array([9]));
    expect(new Uint8Array((await client.next()) as ArrayBuffer)).toEqual(new Uint8Array([9]));

    // plxd asks for the next spare, which replaces none and counts as open.
    control.ws.send(JSON.stringify({ t: "spare" }));
    const next = JSON.parse((await control.next()) as string) as Open;
    expect(next.spare).toBe(true);
    expect(Object.keys(await openStreams(host)).sort()).toEqual([spare.stream, next.stream].sort());
  });

  it("closes a stream plxd never joins, which frees its place", async () => {
    const { host, token, control } = await online();
    const client = opened(await connect(host, token));
    const open = JSON.parse((await control.next()) as string) as Open;
    expect(await runDurableObjectAlarm(streamObject(open.stream))).toBe(true);
    expect(await client.closed).toBe(4408);
    await expect.poll(() => openStreams(host)).toEqual({});
  });

  it("closes a spare taken for a client that never arrives, which frees its place, and not one that does", async () => {
    const user = `user_${crypto.randomUUID()}`;
    const { host, token, control } = await online(user);
    const spare = async () => {
      control.ws.send(JSON.stringify({ t: "spare" }));
      const open = JSON.parse((await control.next()) as string) as Open;
      return { open, side: opened(await join(host, open)) };
    };
    const stuck = await spare();
    // What the Worker does for a client, which here hangs up before it reaches the stream.
    await hosts.get(hosts.idFromName(host.id)).open(account(user));
    expect(await openStreams(host)).toEqual({ [stuck.open.stream]: {} });
    expect(await runDurableObjectAlarm(streamObject(stuck.open.stream))).toBe(true);
    expect(await stuck.side.closed).toBe(4408);
    await expect.poll(() => openStreams(host)).toEqual({});

    const taken = await spare();
    opened(await connect(host, token));
    expect(await taken.side.next()).toBe("ready");
    expect(await runDurableObjectAlarm(streamObject(taken.open.stream))).toBe(false);
  });

  it("commits one spare owner without waiting for cleanup, which survives an absent Worker and eviction", async () => {
    const user = `user_${crypto.randomUUID()}`;
    const { host, control } = await online(user);
    control.ws.send(JSON.stringify({ t: "spare" }));
    const open = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, open));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = StreamRelay.prototype.taken;
    let deadline: number | undefined;
    const spy = vi.spyOn(StreamRelay.prototype, "taken").mockImplementation(async function (this: StreamRelay, at, timed) {
      deadline = at;
      await gate;
      await original.call(this, at, timed);
    });
    try {
      const object = hosts.get(hosts.idFromName(host.id));
      // The Worker disappears after open, without bringing a client to the stream.
      expect(await object.open(account(user), true)).toMatchObject({ stream: open.stream, timing: { spare: true } });
      expect(await openStreams(host)).toEqual({ [open.stream]: {} });
      await expect.poll(() => deadline).toBeTypeOf("number");
      expect((await object.open(account(user), true) as { stream: string }).stream).not.toBe(open.stream);
      release();
      await expect.poll(() => runInDurableObject(streamObject(open.stream), (_, state) =>
        state.storage.getAlarm())).toBe(deadline);
      await evictDurableObject(object);
      await evictDurableObject(streamObject(open.stream));
      expect(await runDurableObjectAlarm(streamObject(open.stream))).toBe(true);
      expect(await side.closed).toBe(4408);
      await expect.poll(() => openStreams(host)).not.toHaveProperty(open.stream);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("ignores late taken after client join, reporting, eviction, reconnect and close", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    const open = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, open));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = StreamRelay.prototype.taken;
    let finished = false;
    const spy = vi.spyOn(StreamRelay.prototype, "taken").mockImplementation(async function (this: StreamRelay, at, timed) {
      await gate;
      await original.call(this, at, timed);
      finished = true;
    });
    try {
      const client = opened(await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${token}`, "x-parallax-timing": "1" }));
      expect(await client.next()).toBe("ready");
      expect(await side.next()).toBe("ready");
      client.ws.send(new Uint8Array([1]));
      await side.next();
      const alarm = await runInDurableObject(streamObject(open.stream), (_, state) => state.storage.getAlarm());
      expect(alarm).not.toBeNull();
      release();
      await expect.poll(() => finished).toBe(true);
      expect(await runInDurableObject(streamObject(open.stream), (_, state) => state.storage.getAlarm())).toBe(alarm);
      await evictDurableObject(streamObject(open.stream));
      await streamObject(open.stream).taken(undefined, true);
      expect(await runInDurableObject(streamObject(open.stream), (_, state) => state.storage.getAlarm())).toBe(alarm);
      const { control: again } = await connectHost(host, [open.stream]);
      await again.next();
      client.ws.send(new Uint8Array([2]));
      expect(await side.next()).toEqual(new Uint8Array([2]).buffer);
      client.ws.close();
      await side.closed;
      await expect.poll(() => openStreams(host)).toEqual({});
      await streamObject(open.stream).taken(undefined, true);
      expect(await runDurableObjectAlarm(streamObject(open.stream))).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("holds no 101, ready or frame behind an alarm write (PLX-1493)", async () => {
    const { host, token, control } = await online();
    // Every alarm write of every stream object, from before its first one.
    const writes: { call: string; options: unknown }[] = [];
    const watched = new WeakSet<object>();
    const watch = (relay: StreamRelay) => {
      const { storage } = (relay as unknown as { ctx: DurableObjectState }).ctx;
      if (watched.has(storage)) return;
      watched.add(storage);
      const [set, remove] = [storage.setAlarm.bind(storage), storage.deleteAlarm.bind(storage)];
      vi.spyOn(storage, "setAlarm").mockImplementation((at, options) => {
        writes.push({ call: "set", options });
        return set(at, options);
      });
      vi.spyOn(storage, "deleteAlarm").mockImplementation((options) => {
        writes.push({ call: "delete", options });
        return remove(options);
      });
    };
    const [fetch, taken] = [StreamRelay.prototype.fetch, StreamRelay.prototype.taken];
    const spies = [
      vi.spyOn(StreamRelay.prototype, "fetch").mockImplementation(function (this: StreamRelay, request) {
        watch(this);
        return fetch.call(this, request);
      }),
      vi.spyOn(StreamRelay.prototype, "taken").mockImplementation(function (this: StreamRelay, at, timed) {
        watch(this);
        return taken.call(this, at, timed);
      }),
    ];
    try {
      // A spare: its claim sets the alarm, the client's join deletes it, a frame sets the report's.
      // The host's object sends the claim beside the client, so it's made here first too.
      control.ws.send(JSON.stringify({ t: "spare" }));
      const spare = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, spare));
      await streamObject(spare.stream).taken();
      const client = opened(await connect(host, token));
      expect(await client.next()).toBe("ready");
      expect(await side.next()).toBe("ready");
      client.ws.send(new Uint8Array([1]));
      await side.next();
      await expect.poll(() => writes.map((write) => write.call).join()).toMatch(/^set,(set,)?delete,set$/);
      const claimed = writes.length;

      // No spare: the client's join sets the alarm, plxd's deletes it, a frame sets the report's.
      const waiting = opened(await connect(host, token));
      const open = JSON.parse((await control.next()) as string) as Open;
      const joined = opened(await join(host, open));
      expect(await waiting.next()).toBe("ready");
      expect(await joined.next()).toBe("ready");
      joined.ws.send(new Uint8Array([2]));
      await waiting.next();
      await expect.poll(() => writes.slice(claimed).map((write) => write.call)).toEqual(["set", "delete", "set"]);

      for (const write of writes) expect(write.options).toEqual({ allowUnconfirmed: true });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("gives the spare to one of two clients that connect at once, and the other a new stream", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, spare));

    const [first, second] = (await Promise.all([connect(host, token), connect(host, token)])).map(opened);
    // plxd is asked to join one new stream, for whichever client didn't get the spare.
    const open = JSON.parse((await control.next()) as string) as Open;
    expect(open.spare).toBeUndefined();
    expect(open.stream).not.toBe(spare.stream);
    const other = opened(await join(host, open));
    expect(await first!.next()).toBe("ready");
    expect(await second!.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    expect(await other.next()).toBe("ready");
    expect(await openStreams(host)).toEqual({ [spare.stream]: {}, [open.stream]: {} });
    const clients = (stream: string) =>
      runInDurableObject(streamObject(stream), (_: StreamRelay, state) => state.getWebSockets("client").length);
    expect([await clients(spare.stream), await clients(open.stream)]).toEqual([1, 1]);
    // Each client's frame reaches its own stream's plxd end and no other.
    first!.ws.send(new Uint8Array([1]));
    second!.ws.send(new Uint8Array([1]));
    expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(new Uint8Array([1]));
    expect(new Uint8Array((await other.next()) as ArrayBuffer)).toEqual(new Uint8Array([1]));
  });

  // A stream's alarm writes aren't confirmed before its client goes on (PLX-1493). A write that
  // then fails resets the object, which drops both ends, and its alarm is whatever last reached
  // disk: none, or the claim's with the join's deletion lost.
  it.each(["no alarm", "the claim's alarm"] as const)(
    "frees a stream whose object reset after its client joined, left with %s",
    async (left) => {
      const { host, token, control } = await online();
      control.ws.send(JSON.stringify({ t: "spare" }));
      const spare = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, spare));
      const client = opened(await connect(host, token));
      expect(await client.next()).toBe("ready");
      expect(await side.next()).toBe("ready");
      client.ws.send(new Uint8Array([1]));
      await side.next();
      expect(await openStreams(host)).toEqual({ [spare.stream]: {} });

      // The reset. Its sockets drop with no close for the object to handle, and a stub that saw
      // it stays broken, so each call below makes its own.
      const dropped = [client, side].map(({ ws }) => new Promise((resolve) => {
        ws.addEventListener("error", resolve);
        ws.addEventListener("close", resolve);
      }));
      await expect(
        runInDurableObject(streamObject(spare.stream), (_: StreamRelay, state) => state.abort("a write failed")),
      ).rejects.toThrow("a write failed");
      await Promise.all(dropped);
      const object = () => streamObject(spare.stream);
      await runInDurableObject(object(), async (_: StreamRelay, state) => {
        expect(state.getWebSockets()).toHaveLength(0);
        if (left === "no alarm") await state.storage.deleteAlarm();
        else await state.storage.setAlarm(Date.now() + 30_000);
      });
      expect(await openStreams(host)).toEqual({ [spare.stream]: {} });

      if (left === "no alarm") {
        // Nothing wakes the object, so plxd, whose end dropped, says so.
        expect(await runDurableObjectAlarm(object())).toBe(false);
        control.ws.send(JSON.stringify({ t: "gone", stream: spare.stream }));
      } else expect(await runDurableObjectAlarm(object())).toBe(true);
      await expect.poll(() => openStreams(host)).toEqual({});
      expect(await runInDurableObject(object(), async (_: StreamRelay, state) => (await state.storage.list()).size)).toBe(0);
      expect(await runDurableObjectAlarm(object())).toBe(false);
      // The host's count is right again, so the next client gets a stream.
      opened(await connect(host, token));
      expect(JSON.parse((await control.next()) as string)).toMatchObject({ t: "open" });
    },
  );

  it("closes a stream plxd says is gone, counting its frames, and only plxd's own", async () => {
    const { host, token, control } = await online();
    const client = opened(await connect(host, token));
    const open = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, open));
    await client.next();
    await side.next();
    client.ws.send(new Uint8Array([1]));
    await side.next();

    // Another host naming it, and a name no stream has, end nothing.
    const { control: other } = await online();
    other.ws.send(JSON.stringify({ t: "gone", stream: open.stream }));
    control.ws.send(JSON.stringify({ t: "gone", stream: "__proto__" }));
    client.ws.send(new Uint8Array([2]));
    await side.next();

    control.ws.send(JSON.stringify({ t: "gone", stream: open.stream }));
    expect(await client.closed).toBe(1000);
    await expect.poll(() => openStreams(host)).toEqual({});
    const traffic = await runInDurableObject(hosts.get(hosts.idFromName(host.id)), (_: HostRelay, state) =>
      state.storage.get<{ bytes: number }>("traffic"),
    );
    expect(traffic?.bytes).toBe(2 * MIN_FRAME_BYTES);
  });

  it("drops a stream's report alarm once an 8 MiB report drains it, and when it closes", async () => {
    const { host, token, control } = await online();
    const pair = async () => {
      const client = opened(await connect(host, token));
      const open = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, open));
      await client.next();
      await side.next();
      const object = streamObject(open.stream);
      const send = async () => {
        client.ws.send(new Uint8Array([0]));
        await side.next();
      };
      const alarm = () => runInDurableObject(object, (_: StreamRelay, state) => state.storage.getAlarm());
      return { client, object, send, alarm };
    };

    // A report by size leaves nothing pending, and the next frame sets the alarm again.
    const drained = await pair();
    await drained.send();
    expect(await drained.alarm()).not.toBeNull();
    await runInDurableObject(drained.object, (relay: StreamRelay) => {
      (relay as unknown as { unreported: number }).unreported = REPORT_BYTES - MIN_FRAME_BYTES;
    });
    await drained.send();
    await expect.poll(drained.alarm).toBeNull();
    await drained.send();
    expect(await drained.alarm()).not.toBeNull();

    // An end closing.
    drained.client.ws.close(1000, "done");
    await expect.poll(drained.alarm).toBeNull();

    // The host's object closing it.
    const closed = await pair();
    await closed.send();
    expect(await closed.alarm()).not.toBeNull();
    await runInDurableObject(closed.object, (relay: StreamRelay) => relay.close(4429, "daily limit"));
    expect(await closed.alarm()).toBeNull();
  });

  it("reports a slow stream's count on its alarm, which more frames don't push back", async () => {
    const { host, token, control } = await online();
    const client = opened(await connect(host, token));
    const open = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, open));
    await client.next();
    await side.next();
    const bytes = async () => {
      const list = (await (await call("/v1/hosts", { token })).json()) as {
        hosts: { usage: { bytes: number } }[];
      };
      return list.hosts[0]!.usage.bytes;
    };
    const object = streamObject(open.stream);
    const alarm = () => runInDurableObject(object, (_: StreamRelay, state) => state.storage.getAlarm());
    const send = async () => {
      client.ws.send(new Uint8Array([0]));
      await side.next();
    };

    expect(await alarm()).toBeNull();
    await send();
    const first = await alarm();
    expect(first).toBeGreaterThan(Date.now());
    await send();
    expect(await alarm()).toBe(first);
    // Woken from hibernation it no longer remembers the alarm, and still doesn't move it.
    await runInDurableObject(object, (relay: StreamRelay) => {
      (relay as unknown as { reportDue: boolean }).reportDue = false;
    });
    await send();
    expect(await alarm()).toBe(first);
    expect(await bytes()).toBe(0);

    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(await bytes()).toBe(3 * MIN_FRAME_BYTES);
    // Nothing since, so no alarm, and the stream stays open.
    expect(await alarm()).toBeNull();
    await send();
    expect(await alarm()).toBeGreaterThan(Date.now());
  });

  it("refuses a stream id that's malformed or another namespace's, without throwing", async () => {
    const { host } = await online();
    const ids = ["nope", "0".repeat(64), "f".repeat(63), "A".repeat(64), hosts.newUniqueId().toString()];
    for (const id of ids) {
      const refused = await socket(`/v1/hosts/${host.id}/streams/${id}?token=x`);
      expect(refused instanceof Response && refused.status).toBe(404);
    }
    const none = await socket(`/v1/hosts/${host.id}/streams`);
    expect(none instanceof Response && none.status).toBe(404);
  });

  it("refuses plxd's side of a stream through another host's path, even with its token", async () => {
    const { host, token, control } = await online();
    const { open } = await stream(host, token, control);
    expect(open.stream).toMatch(/^[0-9a-f]{64}$/);
    const other = await newHost();
    const refused = await socket(`/v1/hosts/${other.id}/streams/${open.stream}?token=${open.token}`);
    expect(refused instanceof Response && refused.status).toBe(404);
    opened(await join(host, open));
  });

  it("still serves and closes a stream from before unique ids, whose object has a name", async () => {
    const { host, token } = await online();
    const named = async (spare: boolean) => {
      const id = crypto.randomUUID();
      const secret = crypto.randomUUID();
      const object = streams.get(streams.idFromName(`${host.id}/${id}`));
      await object.arm({ hostId: host.id, stream: id, tokenHash: await sha256(secret) });
      await runInDurableObject(hosts.get(hosts.idFromName(host.id)), async (_: HostRelay, state) => {
        const listed = (await state.storage.get<Record<string, object>>("streams")) ?? {};
        await state.storage.put("streams", { ...listed, [id]: spare ? { spare } : {} });
      });
      return { object, open: { t: "open", stream: id, token: secret } };
    };
    const kept = (object: DurableObjectStub<StreamRelay>) =>
      runInDurableObject(object, async (_: StreamRelay, state) => (await state.storage.list()).size);

    // A client takes it as the spare, plxd joins it, and its close reports back to free its place.
    const spare = await named(true);
    const client = opened(await connect(host, token));
    const side = opened(await join(host, spare.open));
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    client.ws.close(1000);
    expect(await side.closed).toBe(1000);
    await expect.poll(() => openStreams(host)).toEqual({});
    expect(await kept(spare.object)).toBe(0);

    // One still listed when plxd reconnects, as after a deploy, closes and keeps nothing.
    const listed = await named(false);
    const left = opened(await join(host, listed.open));
    const { control: again } = await connectHost(host);
    expect(JSON.parse((await again.next()) as string)).toEqual({ t: "ready", check: true });
    expect(await left.closed).toBe(1000);
    expect(await openStreams(host)).toEqual({});
    expect(await kept(listed.object)).toBe(0);
  });

  it("closes every stream when a plxd from before PLX-1419 reconnects with no list", async () => {
    const { host, token, control } = await online();
    const client = opened(await connect(host, token));
    const open = JSON.parse((await control.next()) as string) as Open;
    opened(await join(host, open));
    await client.next();
    const { control: again } = await connectHost(host);
    await again.next();
    expect(await client.closed).toBe(1000);
    expect(await openStreams(host)).toEqual({});
  });

  it("keeps through a reconnect only the streams plxd lists whose objects still have its end", async () => {
    const { host, token, control } = await online();
    const joined = async () => {
      const client = opened(await connect(host, token));
      const open = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, open));
      await client.next();
      await side.next();
      return { client, open, side };
    };
    const [kept, unlisted] = [await joined(), await joined()];
    // Listed, but its object has no end of plxd's, as after a deploy.
    const lost = opened(await connect(host, token));
    const { stream: lostId } = JSON.parse((await control.next()) as string) as Open;
    const { control: again } = await connectHost(host, [kept.open.stream, lostId]);
    expect(JSON.parse((await again.next()) as string)).toEqual({ t: "ready", check: true });
    expect(await unlisted.client.closed).toBe(1000);
    expect(await lost.closed).toBe(1000);
    expect(Object.keys(await openStreams(host))).toEqual([kept.open.stream]);

    kept.client.ws.send(new Uint8Array([7]));
    expect(new Uint8Array((await kept.side.next()) as ArrayBuffer)).toEqual(new Uint8Array([7]));
    kept.side.ws.send(new Uint8Array([8]));
    expect(new Uint8Array((await kept.client.next()) as ArrayBuffer)).toEqual(new Uint8Array([8]));

    // Its count carries on: what it carried reports to the host's object as it closes, which also
    // frees its place.
    kept.client.ws.close(1000);
    await expect.poll(() => openStreams(host)).toEqual({});
    const usage = (await (await call("/v1/hosts", { token })).json()) as {
      hosts: { usage: { bytes: number } }[];
    };
    expect(usage.hosts[0]!.usage.bytes).toBe(2 * MIN_FRAME_BYTES);
  });

  it("keeps the spare plxd still holds, so the next client needs nothing from plxd", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, spare));
    const { control: again } = await connectHost(host, [spare.stream]);
    expect(JSON.parse((await again.next()) as string)).toEqual({ t: "ready", check: true });
    expect(await openStreams(host)).toEqual({ [spare.stream]: { spare: true } });
    const client = opened(await connect(host, token));
    expect(await client.next()).toBe("ready");
    expect(await side.next()).toBe("ready");
    expect(await openStreams(host)).toEqual({ [spare.stream]: {} });
  });
});

/** Lists the webhook URLs plxd serves, as plxd does once connected, and waits for the relay. */
async function serveHooks(host: Host, control: Socket, urls: [string, string][]) {
  const keys = await Promise.all(urls.map(([hookId, token]) => hookKey(hookId, token)));
  control.ws.send(JSON.stringify({ t: "hooks", keys }));
  const stub = hosts.get(hosts.idFromName(host.id));
  await expect
    .poll(() => runInDurableObject(stub, (_: HostRelay, state) => state.storage.get<string[]>("hooks")))
    .toEqual([...keys].sort());
}

/** How many webhooks `host`'s object holds. */
function heldCount(host: Host) {
  const stub = hosts.get(hosts.idFromName(host.id));
  return runInDurableObject(stub, (_: HostRelay, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM held").one().n,
  );
}

/** A host whose webhook `hook1/token` plxd listed, then went away. */
async function away() {
  const { host, token, control } = await online();
  await serveHooks(host, control, [["hook1", "token"]]);
  control.ws.close(1000);
  await control.closed;
  return { host, token };
}

describe("webhooks", () => {
  const signed = {
    "content-type": "application/json",
    "x-hub-signature-256": "sha256=abc123",
    cookie: "session=secret",
    "cf-connecting-ip": "203.0.113.9",
  };

  it("reach plxd byte for byte, and plxd's answer reaches the sender", async () => {
    const { host, control } = await online();
    await serveHooks(host, control, [["hook1", "tok%2Fen"]]);
    const body = new TextEncoder().encode('{"action":"published","n": 1 }');
    const sent = call(`/v1/hooks/${host.id}/hook1/tok%2Fen?x=1`, {
      method: "POST",
      headers: signed,
      body,
    });
    const { head, body: received } = hookFrame((await control.next()) as ArrayBuffer);
    expect(head.path).toBe("/api/hooks/hook1/tok%2Fen?x=1");
    expect(head.method).toBe("POST");
    expect(received).toEqual(body);
    expect(head.headers["x-hub-signature-256"]).toBe("sha256=abc123");
    expect(head.headers.cookie).toBeUndefined();
    expect(head.headers["cf-connecting-ip"]).toBeUndefined();
    // plxd checked the signature and refused it.
    control.ws.send(JSON.stringify({ t: "hook", id: head.id, status: 401, body: { error: "invalid_signature" } }));
    const answer = await sent;
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: "invalid_signature" });
  });

  it("are held while plxd is away and delivered when it's back, with the same delivery id", async () => {
    const { host } = await away();
    const held = await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST", body: "one" });
    expect(held.status).toBe(202);
    expect(await held.json()).toEqual({ queued: true });

    const { control } = await connectHost(host);
    expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready", check: true });
    const { head, body } = hookFrame((await control.next()) as ArrayBuffer);
    expect(new TextDecoder().decode(body)).toBe("one");
    control.ws.send(JSON.stringify({ t: "hook", id: head.id, status: 202, body: {} }));
    await expect.poll(() => heldCount(host)).toBe(0);
  });

  it("keep a held webhook plxd answers 429 or 5xx, and try it again from the alarm", async () => {
    const { host } = await away();
    expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST", body: "one" })).status).toBe(202);
    const { control } = await connectHost(host);
    await control.next(); // ready
    const first = hookFrame((await control.next()) as ArrayBuffer);
    control.ws.send(JSON.stringify({ t: "hook", id: first.head.id, status: 429, body: {} }));
    const stub = hosts.get(hosts.idFromName(host.id));
    await expect
      .poll(() =>
        runInDurableObject(stub, (_: HostRelay, state) =>
          state.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM held").one().attempts,
        ),
      )
      .toBe(1);

    // Due now: the alarm sends it again with the same delivery id, and a 500 keeps it too.
    await runInDurableObject(stub, (_: HostRelay, state) => state.storage.sql.exec("UPDATE held SET retry_at = 1"));
    const alarm = runDurableObjectAlarm(stub);
    const second = hookFrame((await control.next()) as ArrayBuffer);
    expect(second.head.id).toBe(first.head.id);
    control.ws.send(JSON.stringify({ t: "hook", id: second.head.id, status: 500, body: {} }));
    await alarm;
    expect(await heldCount(host)).toBe(1);

    await runInDurableObject(stub, (_: HostRelay, state) => state.storage.sql.exec("UPDATE held SET retry_at = 1"));
    const again = runDurableObjectAlarm(stub);
    const third = hookFrame((await control.next()) as ArrayBuffer);
    control.ws.send(JSON.stringify({ t: "hook", id: third.head.id, status: 404, body: {} }));
    await again;
    expect(await heldCount(host)).toBe(0);
  });

  it("refuse unlisted URLs, bodies over 1 MiB, and hosts nobody registered, holding and counting nothing", async () => {
    const { host } = await away();
    for (let i = 0; i < LIMITS.hookUrl + 5; i++) {
      expect((await call(`/v1/hooks/${host.id}/hook1/guess${i}`, { method: "POST", body: "x" })).status).toBe(404);
    }
    const big = await call(`/v1/hooks/${host.id}/hook1/token`, {
      method: "POST",
      body: new Uint8Array(MAX_HOOK_BYTES + 1),
    });
    expect(big.status).toBe(413);
    expect(await heldCount(host)).toBe(0);
    // The real sender's budget is untouched.
    expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST" })).status).toBe(202);
    const nobody = await newHost();
    expect((await call(`/v1/hooks/${nobody.id}/hook1/token`, { method: "POST" })).status).toBe(404);
    expect(((await socket(`/v1/hosts/${nobody.id}/host`)) as Response).status).toBe(404);
    const stored = await runInDurableObject(hosts.get(hosts.idFromName(nobody.id)), async (_: HostRelay, state) => ({
      keys: (await state.storage.list()).size,
      tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'held'").toArray().length,
    }));
    expect(stored).toEqual({ keys: 0, tables: 0 });
  });
});

describe("held webhook retries", () => {
  it("wake no sooner than the oldest webhook of a hook is due, however many wait behind it", async () => {
    const { host, control } = await online();
    await serveHooks(host, control, [["hook1", "token"]]);
    const stub = hosts.get(hosts.idFromName(host.id));
    const now = Date.now();
    const due = now + 60_000;
    // The oldest waits a minute; the ones behind it look overdue, as after timeouts.
    await runInDurableObject(stub, (relay: HostRelay) => {
      const sql = (relay as unknown as { held(): SqlStorage }).held();
      const head = (id: string) => JSON.stringify({ id, method: "POST", path: "/api/hooks/hook1/token", headers: {} });
      sql.exec("INSERT INTO held (id, received, hook, size, head, body, attempts, retry_at) VALUES ('a', ?, 'hook1', 0, ?, x'', 1, ?)", now - 3, head("a"), due);
      sql.exec("INSERT INTO held (id, received, hook, size, head, body, retry_at) VALUES ('b', ?, 'hook1', 0, ?, x'', 1)", now - 2, head("b"));
      sql.exec("INSERT INTO held (id, received, hook, size, head, body, retry_at) VALUES ('c', ?, 'hook1', 0, ?, x'', 1)", now - 1, head("c"));
    });
    const alarm = () => runInDurableObject(stub, (_: HostRelay, state) => state.storage.getAlarm());
    await runInDurableObject(stub, (relay: HostRelay) => (relay as unknown as { schedule(): Promise<void> }).schedule());
    expect(await alarm()).toBeGreaterThanOrEqual(due);
    // Woken early anyway, it delivers nothing and sets the same alarm, not one in the past.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarm()).toBeGreaterThanOrEqual(due);
    expect(await heldCount(host)).toBe(3);
    // Nothing was sent ahead of the oldest.
    const sent = await Promise.race([control.next(), new Promise((r) => setTimeout(() => r("none"), 200))]);
    expect(sent).toBe("none");
  });
});

describe("rate limits", () => {
  it("limit each hook URL, a host's stream opens, and a user's signed-in requests", async () => {
    const { host } = await away();
    for (let i = 0; i < LIMITS.hookUrl; i++) {
      expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST" })).status).toBe(202);
    }
    expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST" })).status).toBe(429);

    // A ticket and an open with a token count alike: 30 a host a minute.
    const ticketed = await online();
    for (let i = 0; i < LIMITS.opens - 1; i++) {
      expect((await call(`/v1/hosts/${ticketed.host.id}/tickets`, { method: "POST", token: ticketed.token })).status).toBe(200);
    }
    opened(await connect(ticketed.host, ticketed.token));
    const over = await connect(ticketed.host, ticketed.token);
    expect(over instanceof Response && over.status).toBe(429);
    expect((await call(`/v1/hosts/${ticketed.host.id}/tickets`, { method: "POST", token: ticketed.token })).status).toBe(429);

    const token = await session("user_busy");
    for (let i = 0; i < USER_LIMITS.requests; i++) {
      expect((await call("/v1/hosts", { token })).status).toBe(200);
    }
    expect((await call("/v1/hosts", { token })).status).toBe(429);
    expect((await call("/v1/hosts", { token: await session("user_calm") })).status).toBe(200);
  });

  it("lets no client reach a host's object before the anonymous limit answers, whatever its token", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, spare));
    const open = vi.spyOn(HostRelay.prototype, "open");
    // The limit answers when the test says, long after the token's check is done.
    const attempt = (bearer: string) => {
      let answer!: (outcome: { success: boolean }) => void;
      const ANON = { limit: () => new Promise<{ success: boolean }>((resolve) => (answer = resolve)) };
      const response = worker.fetch(
        new Request(`${BASE}/v1/hosts/${host.id}/connect`, { headers: { upgrade: "websocket", authorization: `Bearer ${bearer}` } }),
        { ...testEnv, ANON } as Env,
      );
      return { response, answer };
    };
    try {
      const held = attempt(token);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(open).not.toHaveBeenCalled();
      held.answer({ success: false });
      expect((await held.response).status).toBe(429);
      // A bad token within the limit is refused as before, and the limit's refusal comes first.
      const forged = attempt(`${token}x`);
      forged.answer({ success: true });
      expect((await forged.response).status).toBe(401);
      const both = attempt(`${token}x`);
      both.answer({ success: false });
      expect((await both.response).status).toBe(429);
      expect(open).not.toHaveBeenCalled();
      expect(await openStreams(host)).toEqual({ [spare.stream]: { spare: true } });

      const allowed = attempt(token);
      allowed.answer({ success: true });
      const response = await allowed.response;
      expect(response.status).toBe(101);
      expect(open).toHaveBeenCalledTimes(1);
      response.webSocket!.accept();
      expect(await side.next()).toBe("ready");
    } finally {
      open.mockRestore();
    }
  });

  it("count only control connections with a valid proof, so strangers can't lock plxd out", async () => {
    const { host } = await online();
    // Strangers who know the host id, from a webhook URL, get no socket at all.
    for (let i = 0; i < LIMITS.hostConnect + 4; i++) {
      const stranger = await socket(`/v1/hosts/${host.id}/host`);
      expect(stranger instanceof Response && stranger.status).toBe(401);
    }
    const { control } = await connectHost(host);
    expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready", check: true });
    // plxd's own reconnects are what count.
    for (let i = 2; i < LIMITS.hostConnect; i++) await (await connectHost(host)).control.next();
    const over = await hostSocket(host, await hostProof(host));
    expect(over instanceof Response && over.status).toBe(429);
  });
});

describe("a device's removal", () => {
  /** Whether nothing arrives on `control` for a moment. Its last read: it holds the next message. */
  const silent = (control: Socket) =>
    Promise.race([
      control.next().then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
    ]);

  it("goes as sent to its user's other online hosts only, and is kept for none", async () => {
    const user = `user_${crypto.randomUUID()}`;
    const from = await online(user);
    const peer = await online(user);
    const stranger = await online();
    const away = await newHost();
    expect((await register(away, from.token)).status).toBe(200);

    from.control.ws.send(JSON.stringify({ t: "removed", statement: "opaque" }));
    expect(JSON.parse((await peer.control.next()) as string)).toEqual({
      t: "removed",
      statement: "opaque",
    });
    expect(await silent(from.control)).toBe(true);
    expect(await silent(stranger.control)).toBe(true);

    const { control } = await connectHost(away);
    expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready", check: true });
    expect(await silent(control)).toBe(true);
  });

  it("drops a statement past its size or rate", async () => {
    const user = `user_${crypto.randomUUID()}`;
    const from = await online(user);
    const peer = await online(user);
    const send = (statement: unknown) =>
      from.control.ws.send(JSON.stringify({ t: "removed", statement }));

    send("x".repeat(MAX_REMOVAL + 1));
    send(7);
    send("first");
    expect(JSON.parse((await peer.control.next()) as string).statement).toBe("first");

    for (let sent = 1; sent < LIMITS.removals; sent++) send(String(sent));
    for (let sent = 1; sent < LIMITS.removals; sent++)
      expect(JSON.parse((await peer.control.next()) as string).statement).toBe(String(sent));
    send("over");
    expect(await silent(peer.control)).toBe(true);
  });
});

describe("removing hosts", () => {
  it("lets a user remove their own host, and no one else's, which frees its slot", async () => {
    const token = await session("user_remover");
    const hostsOf = async () =>
      ((await (await call("/v1/hosts", { token })).json()) as { hosts: { hostId: string }[] }).hosts;
    const mine = await Promise.all(Array.from({ length: MAX_HOSTS }, () => newHost()));
    for (const host of mine) expect((await register(host, token)).status).toBe(200);
    expect((await register(await newHost(), token)).status).toBe(403);

    const intruder = await session("user_intruder");
    expect((await call(`/v1/hosts/${mine[0]!.id}`, { method: "DELETE", token: intruder })).status).toBe(404);
    expect(await hostsOf()).toHaveLength(MAX_HOSTS);

    expect((await call(`/v1/hosts/${mine[0]!.id}`, { method: "DELETE", token })).status).toBe(200);
    expect((await hostsOf()).map((h) => h.hostId)).not.toContain(mine[0]!.id);
    expect((await call(`/v1/hosts/${mine[0]!.id}/tickets`, { method: "POST", token })).status).toBe(404);
    const stored = await runInDurableObject(hosts.get(hosts.idFromName(mine[0]!.id)), async (_: HostRelay, state) =>
      (await state.storage.list()).size,
    );
    expect(stored).toBe(0);
    expect((await register(await newHost(), token)).status).toBe(200);
  });

  it("lists a host as removed until it registers under that user again", async () => {
    const token = await session("user_marks");
    const removed = async (as = token) =>
      ((await (await call("/v1/hosts", { token: as })).json()) as { removed: string[] }).removed;
    const host = await newHost();
    expect((await register(host, token)).status).toBe(200);
    expect(await removed()).toEqual([]);

    expect((await call(`/v1/hosts/${host.id}`, { method: "DELETE", token })).status).toBe(200);
    expect(await removed()).toEqual([host.id]);
    // Registering, here by the key's holder, brings it back.
    expect((await register(host, token)).status).toBe(200);
    expect(await removed()).toEqual([]);

    // Another user's Remove marks only their own list.
    const other = await session("user_marks_other");
    expect((await call(`/v1/hosts/${host.id}`, { method: "DELETE", token: other })).status).toBe(404);
    expect(await removed()).toEqual([]);
    expect(await removed(other)).toEqual([host.id]);

    // Moving to another user leaves this account, as removing does.
    expect((await register(host, other)).status).toBe(200);
    expect(await removed()).toEqual([host.id]);
    expect(await removed(other)).toEqual([]);
  });
});

describe("a Clerk outage", () => {
  it("answers 503, not 401, when Clerk's keys can't be read, and 401 for what isn't a token", async () => {
    const env = {
      ...testEnv,
      CLERK_JWKS: undefined,
      CLERK_ISSUER: "https://clerk-down.test",
      CLERK_JWKS_URL: "http://127.0.0.1:1/jwks",
    } as Env;
    const list = (token: string) =>
      worker.fetch(
        new Request(`${BASE}/v1/hosts`, { headers: { authorization: `Bearer ${token}` } }),
        env,
      );
    const down = await list(await session("user_clerk_down", { iss: "https://clerk-down.test" }));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "clerk_unreachable" });
    expect((await list("not-a-jwt")).status).toBe(401);
  });
});

describe("cost ceilings", () => {
  it("cap the hosts one user registers, even when they register at once", async () => {
    const token = await session("user_many");
    const hosts = await Promise.all(Array.from({ length: 2 * MAX_HOSTS }, () => newHost()));
    const statuses = (await Promise.all(hosts.map((host) => register(host, token)))).map((r) => r.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(MAX_HOSTS);
    expect(statuses.filter((status) => status === 403)).toHaveLength(MAX_HOSTS);
    const listed = (await (await call("/v1/hosts", { token })).json()) as { hosts: unknown[] };
    expect(listed.hosts).toHaveLength(MAX_HOSTS);
  });

  it("cap a host's open streams at 16, its spare included", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    await control.next();
    for (let i = 1; i < MAX_STREAMS; i++) opened(await connect(host, token));
    // The 16th took the spare; the 17th finds none and no room.
    opened(await connect(host, token));
    const over = await connect(host, token);
    expect(over instanceof Response && over.status).toBe(429);
    expect(Object.keys(await openStreams(host))).toHaveLength(MAX_STREAMS);
  });

  it("cap a host's open streams at 16 when clients connect at once, its spare included", async () => {
    const { host, token, control } = await online();
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse((await control.next()) as string) as Open;
    opened(await join(host, spare));
    const results = await Promise.all(Array.from({ length: MAX_STREAMS + 4 }, () => connect(host, token)));
    const refused = results.filter((result): result is Response => result instanceof Response);
    expect(results.length - refused.length).toBe(MAX_STREAMS);
    for (const response of refused) {
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "too_many_streams" });
    }
    const counted = await openStreams(host);
    expect(Object.keys(counted)).toHaveLength(MAX_STREAMS);
    // One client has the spare, and no stream is left marked as one.
    expect(counted[spare.stream]).toEqual({});
    expect(Object.values(counted).filter((entry) => entry.spare)).toEqual([]);
  });

  it("cap a host's open streams at 16 across a reconnect, and free only those plxd no longer holds", async () => {
    const { host, token, control } = await online();
    const ids: string[] = [];
    for (let i = 0; i < MAX_STREAMS; i++) {
      opened(await connect(host, token));
      const open = JSON.parse((await control.next()) as string) as Open;
      opened(await join(host, open));
      ids.push(open.stream);
    }
    const { control: all } = await connectHost(host, ids);
    await all.next();
    const over = await connect(host, token);
    expect(over instanceof Response && over.status).toBe(429);
    expect(Object.keys(await openStreams(host))).toHaveLength(MAX_STREAMS);

    const { control: fewer } = await connectHost(host, ids.slice(1));
    await fewer.next();
    expect(Object.keys(await openStreams(host))).toHaveLength(MAX_STREAMS - 1);
    opened(await connect(host, token));
    expect(Object.keys(await openStreams(host))).toHaveLength(MAX_STREAMS);
  });

  it("count each stream frame as at least 16 KiB, reported every 8 MiB, and close every stream past a host's daily bytes", async () => {
    const { host, token, control } = await online();
    const ends = [];
    for (let i = 0; i < 2; i++) {
      const client = opened(await connect(host, token));
      const open = JSON.parse((await control.next()) as string) as Open;
      const side = opened(await join(host, open));
      await client.next();
      await side.next();
      ends.push({ client, side, open });
    }
    const [first, second] = ends as [(typeof ends)[0], (typeof ends)[0]];
    await runInDurableObject(hosts.get(hosts.idFromName(host.id)), async (relay: HostRelay, state) => {
      const day = new Date().toISOString().slice(0, 10);
      await state.storage.put("traffic", { day, bytes: MAX_DAILY_BYTES - REPORT_BYTES + 1 });
      (relay as unknown as { traffic?: object }).traffic = undefined;
    });
    // Two frames short of a report: each one-byte frame counts as 16 KiB.
    await runInDurableObject(streamObject(first.open.stream), (relay: StreamRelay) => {
      (relay as unknown as { unreported: number }).unreported = REPORT_BYTES - 2 * MIN_FRAME_BYTES;
    });
    first.client.ws.send(new Uint8Array([0]));
    expect(new Uint8Array((await first.side.next()) as ArrayBuffer)).toEqual(new Uint8Array([0]));
    // This one reports 8 MiB, which spends the day, so both streams close.
    first.client.ws.send(new Uint8Array([1]));
    expect(await first.client.closed).toBe(4429);
    expect(await second.client.closed).toBe(4429);
    expect(await second.side.closed).toBe(4429);
    const refused = await connect(host, token);
    expect(refused instanceof Response && refused.status).toBe(429);
    expect((await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token })).status).toBe(429);
  });

  it("keep a stream's unreported count across hibernation", async () => {
    const { host, token, control } = await online();
    const client = opened(await connect(host, token));
    const open = JSON.parse((await control.next()) as string) as Open;
    const side = opened(await join(host, open));
    await client.next();
    await side.next();
    const send = async (byte: number) => {
      client.ws.send(new Uint8Array([byte]));
      expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(new Uint8Array([byte]));
    };
    for (let i = 0; i < 3; i++) await send(i);
    // Its in-memory state goes; the WebSockets hibernate, open.
    await evictDurableObject(streamObject(open.stream));
    await send(3);
    client.ws.close(1000);
    await side.closed;
    const traffic = () =>
      runInDurableObject(hosts.get(hosts.idFromName(host.id)), async (_: HostRelay, state) =>
        (await state.storage.get<{ bytes: number }>("traffic"))?.bytes,
      );
    await expect.poll(traffic).toBe(4 * MIN_FRAME_BYTES);
  });

  it("key anonymous limits by IPv4 address or IPv6 /64", () => {
    expect(network("203.0.113.9")).toBe("203.0.113.9");
    expect(network("2001:db8:a:b:1:2:3:4")).toBe("2001:db8:a:b");
    expect(network("2001:0DB8:000a::1")).toBe("2001:db8:a:0");
    expect(network("::1")).toBe("0:0:0:0");
  });
});

describe("push", () => {
  it("reaches only the host's own user's devices, with no thread content", async () => {
    const { control } = await online("user_a");
    const mine = "a".repeat(64);
    const theirs = "b".repeat(64);
    await call("/v1/devices", { method: "POST", token: await session("user_a"), body: JSON.stringify({ token: mine }) });
    await call("/v1/devices", { method: "POST", token: await session("user_b"), body: JSON.stringify({ token: theirs }) });
    expect(
      (await call("/v1/devices", { method: "POST", token: await session("user_a"), body: '{"token":"nope"}' })).status,
    ).toBe(400);
    control.ws.send(JSON.stringify({ t: "push", run: "run-1", state: "needsYou" }));
    control.ws.send(JSON.stringify({ t: "push", run: "run-1", state: "secret text" }));
    const outbox = (user: string) =>
      runInDurableObject(users.get(users.idFromName(account(user))), (it: UserAccount) => it.outbox);
    await expect.poll(() => outbox("user_a")).toHaveLength(1);
    const [sent] = await outbox("user_a");
    expect(sent!.device).toBe(mine);
    expect(sent!.notification).toMatchObject({ run: "run-1", state: "needsYou" });
    expect(await outbox("user_b")).toEqual([]);
  });

  it("carries `sealed` unread to the extension, and drops one past the cap", async () => {
    const { control } = await online("user_c");
    const device = "d".repeat(64);
    await call("/v1/devices", { method: "POST", token: await session("user_c"), body: JSON.stringify({ token: device }) });
    const sealed = "not-base64!".repeat(10);
    control.ws.send(JSON.stringify({ t: "push", run: "run-1", state: "done", sealed }));
    control.ws.send(JSON.stringify({ t: "push", run: "run-2", state: "done", sealed: "x".repeat(MAX_SEALED + 1) }));
    const outbox = () => runInDurableObject(users.get(users.idFromName(account("user_c"))), (it: UserAccount) => it.outbox);
    await expect.poll(outbox).toHaveLength(2);
    const [opened, plain] = await outbox();
    expect(opened!.notification.sealed).toBe(sealed);
    expect(plain!.notification.run).toBe("run-2");
    expect(plain!.notification.sealed).toBeUndefined();

    const payload = apnsPayload(opened!.notification);
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload.aps.alert.body).toBe("A thread finished.");
    expect(payload.body.sealed).toBe(sealed);
    // Without it the extension doesn't wake.
    expect(apnsPayload(plain!.notification).aps).not.toHaveProperty("mutable-content");
  });

  it("signs with the APNs key and falls back to sandbox for a development build's token", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
    const env = { APNS_KEY: pem, APNS_KEY_ID: "KEYID12345", APNS_TEAM_ID: "TEAM123456" } as Env;
    const device = "c".repeat(64);
    const notification = { hostId: "host-1", run: "run-1", state: "done" } as const;

    // Production refuses a sandbox token, then sandbox takes it.
    const seen: Request[] = [];
    const sandboxOnly = async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(url, init);
      seen.push(request);
      return request.url.includes("sandbox")
        ? new Response(null, { status: 200 })
        : Response.json({ reason: "BadDeviceToken" }, { status: 400 });
    };
    expect(await sendApns(env, device, notification, sandboxOnly as typeof fetch)).toBe("sent");
    expect(seen.map((r) => new URL(r.url).host)).toEqual(["api.push.apple.com", "api.sandbox.push.apple.com"]);
    const [request] = seen;
    expect(new URL(request!.url).pathname).toBe(`/3/device/${device}`);
    expect(request!.headers.get("apns-topic")).toBe("dev.parallax.mobile");
    expect(request!.headers.get("apns-collapse-id")).toBe("run-1:done");
    // The app reads a remote push's data from `body`.
    expect((await request!.json<{ body: unknown }>()).body).toEqual(notification);

    const [head, claims, signature] = request!.headers.get("authorization")!.replace("bearer ", "").split(".");
    expect(JSON.parse(atob(head!))).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(JSON.parse(atob(claims!))).toMatchObject({ iss: "TEAM123456" });
    const raw = Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        raw,
        new TextEncoder().encode(`${head}.${claims}`),
      ),
    ).toBe(true);

    // A token both servers refuse is gone.
    const neither = async () => Response.json({ reason: "BadDeviceToken" }, { status: 400 });
    expect(await sendApns(env, device, notification, neither as typeof fetch)).toBe("gone");
  });
});

describe("logs", () => {
  /** The relay's log lines written during `run`, parsed. */
  async function lines(run: (seen: () => Record<string, unknown>[]) => Promise<void>) {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const seen = () =>
      spy.mock.calls.flatMap(([line]) =>
        typeof line === "string" && line.startsWith('{"event"') ? [JSON.parse(line)] : [],
      );
    try {
      await run(seen);
      return seen();
    } finally {
      spy.mockRestore();
    }
  }

  it("say who closed plxd's socket and a stream's ends, with ids cut and no user or token", async () => {
    const user = `user_${crypto.randomUUID()}`;
    const { host, token, control } = await online(user);
    const short = host.id.slice(0, 8);
    const logs = await lines(async (seen) => {
      const { client, open } = await stream(host, token, control);
      opened(await join(host, open));
      client.ws.close(1000, "client done");
      await vi.waitFor(() => expect(seen().filter((l) => l.event === "socket_closed")).toHaveLength(2));
      await connectHost(host);
      await control.closed;
      await vi.waitFor(() => expect(seen().filter((l) => l.object === "host")).toHaveLength(3));
    });
    expect(logs).toEqual([
      expect.objectContaining({ event: "socket_closed", side: "client", stream: expect.stringMatching(`^${short}/.{8}$`), by: "peer", code: 1000, reason: "client done", clean: true }),
      expect.objectContaining({ event: "socket_closed", side: "host", by: "relay", code: 1000, reason: "closed" }),
      expect.objectContaining({ event: "socket_closing", object: "host", host: short, by: "relay", code: 4409, reason: "replaced" }),
      expect.objectContaining({ event: "host_connected", host: short, open_before: 1, since_last_ms: expect.any(Number) }),
      expect.objectContaining({ event: "socket_closed", object: "host", host: short, by: "relay", code: 4409, clean: true }),
    ]);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(host.id);
    expect(text).not.toContain(user);
    expect(text).not.toContain(token);
  });

  it("carry what a handler threw and throw it on, without tokens or JSON.parse's quoted input", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reset = Object.assign(new Error(`lost ${await session("user_a")} on user_${"x".repeat(27)}`), {
        durableObjectReset: true,
        remote: true,
      });
      await expect(logged("host.alarm", () => ({ host: "abcd1234" }), () => Promise.reject(reset))).rejects.toBe(reset);
      const line = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(line).toMatchObject({ event: "exception", where: "host.alarm", host: "abcd1234", name: "Error", durableObjectReset: true, remote: true });
      expect(line.message).toBe("lost [cut].[cut].[cut] on [cut]");
      expect(line.frames[0]).toMatch(/^at /);

      await expect(
        logged("host.fetch", () => ({}), () => JSON.parse('{"secret payload')),
      ).rejects.toThrow(SyntaxError);
      const syntax = spy.mock.calls[1]![0] as string;
      expect(JSON.parse(syntax).name).toBe("SyntaxError");
      expect(syntax).not.toContain("secret");
    } finally {
      spy.mockRestore();
    }
  });
});
