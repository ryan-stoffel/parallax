/**
 * Parallax Relay (PLX-652, decision 0068): reaches a user's plxd from anywhere, forwards its
 * webhooks, and carries its push notifications.
 *
 * - plxd registers its host key under a Clerk user (`POST /v1/hosts`), then keeps one WebSocket
 *   open to the host's Durable Object (`/v1/hosts/<id>/host`), opened with the time signed by
 *   that key.
 * - A client signed in as the same user opens `/v1/hosts/<id>/connect` with its Clerk token in the
 *   `Authorization` header (0091). plxd joins it at `/v1/hosts/<id>/streams/<stream>`, or already
 *   waits there on its spare stream, and the stream's own Durable Object ([`StreamRelay`]) passes
 *   binary frames between the two. The client runs TLS to plxd's pinned certificate inside them
 *   (0065), so the relay carries only ciphertext. Clients from before 0091 get a ticket first
 *   (`POST /v1/hosts/<id>/tickets`) and open `/connect?ticket=<ticket>`. plxd's connection check
 *   gets a ticket to itself over its WebSocket and opens the same URL (PLX-1356).
 * - A plxd reaches another of its user's plxds, with no token, on the same two routes a client
 *   uses to find and open one: `GET /v1/hosts` and `/v1/hosts/<id>/connect` take a proof signed by
 *   its host key in `x-parallax-peer` instead (0101). Both hosts must have one owner.
 * - `/v1/hooks/<id>/<hookId>/<token>` goes to plxd over its WebSocket, or is held while it's away.
 * - A plxd's statement that a device is removed goes, unread and unkept, to its user's other online
 *   plxds over their WebSockets, and they check its signature (0091).
 * - A user removes a host of theirs with `DELETE /v1/hosts/<id>`, which frees its slot and lists it
 *   as `removed` in `GET /v1/hosts` until it registers under them again (PLX-1351).
 * - Mobile devices register for push at `/v1/devices`.
 *
 * Every route but the WebSockets plxd opens, the webhooks, and a plxd's proof above needs a Clerk
 * session token.
 */
import { allowedUser, verifySession } from "./clerk";
import { connectCode } from "./connect-code";
import { sha256 } from "./crypto";
import {
  forwarded,
  HOOK_METHODS,
  type HookReply,
  HostRelay,
  PEER_HEADER,
  readCapped,
  TIME_HEADER,
} from "./host";
import { logged, scrub, short } from "./log";
import { streamObject, StreamRelay } from "./stream";
import { UserAccount } from "./user";

export { HostRelay, StreamRelay, UserAccount };

