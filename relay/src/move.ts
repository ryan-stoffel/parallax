import { KeysUnavailable } from "@parallax/clerk-verify";

import { allowedUser, verifySession } from "./clerk";
import { isHostJwk, sha256, thumbprint, verifyEs256 } from "./crypto";
import { registerMessage } from "./host";
import { type Env, json } from "./index";

/**
 * `POST /v1/hosts/<id>/move` (PLX-1465): moves host `id` from the account it's on to `user`, the
 * account of `token`, which the Worker already checked. An account moving from Clerk's development
 * instance to production proves both: `from` in the body is a token for the account that owns the
 * host now, and the host key signs `token`'s hash as for a registration, so only that computer's
 * plxd asks. The host id, connections, held webhooks, and counters stay. `user`'s 10-computer cap
 * counts it, and the old account's slot is freed without marking it removed. A repeated move answers
 * 200, as the first did.
 */
export async function moveHost(env: Env, request: Request, id: string, user: string, token: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const { hostId, jwk, name, signature, from } = body ?? {};
  if (hostId !== id || !isHostJwk(jwk) || typeof signature !== "string" || typeof from !== "string")
    return json(400, { error: "invalid_request" });
  if ((await thumbprint(jwk)) !== id) return json(400, { error: "wrong_key" });
  if (!(await verifyEs256(jwk, signature, registerMessage(id, await sha256(token)))))
    return json(401, { error: "bad_signature" });
  let owner: string | null;
  try {
    owner = await verifySession(env, from);
  } catch (error) {
    if (error instanceof KeysUnavailable) return json(503, { error: "clerk_unreachable" }, { "retry-after": "60" });
    throw error;
  }
  if (!owner || !allowedUser(env, owner)) return json(401, { error: "unauthorized" });
  const account = env.USERS.get(env.USERS.idFromName(user));
  const slot = await account.reserve(id);
  if (slot === "full") return json(403, { error: "too_many_hosts" });
  const host = env.HOSTS.get(env.HOSTS.idFromName(id));
  let result: Awaited<ReturnType<typeof host.move>> | undefined;
  try {
    result = await host.move(owner, user, id, jwk, typeof name === "string" ? name : "");
  } finally {
    if (slot === "reserved" && (!result || "error" in result)) await account.release(id);
  }
  if ("error" in result) return json(result.status, { error: result.error });
  await account.joined(id);
  if (owner !== user) await env.USERS.get(env.USERS.idFromName(owner)).release(id);
  return json(200, result);
}
