import { DurableObject } from "cloudflare:workers";

import {
  type HostJwk,
  isHostJwk,
  Limiter,
  randomToken,
  same,
  sha256,
  thumbprint,
  verifyEs256,
} from "./crypto";
import { type Env, json } from "./index";
import type { Notification } from "./push";

/** The user a host is registered to, and its key. */
type Owner = { user: string; hostId: string; jwk: HostJwk; name: string };

/** What each WebSocket is, kept with it across hibernation. */
type Attachment =
  /** plxd's control socket, opened with a signed proof. */
  | { role: "host" }
  /** A client's stream, waiting for plxd's side until `ready`. */
  | { role: "client"; stream: string; tokenHash: string; ready: boolean }
  /** plxd's side of a client's stream. */
  | { role: "stream"; stream: string };

/** Why the relay refused a request, with its HTTP status. */
export type Refusal = { status: number; error: string };

/** What plxd answers a webhook with. */
export type HookReply = { status: number; body: unknown };

/** How long a client's ticket works, as plxd's own WebSocket tickets (0065). */
const TICKET_LIFETIME = 30_000;
/** How long the relay waits for plxd to answer a webhook. */
const HOOK_TIMEOUT = 10_000;
/** How many clients' streams a host may have open at once. */
const MAX_STREAMS = 16;
/** How many bytes a host's streams may carry in a UTC day, both ways together. */
export const MAX_DAILY_BYTES = 2 * 1024 ** 3;
/** Each frame counts as at least this many bytes, since Cloudflare bills by message, not byte:
 *  a day's budget is at most 131,072 frames. */
export const MIN_FRAME_BYTES = 16 * 1024;
/** How often a host's byte count is saved, so a hibernated object loses at most this much. */
const SAVE_BYTES_EVERY = 8 * 1_048_576;
/** How many webhook URLs plxd may list. */
const MAX_HOOK_URLS = 1_000;
/** How long the relay waits for a webhook's body. */
const BODY_TIMEOUT = 10_000;

// T3 Connect's webhook limits (infra/relay/src/hooks).
export const MAX_HOOK_BYTES = 1_048_576;
const HOOK_LIFETIME = 24 * 60 * 60 * 1000;
const MAX_HELD = 1_000;
const MAX_HELD_BYTES = 50 * 1_048_576;
const MAX_HELD_PER_HOOK = 100;
/** A held webhook plxd couldn't take (429, 5xx, or no answer) is tried again after this,
 *  doubling per try up to [`MAX_RETRY`], as T3's inbox does. */
const FIRST_RETRY = 10_000;
const MAX_RETRY = 10 * 60_000;
/** The soonest the inbox's alarm wakes again. */
const MIN_ALARM = 1_000;

/** Per-host limits, each per minute. `hostConnect` counts only connections with a valid proof;
 *  the Worker limits anonymous attempts per address. */
export const LIMITS = {
  register: 10,
  hostConnect: 12,
  tickets: 30,
  hooks: 600,
  hookUrl: 60,
  pushes: 60,
};

/** The methods a webhook may use, as T3's. */
export const HOOK_METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);

/** A webhook's headers as plxd gets them: without hop-by-hop ones, cookies, and the proxies'. */
export function forwarded(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (DROPPED_HEADERS.has(name) || DROPPED_PREFIXES.some((p) => name.startsWith(p))) continue;
    kept[name] = value;
  }
  return kept;
}

/** Headers a webhook doesn't pass on: hop-by-hop, cookies, and the proxies' own. */
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "content-length",
  "cookie",
  "x-real-ip",
]);
const DROPPED_PREFIXES = ["cf-", "x-forwarded-", "proxy-"];

/** What plxd signs, with the time in milliseconds, to open its control socket. */
export const hostMessage = (hostId: string, at: number) => `parallax-relay-host\n${hostId}\n${at}`;

/** How old a control socket's proof may be, by the relay's clock, as 0065's `DPoP` proofs. */
const PROOF_PAST = 5 * 60_000;
/** How far ahead of the relay's clock a proof may be. Little, since the relay takes only proofs
 *  newer than the last: one far ahead would refuse plxd's next ones until its clock caught up. */
