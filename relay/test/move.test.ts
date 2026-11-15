import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { accountOf, DEVELOPMENT } from "../src/clerk";
import { sha256 } from "../src/crypto";
import { hookKey, type HostRelay, registerMessage } from "../src/host";
import { MAX_HOSTS } from "../src/user";
import {
  call,
  connectHost,
  type Host,
  hookFrame,
  newHost,
  register,
  session,
  socket,
  testEnv,
} from "./helpers";

// The move from Clerk's development instance to production (PLX-1465). This test's own instance,
// `https://clerk.test`, stands in for production.

const hosts = testEnv.HOSTS;

/** A host registered under a new development user, and that user's id. */
async function onDevelopment() {
  const user = `user_${crypto.randomUUID()}`;
  const host = await newHost();
  expect((await register(host, await session(user, { iss: DEVELOPMENT }))).status).toBe(200);
  return { host, user, dev: () => session(user, { iss: DEVELOPMENT }) };
}

/** Moves `host` to the account of `token`, proven by `from`, signed by `signer`. */
async function move(host: Host, token: string, from: string | undefined, signer: Host = host) {
  const signature = await signer.sign(registerMessage(host.id, await sha256(token)));
  return call(`/v1/hosts/${host.id}/move`, {
    method: "POST",
    token,
    body: JSON.stringify({ hostId: host.id, jwk: host.jwk, name: "Other name", signature, from }),
  });
}

/** The host ids listed, and marked removed, for the account of `token`. */
async function list(token: string) {
  const body = (await (await call("/v1/hosts", { token })).json()) as {
    hosts: { hostId: string; name: string; usage: { bytes: number } }[];
    removed: string[];
  };
  return { ids: body.hosts.map((h) => h.hostId), hosts: body.hosts, removed: body.removed };
}

const owner = (host: Host) =>
  runInDurableObject(hosts.get(hosts.idFromName(host.id)), (_: HostRelay, state) =>
    state.storage.get<{ user: string }>("owner"),
  );

describe("moving a host to a production account (PLX-1465)", () => {
  it("moves it with both accounts' tokens, keeping its id, name, held webhooks, and traffic", async () => {
    const { host, user, dev } = await onDevelopment();
    // plxd listed a webhook, then went away, so the relay holds the next one.
    const { control } = await connectHost(host);
    await control.next();
    const keys = [await hookKey("hook1", "token")];
    control.ws.send(JSON.stringify({ t: "hooks", keys }));
    const stub = hosts.get(hosts.idFromName(host.id));
    await expect
      .poll(() => runInDurableObject(stub, (_: HostRelay, state) => state.storage.get("hooks")))
      .toEqual(keys);
    control.ws.close(1000);
    await control.closed;
    expect((await call(`/v1/hooks/${host.id}/hook1/token`, { method: "POST", body: "one" })).status).toBe(202);
    await runInDurableObject(stub, async (relay: HostRelay, state) => {
      await state.storage.put("traffic", { day: new Date().toISOString().slice(0, 10), bytes: 4_321 });
      (relay as unknown as { traffic?: object }).traffic = undefined;
    });

    const production = await session(user);
    const moved = await move(host, production, await dev());
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ hostId: host.id, name: "Ryan's Mac" });
    expect((await owner(host))?.user).toBe(accountOf("https://clerk.test", user));

    // It left development without a removal mark, and production lists it with today's bytes.
    expect(await list(await dev())).toEqual({ ids: [], hosts: [], removed: [] });
    const listed = await list(production);
    expect(listed.ids).toEqual([host.id]);
    expect(listed.hosts[0]!.usage.bytes).toBe(4_321);
    expect((await call(`/v1/hosts/${host.id}/tickets`, { method: "POST", token: await dev() })).status).toBe(404);

    // The held webhook reaches plxd when it's back.
    const back = await connectHost(host);
    expect(JSON.parse((await back.control.next()) as string)).toEqual({ t: "ready", check: true });
    const { body } = hookFrame((await back.control.next()) as ArrayBuffer);
    expect(new TextDecoder().decode(body)).toBe("one");
  });

  it("keeps plxd's control socket open, and opens streams for the new account only", async () => {
    const { host, user, dev } = await onDevelopment();
    const { control } = await connectHost(host);
    await control.next();
    const production = await session(user);
    expect((await move(host, production, await dev())).status).toBe(200);
    const refused = await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${await dev()}` });
    expect(refused instanceof Response && refused.status).toBe(404);
    await socket(`/v1/hosts/${host.id}/connect`, { authorization: `Bearer ${production}` });
    // The same socket is asked for the stream: the move didn't close it.
    expect(JSON.parse((await control.next()) as string)).toMatchObject({ t: "open" });
  });

  it("answers a repeated move as the first, and lists the host once", async () => {
    const { host, user, dev } = await onDevelopment();
    const production = await session(user);
    expect((await move(host, production, await dev())).status).toBe(200);
    const again = await move(host, production, await dev());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ hostId: host.id, name: "Ryan's Mac" });
    expect((await list(production)).ids).toEqual([host.id]);
  });

  it("refuses without a token for the account the host is on, or the host key's signature", async () => {
    const { host, user, dev } = await onDevelopment();
    const production = await session(user);
    const stranger = await session(`user_${crypto.randomUUID()}`, { iss: DEVELOPMENT });
    expect((await move(host, production, undefined)).status).toBe(400);
    expect((await move(host, production, "not-a-token")).status).toBe(401);
    expect((await move(host, production, await session(user, { iss: DEVELOPMENT, exp: 1 }))).status).toBe(401);
    const notOwner = await move(host, production, stranger);
    expect(notOwner.status).toBe(409);
    expect(await notOwner.json()).toEqual({ error: "not_owner" });
    const other = await newHost();
    expect((await move(host, production, await dev(), other)).status).toBe(401);
    // A signature over another token's hash doesn't carry over.
    const signature = await host.sign(registerMessage(host.id, await sha256(await dev())));
    const replayed = await call(`/v1/hosts/${host.id}/move`, {
      method: "POST",
      token: production,
      body: JSON.stringify({ hostId: host.id, jwk: host.jwk, signature, from: await dev() }),
    });
    expect(replayed.status).toBe(401);
    expect((await owner(host))?.user).toBe(user);
    expect((await list(production)).ids).toEqual([]);
    expect((await list(await dev())).ids).toEqual([host.id]);
  });

  it("counts the host against the new account's 10 computers", async () => {
    const { host, user, dev } = await onDevelopment();
    const production = await session(user);
    for (let i = 0; i < MAX_HOSTS; i++) expect((await register(await newHost(), production)).status).toBe(200);
    const full = await move(host, production, await dev());
    expect(full.status).toBe(403);
    expect(await full.json()).toEqual({ error: "too_many_hosts" });
    expect((await owner(host))?.user).toBe(user);
    expect((await list(production)).ids).toHaveLength(MAX_HOSTS);
    expect((await list(await dev())).ids).toEqual([host.id]);
  });
});
