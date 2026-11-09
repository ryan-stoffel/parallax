import { describe, expect, it } from "vitest";

import { DEVELOPMENT } from "../src/clerk";
import worker, { type Env } from "../src/index";
import { BASE, newHost, session, testEnv } from "./helpers";

/** A namespace whose objects fail the test when anything calls them. */
function untouched<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>) {
  const stub = new Proxy({}, { get: (_, method) => () => Promise.reject(new Error(`an object ran: ${String(method)}`)) });
  return { idFromName: (name: string) => namespace.idFromName(name), get: () => stub } as unknown as DurableObjectNamespace<T>;
}

/** The relay as staging runs it: only `allowed` may sign in, and a refusal may not reach an object. */
const staging = (allowed?: string): Env => ({ ...testEnv, REQUIRE_ALLOWED_USERS: "1", ALLOWED_USERS: allowed });
const sealed = (allowed?: string): Env => ({
  ...staging(allowed),
  HOSTS: untouched(testEnv.HOSTS),
  STREAMS: untouched(testEnv.STREAMS),
  USERS: untouched(testEnv.USERS),
});

function send(env: Env, path: string, token?: string, init: { method?: string; body?: string; upgrade?: string } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.upgrade) headers.set("upgrade", init.upgrade);
  return worker.fetch(new Request(`${BASE}${path}`, { method: init.method, body: init.body, headers }), env);
}

describe("the allowlist (PLX-1495)", () => {
  it("not required, serves every signed-in user, as production does", async () => {
    expect(testEnv.REQUIRE_ALLOWED_USERS).toBeUndefined();
    expect((await send(testEnv, "/v1/hosts", await session("user_anyone"))).status).toBe(200);
  });

  it("not required, ignores a list that landed there by mistake", async () => {
    const env: Env = { ...testEnv, ALLOWED_USERS: "user_probe" };
    expect((await send(env, "/v1/hosts", await session("user_anyone"))).status).toBe(200);
  });

  it("required, serves a listed user from either Clerk instance", async () => {
    const env = staging("user_other, user_probe");
    expect((await send(env, "/v1/hosts", await session("user_probe"))).status).toBe(200);
    expect((await send(env, "/v1/hosts", await session("user_probe", { iss: DEVELOPMENT }))).status).toBe(200);
  });

  it("required, refuses any other user with 403 before any object runs", async () => {
    const env = sealed("user_probe");
    const token = await session("user_ryan");
    const host = await newHost();
    const refusals = [
      await send(env, "/v1/hosts", token),
      await send(env, "/v1/hosts", token, { method: "POST", body: JSON.stringify({ hostId: host.id }) }),
      await send(env, `/v1/hosts/${host.id}/tickets`, token, { method: "POST" }),
      await send(env, `/v1/hosts/${host.id}/connect`, token, { upgrade: "websocket" }),
      await send(env, "/v1/devices", token, { method: "POST", body: JSON.stringify({ token: "a".repeat(64) }) }),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(403);
      expect(await refusal.json()).toEqual({ error: "user_not_allowed" });
    }
  });

  it("required, still answers 401 to a request that isn't signed in", async () => {
    const env = sealed("user_probe");
    expect((await send(env, "/v1/hosts")).status).toBe(401);
    expect((await send(env, "/v1/hosts", "not-a-jwt")).status).toBe(401);
  });

  it("required with a missing or empty list, refuses everyone", async () => {
    for (const list of [undefined, "", " , "]) {
      expect((await send(sealed(list), "/v1/hosts", await session("user_probe"))).status).toBe(403);
    }
  });
});
