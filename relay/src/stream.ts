import { DurableObject } from "cloudflare:workers";

import { same, sha256 } from "./crypto";
import { type Env, json } from "./index";
import { logError, logEvent, logged, scrub, short } from "./log";

/** Each frame counts as at least this many bytes, since Cloudflare bills by message, not byte:
 *  a day's budget is at most 131,072 frames. */
export const MIN_FRAME_BYTES = 16 * 1024;
/** How many bytes a stream carries before it reports them to its host's object (0068, 0091). */
export const REPORT_BYTES = 8 * 1_048_576;
/** The longest a stream that stays open keeps counted bytes before it reports them, so the host's
 *  usage, which clients warn from, can't stay short by a slow stream's count (PLX-1357). */
export const REPORT_AFTER = 5 * 60_000;
/** How long a client waits for plxd to join its stream, or a spare a client took waits for that
 *  client, before the stream closes. */
export const JOIN_TIMEOUT = 30_000;

/**
 * How this object writes an alarm on a path a client waits on: a spare's claim, a join, and a
 * frame. Cloudflare holds what an object sends, a 101 and a WebSocket message included, until
 * each write before it is confirmed, and setting an alarm also waits for the alarm's scheduler,
 * behind the one a deletion left in flight (PLX-1493). These alarms only bound a wait or time a
 * report, so nothing a client gets depends on one. A write that then fails resets the object,
 * which drops both ends, and the stream ends as any whose object reset does.
 */
const UNCONFIRMED = { allowUnconfirmed: true } as const;

/** What the host's object armed this stream with. */
type Armed = { hostId: string; stream: string; tokenHash: string };

/** Any Cloudflare zone's trace, which names the data center a subrequest left from (PLX-1540). */
export const TRACE_URL = "https://cloudflare.com/cdn-cgi/trace";
/** How long a colo lookup may take before it counts as failed. */
const TRACE_TIMEOUT = 1_000;

/** The data center this code runs in, such as `LAX`, read from [`TRACE_URL`], or null when the
 *  lookup fails. Cloudflare doesn't document it, so a caller treats null as "keep what you have". */