export interface Env {
  HOSTS: DurableObjectNamespace<HostRelay>;
  STREAMS: DurableObjectNamespace<StreamRelay>;
  USERS: DurableObjectNamespace<UserAccount>;
  /** Anonymous requests (webhooks and the WebSockets that prove themselves) per address and
   *  host, before they reach a host's object. */
  ANON: RateLimit;
  /** The Clerk instances' issuers, comma-separated: a token's `iss` must be one of them. Two
   *  while accounts move from one instance to another (PLX-1049). Unset, the relay refuses every
   *  token. */
  CLERK_ISSUER?: string;
  /** Where each of those instances publishes its JWKS, comma-separated in the same order. Unset,
   *  each issuer's `/.well-known/jwks.json`. */
  CLERK_JWKS_URL?: string;
  /** The JWKS itself, as JSON, in place of fetching it, for every issuer. Tests and local runs. */
  CLERK_JWKS?: string;
  /** The OAuth applications whose access tokens count, by client id: the desktop app's (0067).
   *  One entry per issuer, comma-separated in `CLERK_ISSUER`'s order, so a token counts only with
   *  its own instance's applications. Several for one instance are separated by spaces. */
  CLERK_CLIENT_IDS?: string;
  /** The origins a browser session token's `azp` may name, comma-separated. Unset accepts no
   *  browser. Native apps' tokens carry no `azp`. */
  CLERK_AUTHORIZED_PARTIES?: string;
  /** Set to anything, the relay serves only the Clerk user ids in `ALLOWED_USERS`, and every other
   *  signed-in request gets 403 `user_not_allowed` before any object runs. Unset, as on
   *  production, it serves everyone and ignores `ALLOWED_USERS`. Staging's var (PLX-1495). */
  REQUIRE_ALLOWED_USERS?: string;
  /** Those user ids, comma-separated. Missing or empty lists nobody. Staging's secret. */
  ALLOWED_USERS?: string;
  /** How many stream objects a spare may try, so it runs in the data center plxd's control
   *  socket entered (PLX-1540): a number from 1 to 3, where 1 only looks up and logs where the first one ran.
   *  Unset or 0, the relay never looks. Staging's var. */
  SPARE_PLACEMENT_TRIES?: string;
  /** The APNs auth key (.p8, PEM), its key id, and the Apple team id, as secrets. Unset, pushes
   *  only log. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
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

/** What a request past a per-minute limit gets. */
const limited = () => json(429, { error: "rate_limited" }, { "retry-after": "60" });

/**
 * The user of the plxd whose proof this request carries for `route` (0101), or the answer refusing
 * it. Anonymous until its object checks it, so it counts per address and caller first.
 */
async function peerUser(env: Env, request: Request, route: string): Promise<string | Response> {
  const [caller = "", at = "", signature = ""] = (request.headers.get(PEER_HEADER) ?? "").split(".");
  if (!HOST_ID.test(caller)) return json(401, { error: "unauthorized" });
  const address = network(request.headers.get("cf-connecting-ip") ?? "");
  if (!(await env.ANON.limit({ key: `${address}:${caller}` })).success) return limited();
  const proven = await env.HOSTS.get(env.HOSTS.idFromName(caller)).provePeer(route, at, signature);
  if ("user" in proven) return proven.user;
  const { status, error, now } = proven;
  return now === undefined
    ? json(status, { error })
    : json(status, { error, now }, { [TIME_HEADER]: String(now) });
}

/** The hosts of `user`, as their list shows them. */
async function listHosts(env: Env, user: string) {
  const account = env.USERS.get(env.USERS.idFromName(user));
  const ids = await account.hosts();
  const hosts = await Promise.all(
    ids.map((hostId) => env.HOSTS.get(env.HOSTS.idFromName(hostId)).status(user)),
  );
  return json(200, { hosts: hosts.filter(Boolean), removed: await account.removed() });
}

/**
 * A WebSocket to host `hostId`: plxd's control socket goes to the host's object; a client's
 * stream, once the host's object admits it, and plxd's side of a stream, to that stream's object.
 * A client's Clerk token is read only from the `Authorization` header, never the URL. Another
 * plxd's proof stands in for it, and `HostRelay.open` still requires the same owner (0101).
 *
 * `limit` is the anonymous limit's answer, already asked for. Nothing here reaches an object
 * before it allows the request. A client's token is checked while it answers, since neither needs
 * the other (PLX-1493).
 */
async function relayed(
  env: Env,
  request: Request,
  hostId: string,
  action: string,
  stream: string,
  limit: Promise<RateLimitOutcome>,
) {
  const start = performance.now();
  const host = env.HOSTS.get(env.HOSTS.idFromName(hostId));
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const ticket = new URL(request.url).searchParams.get("ticket");
  const byToken = action === "connect" && upgrade && ticket === null && !request.headers.has(PEER_HEADER);
  if (!byToken) {
    if (!(await limit).success) return limited();
    if (action === "host") return host.fetch(request);
    if (!upgrade) return json(426, { error: "upgrade_required" });
  }
  if (action === "streams") {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const object = streamObject(env, hostId, stream);
    if (!object) return json(404, { error: "not_found" });
    const url = `https://stream/host?host=${hostId}&token=${encodeURIComponent(token)}`;
    return object.fetch(url, { headers: { upgrade: "websocket" } });
  }
  // Only a successful authenticated client open exposes numeric durations, never logs or IDs.
  const timed = request.headers.get("x-parallax-timing") === "1";
  const times: string[] = [];
  const since = (from: number) => `dur=${(performance.now() - from).toFixed(3)}`;
  const record = (name: string, from: number) => times.push(`${name};${since(from)}`);
  // Stages that overlap others, by name. They go after the older fields, which a plxd from before
  // PLX-1493 reads the first 16 of.
  const beside: Record<string, string> = {};
  let hop: Promise<void> | undefined;
  let opened: Awaited<ReturnType<HostRelay["open"]>>;
  if (ticket !== null) {
    opened = await host.redeem(ticket);
  } else if (request.headers.has(PEER_HEADER)) {
    const user = await peerUser(env, request, `connect/${hostId}`);
    if (user instanceof Response) return user;
    opened = await host.open(user);
  } else {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    // Clerk being down refuses this stream as a bad sign-in does. The account's list tells them apart.
    const checked = token
      ? verifySession(env, token, (ms) => (beside.jwks = `dur=${ms.toFixed(3)}`)).catch(() => null)
      : Promise.resolve(null);
    const [allowed, user] = await Promise.all([
      limit.then((outcome) => {
        beside.limit = since(start);
        return outcome.success;
      }),
      checked.then((user) => {
        if (timed) record("auth", start);
        return user;
      }),
    ]);
    // The limit's refusal comes first, as when it was asked first.
    if (!allowed) return limited();
    if (!user) return json(401, { error: "unauthorized" });
    if (!allowedUser(env, user)) return json(403, { error: "user_not_allowed" });
    const openStart = performance.now();
    opened = await host.open(user, timed);
    if (timed) record("host_open", openStart);
    // The trip to the host's object and back with nothing to do there, made beside the stream's
    // join. What `host_open` takes over this is the object's own work, with the confirmation of
    // the claim's write, which its answer waits for. The object's own timers can't show that,
    // since Cloudflare's advance only after I/O.
    if (timed && !("error" in opened)) {
      const hopStart = performance.now();
      hop = host.hop().then(
        () => void (beside.host_hop = since(hopStart)),
        () => {},
      );
    }
  }
  if ("error" in opened) return json(opened.status, { error: opened.error });
  const object = streamObject(env, hostId, opened.stream);
  if (!object) return json(404, { error: "not_found" });
  const joinStart = performance.now();
  const response = await object.fetch("https://stream/client", { headers: { upgrade: "websocket", ...(timed ? { "x-parallax-timing": "1" } : {}) } });
  if (!timed || response.status !== 101) return response;
  record("stream_join", joinStart);
  if (opened.timing) {
    times.push(`admit;dur=${opened.timing.admitMs.toFixed(3)}`, `take;dur=${opened.timing.takeMs.toFixed(3)}`, `spare;dur=${opened.timing.spare ? 1 : 0}`);
  }
  const headers = new Headers(response.headers);
  const local = response.headers.get("server-timing");
  if (local) times.push(local);
  await hop;
  for (const name of ["limit", "jwks", "host_hop"]) if (beside[name]) times.push(`${name};${beside[name]}`);
  record("worker", start);
  headers.set("server-timing", times.join(", "));
  return new Response(null, { status: 101, webSocket: response.webSocket, headers });
}

const routes = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const parts = new URL(request.url).pathname.split("/").slice(1);
    const [version, kind, id = "", action] = parts;
    if (parts.length === 2 && version === "connect" && kind === "code") return connectCode(request);
    if (version !== "v1") return json(404, { error: "not_found" });
    const host = (hostId: string) => env.HOSTS.get(env.HOSTS.idFromName(hostId));

