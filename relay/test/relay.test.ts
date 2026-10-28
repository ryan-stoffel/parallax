import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { sha256 } from "../src/crypto";
import {
  hookKey,
  HostRelay,
  LIMITS,
  MAX_DAILY_BYTES,
  MAX_HOOK_BYTES,
  MIN_FRAME_BYTES,
} from "../src/host";
import { type Env, network } from "../src/index";
import { sendApns } from "../src/push";
import { MAX_HOSTS, UserAccount, USER_LIMITS } from "../src/user";
import {
  call,
  connectHost,
  hostProof,
  hostSocket,
  hookFrame,
  type Host,
  newHost,
  opened,
  register,
  session,
  type Socket,
  socket,
  testEnv,
} from "./helpers";

/** A registered, connected host for `user`, a new one by default, and that user's token. */
async function online(user = `user_${crypto.randomUUID()}`) {
  const host = await newHost();
  const token = await session(user);
  expect((await register(host, token)).status).toBe(200);
  const { control } = await connectHost(host);
  expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready" });
  return { host, token, control };
}

/** A client's stream to `host`, joined by plxd's side. */
async function stream(host: Host, token: string, control: Awaited<ReturnType<typeof online>>["control"]) {
  const ticket = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token });
  expect(ticket.status).toBe(200);
  const { ticket: value } = (await ticket.json()) as { ticket: string };
  const client = opened(await socket(`/v1/hosts/${host.id}/connect?ticket=${value}`));
  const open = JSON.parse((await control.next()) as string) as { t: string; stream: string; token: string };
  expect(open.t).toBe("open");
  return { client, open, ticket: value };
}

const hosts = testEnv.HOSTS;
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
    const desktop = await session("user_a", { sid: undefined, client_id: "SXDueyOLOJ2v4Vmq" });
    expect((await call("/v1/hosts", { token: desktop })).status).toBe(200);
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
  it("hides the host and refuses tickets for another user", async () => {
    const { host } = await online("user_listed");
    const intruder = await session("user_b");
    const tickets = await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token: intruder });
    expect(tickets.status).toBe(404);
    const list = (await (await call("/v1/hosts", { token: intruder })).json()) as { hosts: unknown[] };
    expect(list.hosts).toEqual([]);
    const own = await call("/v1/hosts", { token: await session("user_listed") });
    expect(await own.json()).toEqual({ hosts: [{ hostId: host.id, name: "Ryan's Mac", online: true }] });
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

describe("streams", () => {
  it("joins plxd's side only with the token sent to plxd, and passes bytes unread", async () => {
    const { host, token, control } = await online();
    const { client, open } = await stream(host, token, control);
    const wrong = await socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=nope`);
    expect(wrong instanceof Response && wrong.status).toBe(404);
    const side = opened(await socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`));
    expect(await client.next()).toBe("ready");
    // A second join with the same token is refused: the stream already has its side.
    const again = await socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`);
    expect(again instanceof Response && again.status).toBe(404);

    const record = new Uint8Array([0x16, 0x03, 0x01, 0, 4, 1, 2, 3, 4]);
    client.ws.send(record);
    expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(record);
    side.ws.send(record.slice().reverse());
    expect(new Uint8Array((await client.next()) as ArrayBuffer)).toEqual(record.slice().reverse());

    // The relay keeps nothing of a stream: only the host's registration is stored.
    const stub = hosts.get(hosts.idFromName(host.id));
    const stored = await runInDurableObject(stub, async (_: HostRelay, state) => ({
      keys: [...(await state.storage.list()).keys()],
      held: state.storage.sql.exec("SELECT count(*) AS n FROM held").one().n,
    }));
    expect(stored).toEqual({ keys: ["lastProof", "owner"], held: 0 });

    client.ws.close(1000);
    expect(await side.closed).toBe(1000);
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
    expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready" });
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
  it("limit each hook URL, a host's tickets, and a user's signed-in requests", async () => {
    const { host } = await away();
    for (let i = 0; i < LIMITS.hookUrl; i++) {
      expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST" })).status).toBe(202);
    }
    expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST" })).status).toBe(429);

    const ticketed = await online();
    for (let i = 0; i < LIMITS.tickets; i++) {
      expect((await call(`/v1/hosts/${ticketed.host.id}/tickets`, { method: "POST", token: ticketed.token })).status).toBe(200);
    }
    expect((await call(`/v1/hosts/${ticketed.host.id}/tickets`, { method: "POST", token: ticketed.token })).status).toBe(429);

    const token = await session("user_busy");
    for (let i = 0; i < USER_LIMITS.requests; i++) {
      expect((await call("/v1/hosts", { token })).status).toBe(200);
    }
    expect((await call("/v1/hosts", { token })).status).toBe(429);
    expect((await call("/v1/hosts", { token: await session("user_calm") })).status).toBe(200);
  });

  it("count only control connections with a valid proof, so strangers can't lock plxd out", async () => {
    const { host } = await online();
    // Strangers who know the host id, from a webhook URL, get no socket at all.
    for (let i = 0; i < LIMITS.hostConnect + 4; i++) {
      const stranger = await socket(`/v1/hosts/${host.id}/host`);
      expect(stranger instanceof Response && stranger.status).toBe(401);
    }
    const { control } = await connectHost(host);
    expect(JSON.parse((await control.next()) as string)).toEqual({ t: "ready" });
    // plxd's own reconnects are what count.
    for (let i = 2; i < LIMITS.hostConnect; i++) await (await connectHost(host)).control.next();
    const over = await hostSocket(host, await hostProof(host));
    expect(over instanceof Response && over.status).toBe(429);
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

  it("count each stream frame as at least 16 KiB, and close a host's streams and tickets past its daily bytes", async () => {
    const { host, token, control } = await online();
    const { client, open } = await stream(host, token, control);
    const side = opened(await socket(`/v1/hosts/${host.id}/streams/${open.stream}?token=${open.token}`));
    await client.next();
    const stub = hosts.get(hosts.idFromName(host.id));
    await runInDurableObject(stub, (relay: HostRelay) => {
      const day = new Date().toISOString().slice(0, 10);
      const bytes = MAX_DAILY_BYTES - 2 * MIN_FRAME_BYTES;
      (relay as unknown as { traffic: object }).traffic = { day, bytes, saved: bytes };
    });
    for (let i = 0; i < 2; i++) {
      client.ws.send(new Uint8Array([i]));
      expect(new Uint8Array((await side.next()) as ArrayBuffer)).toEqual(new Uint8Array([i]));
    }
    client.ws.send(new Uint8Array([2]));
    expect(await client.closed).toBe(4429);
    expect(await side.closed).toBe(4429);
    expect((await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token })).status).toBe(429);
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
      runInDurableObject(users.get(users.idFromName(user)), (account: UserAccount) => account.outbox);
    await expect.poll(() => outbox("user_a")).toHaveLength(1);
    const [sent] = await outbox("user_a");
    expect(sent!.device).toBe(mine);
    expect(sent!.notification).toMatchObject({ run: "run-1", state: "needsYou" });
    expect(await outbox("user_b")).toEqual([]);
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
