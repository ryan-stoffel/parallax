import { DurableObject } from "cloudflare:workers";

import { same, sha256 } from "./crypto";
import { type Env, json } from "./index";
import { logError, logEvent, logged, scrub, short } from "./log";

/** Each frame counts as at least this many bytes, since Cloudflare bills by message, not byte:
 *  a day's budget is at most 131,072 frames. */
export const MIN_FRAME_BYTES = 16 * 1024;
/** How many bytes a stream carries before it reports them to its host's object (0068, 0091). */
export const REPORT_BYTES = 8 * 1_048_576;
/** How long a client waits for plxd to join its stream before the stream closes. */
export const JOIN_TIMEOUT = 30_000;

/** What the host's object armed this stream with. */
type Armed = { hostId: string; stream: string; tokenHash: string };

/** Which end each WebSocket is, kept with it across hibernation. */
type Side = "client" | "host";

/**
 * One client's stream to a host (0091): its own Durable Object, so a large transfer on one stream
 * doesn't queue another's frames behind it in the host's object. The host's object arms it with
 * the hash of the one-time token it sent plxd, then the Worker brings it the client's WebSocket,
 * after the host's object admitted it, and plxd's, with that token, in either order. Once both are
 * here it tells each `ready` and passes binary frames between them, unread.
 *
 * It counts each frame as at least [`MIN_FRAME_BYTES`] and reports its count to the host's object
 * every [`REPORT_BYTES`] and when it closes; the host's object answers whether the day's budget
 * has room, and closes every stream's object when it doesn't. The count not yet reported is kept
 * in each WebSocket's attachment too, which survives hibernation without a storage write.
 */
export class StreamRelay extends DurableObject<Env> {
  /** Bytes counted since the last report, read back from the WebSockets' attachments on wake. */
  private unreported?: number;
  private reported = false;
  /** Whether the relay has begun ending this stream, so a close from here on isn't an end's own.
   *  In memory, since an end answers a close long before the object could hibernate. */
  private ending = false;

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
      id: short(this.ctx.id.toString()),
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

  /** Called by the host's object before it tells plxd or a client about this stream. */
  async arm(armed: Armed) {
    await this.ctx.storage.put("armed", armed);
  }

  /** Closes both ends, as the host's object asks when its budget is spent, it's removed, or plxd
   *  reconnected. The host's object has already let the stream go, so nothing is reported. */
  async close(code: number, reason: string) {
    this.reported = true;
    for (const ws of this.ctx.getWebSockets()) this.shut(ws, code, reason);
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
    const url = new URL(request.url);
    const armed = await this.armed();
    if (!armed) return json(404, { error: "not_found" });
    let side: Side;
    if (url.pathname === "/client") {
      // Only the Worker reaches this, after the host's object admitted the client.
      if (this.ctx.getWebSockets("client").length) return json(409, { error: "taken" });
      side = "client";
    } else {
      const token = url.searchParams.get("token") ?? "";
      if (this.ctx.getWebSockets("host").length || !same(await sha256(token), armed.tokenHash))
        return json(404, { error: "not_found" });
      side = "host";
    }
    const [theirs, ours] = Object.values(new WebSocketPair());
    // The second tag names the stream in this socket's log lines, with no storage read to fail.
    this.ctx.acceptWebSocket(ours!, [side, `${short(armed.hostId)}/${short(armed.stream)}`]);
    const other = this.side(side === "client" ? "host" : "client");
    if (other) {
      // Both ends are here: each learns it, plxd's side then dials its own listener.
      ours!.send("ready");
      other.send("ready");
      await this.ctx.storage.deleteAlarm();
    } else if (side === "client") {
      await this.ctx.storage.setAlarm(Date.now() + JOIN_TIMEOUT);
    }
    return new Response(null, { status: 101, webSocket: theirs });
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
      },
    );
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

  /** plxd never joined the client's stream in time. */
  async alarm() {
    return logged(
      "stream.alarm",
      () => this.context(),
      async () => {
        if (this.side("host")) return;
        for (const ws of this.ctx.getWebSockets()) this.shut(ws, 4408, "the host didn't join");
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