    // The routes plxd and webhook senders reach, which prove themselves to the host's object.
    const open = kind === "hooks" || (kind === "hosts" && ["host", "connect", "streams"].includes(action!));
    if (open) {
      if (!HOST_ID.test(id)) return json(404, { error: "not_found" });
      const address = network(request.headers.get("cf-connecting-ip") ?? "");
      const limit = env.ANON.limit({ key: `${address}:${id}` });
      if (kind !== "hooks") return relayed(env, request, id, action!, parts[4] ?? "", limit);
      if (!(await limit).success) return limited();
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

    if (request.method === "GET" && kind === "hosts" && !id && request.headers.has(PEER_HEADER)) {
      const user = await peerUser(env, request, "hosts");
      if (user instanceof Response) return user;
      if (!(await env.USERS.get(env.USERS.idFromName(user)).allow()))
        return json(429, { error: "rate_limited" }, { "retry-after": "60" });
      return listHosts(env, user);
    }

    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    let user: string | null;
    try {
      user = token ? await verifySession(env, token) : null;
    } catch {
      return json(503, { error: "clerk_unreachable" }, { "retry-after": "60" });
    }
    if (!token || !user) return json(401, { error: "unauthorized" });
    if (!allowedUser(env, user)) return json(403, { error: "user_not_allowed" });
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
        await account.joined(hostId);
        return json(200, result);
      }
      case "GET /hosts":
        return listHosts(env, user);
      case "DELETE /hosts/:id": {
        if (!HOST_ID.test(id)) return json(404, { error: "not_found" });
        const removed = await host(id).unregister(user);
        // Its slot is free either way: a host that's gone, or moved to another user, isn't theirs.
        // It's marked either way too, so a Remove after the relay lost its data still holds.
        await account.left(id);
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
};

export default {
  // A Durable Object's reset reaches its callers as an exception, so it's logged here too. Only
  // the route's kind and a host id: a webhook's path holds its token.
  fetch(request, env) {
    return logged(
      "worker.fetch",
      () => {
        const [, kind = "", id = ""] = new URL(request.url).pathname.split("/").slice(1);
        return { kind: scrub(kind), host: HOST_ID.test(id) ? short(id) : undefined };
      },
      () => routes.fetch(request, env),
    );
  },
} satisfies ExportedHandler<Env>;
