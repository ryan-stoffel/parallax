/**
 * Parallax Relay (PLX-652, decision 0068): reaches a user's plxd from anywhere, forwards its
 * webhooks, and carries its push notifications.
 *
 * - plxd registers its host key under a Clerk user (`POST /v1/hosts`), then keeps one WebSocket
 *   open to the host's Durable Object (`/v1/hosts/<id>/host`), opened with the time signed by
 *   that key.
 * - A client signed in as the same user gets a ticket (`POST /v1/hosts/<id>/tickets`) and opens
 *   `/v1/hosts/<id>/connect` with it. plxd opens a matching `/v1/hosts/<id>/streams/<stream>`,
 *   and the relay passes binary frames between the two. The client runs TLS to plxd's pinned
 *   certificate inside them (0065), so the relay carries only ciphertext.
 * - `/v1/hooks/<id>/<hookId>/<token>` goes to plxd over its WebSocket, or is held while it's away.
 * - A user removes a host of theirs with `DELETE /v1/hosts/<id>`, which frees its slot.
 * - Mobile devices register for push at `/v1/devices`.
 *
 * Every route but the WebSockets plxd opens and the webhooks needs a Clerk session token.
 */
import { verifySession } from "./clerk";
import { sha256 } from "./crypto";
import { forwarded, HOOK_METHODS, type HookReply, HostRelay, readCapped } from "./host";
import { UserAccount } from "./user";

export { HostRelay, UserAccount };

export interface Env {
  HOSTS: DurableObjectNamespace<HostRelay>;
  USERS: DurableObjectNamespace<UserAccount>;
  /** Anonymous requests (webhooks and the WebSockets that prove themselves) per address and
   *  host, before they reach a host's object. */
  ANON: RateLimit;
  /** The Clerk instance's issuer, the `iss` every session token must have. Unset, the relay
   *  refuses every token: only `[env.dev]` sets the development instance. */
  CLERK_ISSUER?: string;
  /** Where the Clerk instance publishes its JWKS. Unset, the issuer's `/.well-known/jwks.json`. */
  CLERK_JWKS_URL?: string;
  /** The JWKS itself, as JSON, in place of fetching it. Tests and local runs. */
  CLERK_JWKS?: string;
  /** The OAuth applications whose access tokens count, by client id, comma-separated: the
   *  desktop app's (0067). */
  CLERK_CLIENT_IDS?: string;
  /** The origins a browser session token's `azp` may name, comma-separated. Unset accepts no
   *  browser. Native apps' tokens carry no `azp`. */
  CLERK_AUTHORIZED_PARTIES?: string;
}

/** A host's id: its key's JWK thumbprint, 32 bytes in base64url. */
const HOST_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * An address as the anonymous limit counts it: an IPv4 address, or an IPv6 address's /64, since
 * one host commonly holds a whole /64.
 */
export function network(address: string): string {
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, "").toLowerCase())
    .join(":");
}

export function json(status: number, body: unknown, headers?: Record<string, string>) {
  return Response.json(body, { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const parts = new URL(request.url).pathname.split("/").slice(1);
    const [version, kind, id = "", action] = parts;
    if (version !== "v1") return json(404, { error: "not_found" });
    const host = (hostId: string) => env.HOSTS.get(env.HOSTS.idFromName(hostId));

    // The routes plxd and webhook senders reach, which prove themselves to the host's object.
    const open = kind === "hooks" || (kind === "hosts" && ["host", "connect", "streams"].includes(action!));
    if (open) {
      if (!HOST_ID.test(id)) return json(404, { error: "not_found" });
      const address = network(request.headers.get("cf-connecting-ip") ?? "");
      if (!(await env.ANON.limit({ key: `${address}:${id}` })).success)
        return json(429, { error: "rate_limited" }, { "retry-after": "60" });
      if (kind !== "hooks") return host(id).fetch(request);
      // A webhook's body is read here, after the host's object admits it, and never streamed
      // to the object, which can't answer before reading a stream without breaking.
      if (!HOOK_METHODS.has(request.method))
        return json(405, { error: "method_not_allowed" }, { allow: "GET, POST, PUT, PATCH" });
      const [hookId = "", token = ""] = parts.slice(3);
      const refused = await host(id).admitHook(hookId, token);
      if (refused)
        return json(refused.status, { error: refused.error }, { "retry-after": "60" });
      const body = await readCapped(request);
      if (body === "slow") return json(408, { error: "request_timeout" });
      if (!body) return json(413, { error: "payload_too_large" });
      const path = `/api/hooks/${hookId}/${token}${new URL(request.url).search}`;
      const request_ = { method: request.method, path, headers: forwarded(request.headers) };
      // RPC's types can't carry `unknown`, which plxd's JSON answer is.
      const answer = (await host(id).hook(hookId, request_, body)) as HookReply;
      return json(answer.status, answer.body);
    }

    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    const user = token ? await verifySession(env, token) : null;
    if (!token || !user) return json(401, { error: "unauthorized" });
    const account = env.USERS.get(env.USERS.idFromName(user));
    if (!(await account.allow()))
      return json(429, { error: "rate_limited" }, { "retry-after": "60" });

    const route = `${request.method} /${kind}${parts.length > 2 ? "/:id" : ""}${action ? `/${action}` : ""}`;
    switch (route) {
      case "POST /hosts": {
        const body = (await request.json().catch(() => null)) as { hostId?: unknown } | null;
        const hostId = typeof body?.hostId === "string" ? body.hostId : "";
        if (!HOST_ID.test(hostId)) return json(400, { error: "invalid_request" });
        // The slot is checked for and taken in one call, so parallel registrations can't overrun it.
        const slot = await account.reserve(hostId);
        if (slot === "full") return json(403, { error: "too_many_hosts" });
        let result: Awaited<ReturnType<HostRelay["register"]>> | undefined;
        try {
          result = await host(hostId).register(user, body, await sha256(token));
        } finally {
          // A refused or failed registration gives back the slot it reserved.
          if (slot === "reserved" && (!result || "error" in result)) await account.release(hostId);
        }
        if ("error" in result) return json(result.status, { error: result.error });
        return json(200, result);
      }
      case "GET /hosts": {
        const ids = await account.hosts();
        const hosts = await Promise.all(ids.map((hostId) => host(hostId).status(user)));
        return json(200, { hosts: hosts.filter(Boolean) });
      }
      case "DELETE /hosts/:id": {
        if (!HOST_ID.test(id)) return json(404, { error: "not_found" });
        const removed = await host(id).unregister(user);
        // Its slot is free either way: a host that's gone, or moved to another user, isn't theirs.
        await account.release(id);
        return removed ? json(200, { ok: true }) : json(404, { error: "not_found" });
      }
      case "POST /hosts/:id/tickets": {
        if (!HOST_ID.test(id)) return json(404, { error: "not_found" });
        const result = await host(id).ticket(user);
        if ("error" in result) return json(result.status, { error: result.error });
        return json(200, result);
      }
      case "POST /devices": {
        const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
        const added = typeof body?.token === "string" && (await account.addDevice(body.token));
        return added ? json(200, { ok: true }) : json(400, { error: "invalid_request" });
      }
      case "DELETE /devices/:id":
        await account.removeDevice(id);
        return json(200, { ok: true });
      default:
        return json(404, { error: "not_found" });
    }
  },
} satisfies ExportedHandler<Env>;
