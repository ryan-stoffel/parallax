import { DurableObject } from "cloudflare:workers";

import { same, sha256 } from "./crypto";
import { type Env, json } from "./index";

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
 * has room, and closes every stream's object when it doesn't.
 */
export class StreamRelay extends DurableObject<Env> {
  /** Bytes counted since the last report. A hibernated object loses at most [`REPORT_BYTES`]. */
  private unreported = 0;
  private reported = false;

  private armed() {
    return this.ctx.storage.get<Armed>("armed");
  }

  private side(side: Side) {
    return this.ctx.getWebSockets(side).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** Called by the host's object before it tells plxd or a client about this stream. */
  async arm(armed: Armed) {
    await this.ctx.storage.put("armed", armed);
  }

  /** Closes both ends, as the host's object asks when its budget is spent, it's removed, or plxd
   *  reconnected. The host's object has already let the stream go, so nothing is reported. */
  async close(code: number, reason: string) {
    this.reported = true;
    for (const ws of this.ctx.getWebSockets()) ws.close(code, reason);
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
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
    this.ctx.acceptWebSocket(ours!, [side]);
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
    const [side] = this.ctx.getTags(ws) as [Side];
    const peer = this.side(side === "client" ? "host" : "client");
    // Only TLS records, and only once both ends are here.
    if (typeof message === "string" || !peer) return ws.close(4400, "bad frame");
    // Sent before any report is awaited, since another frame may be handled during the wait and
    // must not pass this one.
    peer.send(message);
    this.unreported += Math.max(message.byteLength, MIN_FRAME_BYTES);
    if (this.unreported >= REPORT_BYTES) await this.report(false);
  }

  async webSocketClose(ws: WebSocket) {
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

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** plxd never joined the client's stream in time. */
  async alarm() {
    if (this.side("host")) return;
    for (const ws of this.ctx.getWebSockets()) ws.close(4408, "the host didn't join");
    await this.finish();
  }

  /**
   * Reports the bytes counted since the last report to the host's object, and closes both ends
   * when the host's day is spent. Answers whether the stream goes on.
   */
  private async report(closed: boolean): Promise<boolean> {
    const armed = await this.armed();
    if (!armed) return false;
    const bytes = this.unreported;
    this.unreported = 0;
    const host = this.env.HOSTS.get(this.env.HOSTS.idFromName(armed.hostId));
    const within = await host.report(armed.stream, bytes, closed);
    if (!within && !closed) for (const ws of this.ctx.getWebSockets()) ws.close(4429, "daily limit");
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