const PROOF_FUTURE = 30_000;

/** The header a `clock_skew` refusal carries the relay's time in, in milliseconds. */
export const TIME_HEADER = "x-parallax-relay-time";

/** The header plxd's proof comes in: `<milliseconds>.<signature>`. */
export const PROOF_HEADER = "x-parallax-host-proof";

/** A webhook URL's key: the SHA-256 of its raw `<hookId>/<token>`, as plxd lists it. */
export const hookKey = (hookId: string, token: string) => sha256(`${hookId}/${token}`);

/** What plxd signs to register under the user of a Clerk token with SHA-256 `tokenHash`. */
export const registerMessage = (hostId: string, tokenHash: string) =>
  `parallax-relay-register\n${hostId}\n${tokenHash}`;

/**
 * One host on the relay, named by its id: who it's registered to, plxd's live socket, its
 * clients' streams, and the webhooks held while it's away. Its WebSockets hibernate, so an idle
 * host costs nothing.
 */
export class HostRelay extends DurableObject<Env> {
  private limits = new Limiter();
  /** Unused tickets and the user each was for. */
  private tickets = new Map<string, { user: string; expires: number }>();
  /** Webhooks sent to plxd, waiting for its answer, by delivery id. */
  private waiting = new Map<string, (reply: HookReply) => void>();
  private delivering = false;
  /** Today's bytes through this host's streams, and how many of them are saved. */
  private traffic?: { day: string; bytes: number; saved: number };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // plxd's keepalive, answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The held webhooks' table, made on first use, so a host id nobody registered stores nothing. */
  private held() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS held (
      id TEXT PRIMARY KEY, received INTEGER NOT NULL, hook TEXT NOT NULL, size INTEGER NOT NULL,
      head TEXT NOT NULL, body BLOB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0)`);
    sql.exec("DELETE FROM held WHERE received < ?", Date.now() - HOOK_LIFETIME);
    return sql;
  }

  /**
   * Adds `bytes` to today's traffic and answers whether the host is still within
   * [`MAX_DAILY_BYTES`]. Saved every [`SAVE_BYTES_EVERY`] and when a stream closes.
   */
  private async count(bytes: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    if (this.traffic?.day !== day) {
      const saved = await this.ctx.storage.get<{ day: string; bytes: number }>("traffic");
      const today = saved?.day === day ? saved.bytes : 0;
      this.traffic = { day, bytes: today, saved: today };
    }
    this.traffic.bytes += bytes;
    if (this.traffic.bytes - this.traffic.saved >= SAVE_BYTES_EVERY) await this.saveTraffic();
    return this.traffic.bytes <= MAX_DAILY_BYTES;
  }

  private async saveTraffic() {
    if (!this.traffic || this.traffic.bytes === this.traffic.saved) return;
    const { day, bytes } = this.traffic;
    this.traffic.saved = bytes;
    await this.ctx.storage.put("traffic", { day, bytes });
  }

  private owner() {
    return this.ctx.storage.get<Owner>("owner");
  }

  /** plxd's control socket. */
  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets("host").find((ws) => ws.readyState === WebSocket.OPEN);
  }

  /**
   * Registers this host under `user`, whose session token hashes to `tokenHash`. `body.jwk` must
   * be the key the host id names, and `body.signature` its signature of [`registerMessage`], so
   * nobody registers a key they don't hold. A host registered to another user moves, and its
   * connections close.
   */
  async register(
    user: string,
    body: unknown,
    tokenHash: string,
  ): Promise<Refusal | { hostId: string; name: string }> {
    const { hostId, jwk, name, signature } = (body ?? {}) as Record<string, unknown>;
    if (typeof hostId !== "string" || !isHostJwk(jwk) || typeof signature !== "string")
      return { status: 400, error: "invalid_request" };
    if ((await thumbprint(jwk)) !== hostId) return { status: 400, error: "wrong_key" };
    if (!(await verifyEs256(jwk, signature, registerMessage(hostId, tokenHash))))
      return { status: 401, error: "bad_signature" };
    // Only the key's holder counts against it, so nobody else can use up its registrations.
    if (!this.limits.allow("register", LIMITS.register))
      return { status: 429, error: "rate_limited" };
    const before = await this.owner();
    if (before && before.user !== user) {
      for (const ws of this.ctx.getWebSockets()) ws.close(4409, "moved to another user");
      this.tickets.clear();
      // The host no longer counts against its old user's slots.
      await this.env.USERS.get(this.env.USERS.idFromName(before.user)).release(hostId);
    }
    const clean = typeof name === "string" ? name.replace(/\p{Cc}/gu, "").trim().slice(0, 64) : "";
    await this.ctx.storage.put<Owner>("owner", { user, hostId, jwk, name: clean });
    return { hostId, name: clean };
  }

  /**
   * Removes this host, when it is `user`'s: closes its connections and forgets its registration,
   * webhook list, held webhooks, and traffic. Its key can register again. False when it isn't
   * theirs.
   */
  async unregister(user: string): Promise<boolean> {
    const owner = await this.owner();
    if (owner?.user !== user) return false;
    for (const ws of this.ctx.getWebSockets()) ws.close(4410, "removed");
    this.tickets.clear();
    this.traffic = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return true;
  }

  /** The host as `user` sees it in their list, or null when it isn't theirs. */
  async status(user: string) {
    const owner = await this.owner();
    if (owner?.user !== user) return null;
    return { hostId: owner.hostId, name: owner.name, online: !!this.host() };
  }

  /** A ticket for one stream to this host, for its own user only. */
  async ticket(user: string): Promise<Refusal | { ticket: string }> {
    const owner = await this.owner();
    // Another user's host looks the same as no host.
    if (owner?.user !== user) return { status: 404, error: "not_found" };
    if (!this.limits.allow("tickets", LIMITS.tickets))
      return { status: 429, error: "rate_limited" };
    if (!this.host()) return { status: 503, error: "host_offline" };
    if (!(await this.count(0))) return { status: 429, error: "daily_limit" };
    const now = Date.now();
    for (const [key, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(key);
    const ticket = randomToken();
    this.tickets.set(ticket, { user, expires: now + TICKET_LIFETIME });
    return { ticket };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").slice(1);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return json(426, { error: "upgrade_required" });
    if (parts[3] === "host") return this.hostSocket(request.headers.get(PROOF_HEADER) ?? "");
    if (parts[3] === "connect") return this.clientSocket(url.searchParams.get("ticket") ?? "");
    if (parts[3] === "streams" && parts[4])
      return this.streamSocket(parts[4], url.searchParams.get("token") ?? "");
    return json(404, { error: "not_found" });
  }

  /**
   * plxd's control socket, opened with its proof: the time in milliseconds, signed with the host
   * key. The relay takes it only within [`PROOF_WINDOW`] of its own clock and newer than the last
   * one it took, so a proof works once. No socket opens without one, so strangers who know the
   * host id, which is in every webhook URL, have nothing to hold open or push out.
   */
  private async hostSocket(proof: string) {
    const owner = await this.owner();
    if (!owner) return json(404, { error: "not_registered" });
    const [at = "", signature = ""] = proof.split(".");
    const time = Number(at);
    const last = (await this.ctx.storage.get<number>("lastProof")) ?? 0;
    const signed =
      /^\d{1,15}$/.test(at) &&
      (await verifyEs256(owner.jwk, signature, hostMessage(owner.hostId, time)));
    if (!signed) return json(401, { error: "unauthorized" });
    // A signed proof at the wrong time: the relay's clock, so plxd corrects for its own and retries.
    const now = Date.now();
    if (time < now - PROOF_PAST || time > now + PROOF_FUTURE || time <= last) {
      const relayTime = Math.max(now, last + 1);
      // In a header too, which arrives with the status line however the body is split.
      return json(401, { error: "clock_skew", now: relayTime }, { [TIME_HEADER]: String(relayTime) });
    }
    if (!this.limits.allow("hostConnect", LIMITS.hostConnect))
      return json(429, { error: "rate_limited" }, { "retry-after": "60" });
    await this.ctx.storage.put("lastProof", time);
    for (const other of this.ctx.getWebSockets("host")) other.close(4409, "replaced");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, ["host"]);
    server!.serializeAttachment({ role: "host" } satisfies Attachment);
    server!.send(JSON.stringify({ t: "ready" }));
    this.ctx.waitUntil(this.deliverHeld());
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A client's stream, opened with a ticket. plxd is asked to open its side. */
  private async clientSocket(ticket: string) {
    const found = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    const owner = await this.owner();
    if (!found || found.expires < Date.now() || found.user !== owner?.user)
      return json(401, { error: "unauthorized" });
    const host = this.host();
    if (!host) return json(503, { error: "host_offline" });
    if (this.ctx.getWebSockets("client").length >= MAX_STREAMS)
      return json(429, { error: "too_many_streams" });
    const stream = crypto.randomUUID();
    const token = randomToken();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, ["client", `c:${stream}`]);
    server!.serializeAttachment({
      role: "client",
      stream,
      tokenHash: await sha256(token),
      ready: false,
    } satisfies Attachment);
    host.send(JSON.stringify({ t: "open", stream, token }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** plxd's side of a client's stream, with the one-time token the relay sent it. */
  private async streamSocket(stream: string, token: string) {
    const client = this.ctx.getWebSockets(`c:${stream}`)[0];
    const waiting = client?.deserializeAttachment() as (Attachment & { role: "client" }) | undefined;
    if (!client || !waiting || waiting.ready || !same(await sha256(token), waiting.tokenHash))
      return json(404, { error: "not_found" });
    const [ours, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, ["stream", `h:${stream}`]);
    server!.serializeAttachment({ role: "stream", stream } satisfies Attachment);
    client.serializeAttachment({ ...waiting, ready: true } satisfies Attachment);
    client.send("ready");
    return new Response(null, { status: 101, webSocket: ours });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment;
    switch (attachment.role) {
      case "host":
        return this.fromHost(message);
      case "client": {
        // Only TLS records, and only once plxd's side is there.
        if (!attachment.ready || typeof message === "string") return ws.close(4400, "bad frame");
        return this.pass(ws, `h:${attachment.stream}`, message);
      }
      case "stream": {
        if (typeof message === "string") return ws.close(4400, "bad frame");
        return this.pass(ws, `c:${attachment.stream}`, message);
      }
    }
  }

  /** Passes a stream's frame to its other side, within the host's daily bytes. */
  private async pass(from: WebSocket, to: string, message: ArrayBuffer) {
    const peer = this.ctx.getWebSockets(to)[0];
    if (await this.count(Math.max(message.byteLength, MIN_FRAME_BYTES))) return peer?.send(message);
    from.close(4429, "daily limit");
    peer?.close(4429, "daily limit");
  }

  /** A message from plxd's control socket: a webhook's answer, or a push. */
  private async fromHost(message: string | ArrayBuffer) {
    const parsed = typeof message === "string" ? parse(message) : undefined;
    if (parsed?.t === "hook" && typeof parsed.id === "string") {
      const status = typeof parsed.status === "number" ? parsed.status : 502;
      this.waiting.get(parsed.id)?.({ status, body: parsed.body ?? null });
    } else if (parsed?.t === "hooks" && Array.isArray(parsed.keys)) {
      // The webhook URLs plxd serves, by key. Any other URL is a 404 that costs nothing.
      const keys = parsed.keys
        .filter((key): key is string => typeof key === "string" && key.length === 43)
        .slice(0, MAX_HOOK_URLS)
        .sort();
      const before = (await this.ctx.storage.get<string[]>("hooks")) ?? [];
      if (keys.join() !== before.join()) await this.ctx.storage.put("hooks", keys);
    } else if (parsed?.t === "push") {
      const { run, state } = parsed;
      const valid =
        typeof run === "string" &&
        run.length <= 64 &&
        typeof state === "string" &&
        ["needsYou", "done", "failed"].includes(state);
      const owner = await this.owner();
      if (!valid || !owner || !this.limits.allow("pushes", LIMITS.pushes)) return;
      const account = this.env.USERS.get(this.env.USERS.idFromName(owner.user));
      await account.push(owner.hostId, run, state as Notification["state"]);
    }
  }

  async webSocketClose(ws: WebSocket) {
    // Completes the closing handshake the other end started.
    try {
      ws.close(1000, "closed");
    } catch {
      // Already closed.
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "client") await this.saveTraffic();
    if (attachment?.role === "client")
      this.ctx.getWebSockets(`h:${attachment.stream}`)[0]?.close(1000, "closed");
    if (attachment?.role === "stream")
      this.ctx.getWebSockets(`c:${attachment.stream}`)[0]?.close(1000, "closed");
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /**
   * Whether a webhook to `<hookId>/<token>` may go on to [`hook`], before the Worker reads its
   * body. Only URLs plxd listed may: any other is a 404 that neither counts against a budget nor
   * is held. Then one budget per URL, and one for the host.
   */
  async admitHook(hookId: string, token: string): Promise<Refusal | null> {
    const key = await hookKey(hookId, token);
    const listed = (await this.ctx.storage.get<string[]>("hooks")) ?? [];
    if (!hookId || !token || !listed.includes(key)) return { status: 404, error: "hook_not_found" };
    const allowed =
      this.limits.allow(`hook:${key}`, LIMITS.hookUrl) && this.limits.allow("hooks", LIMITS.hooks);
    return allowed ? null : { status: 429, error: "rate_limited" };
  }

  /**
   * An admitted webhook, as the Worker read it: sent to plxd with its raw body and headers, so
   * plxd checks its token and signature itself, or held while plxd is away. Answers what the
   * sender gets.
   */
  async hook(
    hookId: string,
    request: { method: string; path: string; headers: Record<string, string> },
    body: Uint8Array,
  ): Promise<HookReply> {
    const head = { id: crypto.randomUUID(), ...request };
    const online = !!this.host();
    const reply = await this.send(head, body);
    if (reply) return reply;
    // plxd didn't answer in time: tried again soon, while it stays connected.
    return this.hold(hookId, head, body, online ? Date.now() + FIRST_RETRY : 0);
  }

  /** Sends a webhook to plxd and waits for its answer. Null when plxd is away or too slow. */
  private send(head: { id: string }, body: Uint8Array): Promise<HookReply | null> {
    const host = this.host();
    if (!host) return Promise.resolve(null);
    // A binary frame: the head's JSON length (u32, big-endian), the head, then the raw body.
    const encoded = new TextEncoder().encode(JSON.stringify({ t: "hook", ...head }));
    const frame = new Uint8Array(4 + encoded.byteLength + body.byteLength);
    new DataView(frame.buffer).setUint32(0, encoded.byteLength);
    frame.set(encoded, 4);
    frame.set(body, 4 + encoded.byteLength);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), HOOK_TIMEOUT);
      const done = (reply: HookReply | null) => {
        clearTimeout(timer);
        this.waiting.delete(head.id);
        resolve(reply);
      };
      this.waiting.set(head.id, done);
      try {
        host.send(frame);
      } catch {
        done(null);
      }
    });
  }

  /** Keeps a webhook for plxd's return, within T3's limits, first tried at `retryAt` if set. */
  private async hold(
    hookId: string,
    head: { id: string },
    body: Uint8Array,
    retryAt: number,
  ): Promise<HookReply> {
    const sql = this.held();
    const totals = sql
      .exec<{ count: number; bytes: number | null }>(
        "SELECT count(*) AS count, sum(size) AS bytes FROM held",
      )
      .one();
    const perHook = sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM held WHERE hook = ?", hookId)
      .one().count;
    const full =
      totals.count >= MAX_HELD ||
      (totals.bytes ?? 0) + body.byteLength > MAX_HELD_BYTES ||
      perHook >= MAX_HELD_PER_HOOK;
    if (full) return { status: 503, body: { error: "inbox_full" } };
    sql.exec(
      "INSERT INTO held (id, received, hook, size, head, body, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      head.id,
      Date.now(),
      hookId,
      body.byteLength,
      JSON.stringify(head),
      body,
      retryAt,
    );
    await this.schedule();
    return { status: 202, body: { queued: true } };
  }

  /**
   * Sends the held webhooks that are due to plxd, oldest first. One plxd took (2xx, or a 4xx
   * other than 429) is deleted. One it couldn't take (429, 5xx, or no answer in time) is tried
   * again with backoff, and holds back the rest of its hook so they keep their order. Its
   * delivery id keeps a retry from firing twice.
   */
  private async deliverHeld() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const sql = this.held();
      const rows = sql
        .exec<{ id: string; hook: string; retry_at: number }>(
          "SELECT id, hook, retry_at FROM held ORDER BY received",
        )
        .toArray();
      const blocked = new Set<string>();
      for (const { id, hook, retry_at } of rows) {
        if (blocked.has(hook)) continue;
        if (retry_at > Date.now()) {
          blocked.add(hook);
          continue;
        }
        const row = sql
          .exec<{ head: string; body: ArrayBuffer; attempts: number }>(
            "SELECT head, body, attempts FROM held WHERE id = ?",
            id,
          )
          .toArray()[0];
        if (!row) continue;
        const reply = await this.send(JSON.parse(row.head), new Uint8Array(row.body));
        if (reply && reply.status !== 429 && reply.status < 500) {
          sql.exec("DELETE FROM held WHERE id = ?", id);
          continue;
        }
        // plxd left: the rest wait for it to reconnect.
        if (!reply && !this.host()) break;
        blocked.add(hook);
        const attempts = row.attempts + 1;
        const wait = Math.min(FIRST_RETRY * 2 ** (attempts - 1), MAX_RETRY);
        sql.exec(
          "UPDATE held SET attempts = ?, retry_at = ? WHERE id = ?",
          attempts,
          Date.now() + wait,
          id,
        );
      }
    } finally {
      this.delivering = false;
      await this.schedule();
    }
  }

  /**
   * Wakes at the next retry while plxd is connected, else when the oldest webhook expires. Only
   * each hook's oldest webhook can be retried, since the rest wait behind it, so only those set
   * the retry, and never sooner than [`MIN_ALARM`] from now: each wake is a billed request.
   */
  private async schedule() {
    const next = this.held()
      .exec<{ oldest: number | null; retry: number | null }>(
        `SELECT min(received) AS oldest,
           (SELECT min(retry_at) FROM held AS first WHERE received =
             (SELECT min(received) FROM held AS same WHERE same.hook = first.hook)) AS retry
         FROM held`,
      )
      .one();
    if (next.oldest === null) return this.ctx.storage.deleteAlarm();
    let at = next.oldest + HOOK_LIFETIME;
    if (next.retry !== null && this.host()) at = Math.min(at, next.retry);
    await this.ctx.storage.setAlarm(Math.max(at, Date.now() + MIN_ALARM));
  }

  /** Drops held webhooks older than 24 hours, and retries the due ones while plxd is here. */
  async alarm() {
    if (this.host()) await this.deliverHeld();
    else await this.schedule();
  }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The request's body, null past [`MAX_HOOK_BYTES`], or "slow" when it takes over
 * [`BODY_TIMEOUT`]. Stops reading either way.
 */
export async function readCapped(request: Request): Promise<Uint8Array | null | "slow"> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_HOOK_BYTES) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  let timer = 0;
  const late = new Promise<"slow">((resolve) => {
    timer = setTimeout(() => resolve("slow"), BODY_TIMEOUT) as unknown as number;
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HOOK_BYTES) return null;
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  };
  const body = await Promise.race([read(), late]);
  clearTimeout(timer);
  if (!(body instanceof Uint8Array)) await reader.cancel().catch(() => {});
  return body;
}