export async function traceColo(): Promise<string | null> {
  try {
    const response = await fetch(TRACE_URL, { signal: AbortSignal.timeout(TRACE_TIMEOUT) });
    if (!response.ok) return null;
    return /^colo=([A-Z]{3})$/m.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Which end each WebSocket is, kept with it across hibernation. */
type Side = "client" | "host";

/**
 * A stream's object, or null when `stream`, which a request's path can name, can't be one. A
 * stream's id is its object's unique id, which skips the global check a new name costs. A UUID is
 * a stream from before PLX-1358, whose object has a name: its host's object may still list it
 * after a deploy. `idFromString` throws on an id that isn't this namespace's.
 */
export function streamObject(env: Env, hostId: string, stream: string) {
  if (/^[0-9a-f-]{36}$/.test(stream))
    return env.STREAMS.get(env.STREAMS.idFromName(`${hostId}/${stream}`));
  if (!/^[0-9a-f]{64}$/.test(stream)) return null;
  try {
    return env.STREAMS.get(env.STREAMS.idFromString(stream));
  } catch {
    return null;
  }
}

/** A stream's id for a log line: its end, since nothing promises a unique id's start varies. */
const tail = (id: string) => id.slice(-8);

/**
 * One client's stream to a host (0091): its own Durable Object, so a large transfer on one stream
 * doesn't queue another's frames behind it in the host's object. The host's object arms it with
 * the hash of the one-time token it sent plxd, then the Worker brings it the client's WebSocket,
 * after the host's object admitted it, and plxd's, with that token, in either order. Once both are
 * here it tells each `ready` and passes binary frames between them, unread.
 *
 * It counts each frame as at least [`MIN_FRAME_BYTES`] and reports its count to the host's object
 * every [`REPORT_BYTES`], within [`REPORT_AFTER`] of a frame, and when it closes; the host's object
 * answers whether the day's budget has room, and closes every stream's object when it doesn't. The
 * count not yet reported is kept in each WebSocket's attachment too, which survives hibernation
 * without a storage write. An idle stream reports nothing and sets no alarm.
 */
export class StreamRelay extends DurableObject<Env> {
  /** Bytes counted since the last report, read back from the WebSockets' attachments on wake. */
  private unreported?: number;
  private reported = false;
  /** Whether the alarm is known to be set for a report. Lost on hibernation, so it's then read. */
  private reportDue = false;
  /** Whether the relay has begun ending this stream, so a close from here on isn't an end's own.
   *  In memory, since an end answers a close long before the object could hibernate. */
  private ending = false;
  // One claim per uniquely armed stream. Volatile and never awaited by join; eviction loses it.
  private takenTiming?: Record<string, number>;

  private armed() {
    return this.ctx.storage.get<Armed>("armed");
  }

  private side(side: Side) {
    return this.ctx.getWebSockets(side).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** The bytes not yet reported: in memory, or after hibernation, the most any of `sockets` kept. */
  private pending(sockets = this.ctx.getWebSockets()) {
    const kept = sockets.map((ws) => (ws.deserializeAttachment() as number | null) ?? 0);
    this.unreported ??= Math.max(0, ...kept);
    return this.unreported;
  }

  /** Sets the bytes not yet reported, in memory and on each open end. */
  private keep(bytes: number) {
    this.unreported = bytes;
    for (const ws of this.ctx.getWebSockets())
      if (ws.readyState === WebSocket.OPEN) ws.serializeAttachment(bytes);
  }

  /** Which end `ws` is. */
  private sideOf(ws: WebSocket): Side {
    return this.ctx.getTags(ws).includes("client") ? "client" : "host";
  }

  /** What a log line says about this object and, when there is one, the end `ws`: which end, and
   *  its host and stream from its second tag. */
  private context(ws?: WebSocket) {
    return {
      object: "stream",
      id: tail(this.ctx.id.toString()),
      side: ws && this.sideOf(ws),
      stream: ws && this.ctx.getTags(ws).find((tag) => tag.includes("/")),
    };
  }

  /** The relay's own close of one end, with why. */
  private shut(ws: WebSocket, code: number, reason: string) {
    this.ending = true;
    logEvent("socket_closing", { ...this.context(ws), by: "relay", code, reason });
    ws.close(code, reason);
  }

  /** The data center this object runs in, which the host's object asks before it arms a spare
   *  here, to match where plxd's control socket entered (PLX-1540). Stores nothing, so an object it doesn't keep leaves nothing behind. */
  async colo() {
    return traceColo();
  }

  /** Called by the host's object before it tells plxd or a client about this stream. */
  async arm(armed: Armed) {
    this.takenTiming = undefined;
    await this.ctx.storage.put("armed", armed);
  }

  /** Whether plxd's end is here, which the host's object asks when plxd reconnects. A deploy ends
   *  this object's sockets with no close to report. */
  async hostJoined() {
    return !!this.side("host");
  }

  /** A client took this stream as the spare, and the Worker is bringing it here. If it hung up or
   *  the Worker failed, nothing else would end this stream, since plxd's end stays open. */
  async taken(deadline = Date.now() + JOIN_TIMEOUT, timed = false) {
    const start = timed ? performance.now() : 0;
    const timing: Record<string, number> | undefined = timed ? (this.takenTiming = { taken_entry: 1 }) : undefined;
    // The client may have arrived, or the stream ended, while this RPC was in flight. Read
    // durable state first, then check sockets without yielding before the alarm write. Storage
    // input gates serialize that write with join's deleteAlarm, including after hibernation.
    const armed = await this.armed();
    if (timing) timing.taken_read = performance.now() - start;
    if (!armed || this.ending || this.reported || this.ctx.getWebSockets("client").length) {
      if (timing) {
        timing.taken_outcome = 2; // Skipped: joined or ended.
        timing.taken_total = performance.now() - start;
      }
      return;
    }
    const alarmStart = timed ? performance.now() : 0;
    await this.ctx.storage.setAlarm(deadline, UNCONFIRMED);
    if (timing) {
      timing.taken_alarm = performance.now() - alarmStart;
      timing.taken_outcome = 1; // Alarm set.
      timing.taken_total = performance.now() - start;
    }
  }

  /** plxd says its end is gone, which it can know long before this object does, since a dead
   *  link's close may never arrive. The client learns now, and the stream reports and frees its
   *  place as if plxd's close had come. */
  async hostGone() {
    // Read before the ends close, in case this woke the object.
    this.pending();
    for (const ws of this.ctx.getWebSockets()) this.shut(ws, 1000, "the host's end is gone");
    await this.finish();
  }

  /** Closes both ends, as the host's object asks when its budget is spent, it's removed, or plxd
   *  reconnected without this stream. The host's object has already let the stream go, so nothing
   *  is reported. */
  async close(code: number, reason: string) {
    this.reported = true;
    for (const ws of this.ctx.getWebSockets()) this.shut(ws, code, reason);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    return logged(
      "stream.fetch",
      () => this.context(),
      () => this.join(request),
    );
  }

  /** Brings one end's WebSocket to this stream. */
  private async join(request: Request): Promise<Response> {
    const timed = new URL(request.url).pathname === "/client" && request.headers.get("x-parallax-timing") === "1";
    const start = timed ? performance.now() : 0;
    const timing: Record<string, number> = {};
    const url = new URL(request.url);
    const armed = await this.armed();
    if (timed) timing.join_read = performance.now() - start;
    if (!armed) return json(404, { error: "not_found" });
    let side: Side;
    if (url.pathname === "/client") {
      // Only the Worker reaches this, after the host's object admitted the client.
      if (this.ctx.getWebSockets("client").length) return json(409, { error: "taken" });
      side = "client";
    } else {
      // A unique id doesn't tie a stream to its host as a name did, so the path's host is checked.
      const token = url.searchParams.get("token") ?? "";
      if (
        url.searchParams.get("host") !== armed.hostId ||
        this.ctx.getWebSockets("host").length ||
        !same(await sha256(token), armed.tokenHash)
      )
        return json(404, { error: "not_found" });
      side = "host";
    }
    const [theirs, ours] = Object.values(new WebSocketPair());
    // The second tag names the stream in this socket's log lines, with no storage read to fail.
    this.ctx.acceptWebSocket(ours!, [side, `${short(armed.hostId)}/${tail(armed.stream)}`]);
    const other = this.side(side === "client" ? "host" : "client");
    if (other) {
      // Both ends are here: each learns it, plxd's side then dials its own listener.
      ours!.send("ready");
      other.send("ready");
      if (timed) timing.join_ready = performance.now() - start;
      const alarmStart = timed ? performance.now() : 0;
      await this.ctx.storage.deleteAlarm(UNCONFIRMED);
      if (timed) timing.join_delete_alarm = performance.now() - alarmStart;
    } else if (side === "client") {
      await this.ctx.storage.setAlarm(Date.now() + JOIN_TIMEOUT, UNCONFIRMED);
    }
    const headers = new Headers();
    if (timed) {
      timing.join_total = performance.now() - start;
      // Snapshot only stages already observed. Missing fields mean unavailable, never zero.
      headers.set("server-timing", Object.entries({ ...timing, ...this.takenTiming })
        .filter(([, ms]) => Number.isFinite(ms) && ms >= 0 && ms <= 60_000)
        .map(([name, ms]) => `${name};dur=${ms.toFixed(3)}`).join(", "));
    }
    return new Response(null, { status: 101, webSocket: theirs, headers });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return logged(
      "stream.webSocketMessage",
      () => this.context(ws),
      async () => {
        const peer = this.side(this.sideOf(ws) === "client" ? "host" : "client");
        // Only TLS records, and only once both ends are here.
        if (typeof message === "string" || !peer) return this.shut(ws, 4400, "bad frame");
        // Sent before any report is awaited, since another frame may be handled during the wait
        // and must not pass this one.
        peer.send(message);
        this.keep(this.pending() + Math.max(message.byteLength, MIN_FRAME_BYTES));
        if (this.pending() >= REPORT_BYTES) await this.report(false);
        else await this.reportSoon();
      },
    );
  }

  /** Sets the alarm for a report, unless one is set, so a steady trickle can't keep pushing it back. */
  private async reportSoon() {
    if (this.reportDue) return;
    this.reportDue = true;
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + REPORT_AFTER, UNCONFIRMED);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, clean: boolean) {
    const context = this.context(ws);
    const by = this.ending ? "relay" : "peer";
    logEvent("socket_closed", { ...context, by, code, reason: scrub(reason), clean });
    return logged(
      "stream.webSocketClose",
      () => context,
      () => this.ended(ws),
    );
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    const context = this.context(ws);
    logError("stream.webSocketError", context, error);
    return logged(
      "stream.webSocketError",
      () => context,
      () => this.ended(ws),
    );
  }

  /** One end is gone, so the stream is. */
  private async ended(ws: WebSocket) {
    this.ending = true;
    // Read before the ends close, in case this woke the object.
    this.pending([ws, ...this.ctx.getWebSockets()]);
    // Completes the closing handshake the other end started, and ends the other side.
    for (const other of this.ctx.getWebSockets()) {
      try {
        other.close(1000, "closed");
      } catch {
        // Already closed.
      }
    }
    await this.finish();
  }

  /** Both ends are here, so it's time to report what's counted. Otherwise plxd never joined the
   *  client's stream in time, or the client that took the spare never came. */
  async alarm() {
    return logged(
      "stream.alarm",
      () => this.context(),
      async () => {
        const host = this.side("host");
        if (host && this.side("client")) {
          this.reportDue = false;
          if (this.pending() > 0) await this.report(false);
          return;
        }
        const reason = host ? "the client didn't arrive" : "the host didn't join";
        for (const ws of this.ctx.getWebSockets()) this.shut(ws, 4408, reason);
        await this.finish();
      },
    );
  }

  /**
   * Reports the bytes counted since the last report to the host's object, and closes both ends
   * when the host's day is spent. Answers whether the stream goes on.
   */
  private async report(closed: boolean): Promise<boolean> {
    const armed = await this.armed();
    if (!armed) return false;
    const bytes = this.pending();
    if (closed) this.unreported = 0;
    else this.keep(0);
    // Nothing's left to report, so nothing needs waking until the next frame sets it again.
    this.reportDue = false;
    await this.ctx.storage.deleteAlarm();
    const host = this.env.HOSTS.get(this.env.HOSTS.idFromName(armed.hostId));
    const within = await host.report(armed.stream, bytes, closed);
    if (!within && !closed)
      for (const ws of this.ctx.getWebSockets()) this.shut(ws, 4429, "daily limit");
    return within;
  }

  /** The stream's end: its last count goes to the host's object, which frees its place, and the
   *  stream keeps nothing. */
  private async finish() {
    if (this.reported) return;
    this.reported = true;
    await this.report(true);
    await this.ctx.storage.deleteAll();
  }
}
