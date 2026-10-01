import { ErrorCodes, MAX_FRAME_BYTES, type WispRequests } from "../protocol/generated/protocol";
import type { RpcError, RpcResponse } from "../preload/bridge";

type Pending = { onResponse: (response: RpcResponse<unknown>) => void; timer: NodeJS.Timeout };

export type RpcHandlers = {
  /** A notification from wispd, such as `events/event`. */
  onNotification(method: string, params: unknown): void;
  /** The stream broke a framing rule (0007) and must be closed. */
  onFatal(message: string): void;
  /** A line that isn't JSON. The client skips it. */
  onBadLine?(line: string): void;
};

/**
 * A JSON-RPC 2.0 client over NDJSON (0007): one compact JSON object per line. The owner feeds
 * it received bytes with `receive` and gives it a `write` for outgoing lines.
 */
export class RpcClient {
  /** The largest frame to send, lowered to wispd's `maxFrameBytes` after `initialize`. */
  maxFrameBytes = MAX_FRAME_BYTES;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private closed = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: RpcHandlers,
  ) {}

  /** Feeds received bytes. Lines may arrive split across chunks or several to a chunk. */
  receive(chunk: Buffer): void {
    let start = 0;
    while (!this.closed) {
      const end = chunk.indexOf(10, start);
      this.buffer(chunk.subarray(start, end === -1 ? undefined : end));
      if (end === -1 || this.closed) return;
      const line = Buffer.concat(this.buffered).toString("utf8");
      this.buffered = [];
      this.bufferedBytes = 0;
      start = end + 1;
      if (line.trim() !== "") this.dispatch(line);
    }
  }

  /**
   * Sends a request and calls `onResponse` exactly once: with wispd's answer, or with an error
   * after `timeoutMs` (which also sends `$/cancelRequest`) or when the client closes.
   * `onResponse` runs synchronously while the response line is read, so it sees the stream's
   * state before any later line, such as the first event of a new subscription.
   */
  send<M extends keyof WispRequests>(
    method: M,
    params: WispRequests[M]["params"],
    timeoutMs: number,
    onResponse: (response: RpcResponse<WispRequests[M]["result"]>) => void,
  ): void {
    if (this.closed) return onResponse(failure(ErrorCodes.InternalError, "not connected"));
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    if (Buffer.byteLength(line) - 1 > this.maxFrameBytes) {
      return onResponse(
        failure(ErrorCodes.InvalidRequest, "the request is larger than maxFrameBytes"),
      );
    }
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.notify("$/cancelRequest", { id });
      onResponse(failure(ErrorCodes.RequestCancelled, `${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    this.pending.set(id, { onResponse: onResponse as Pending["onResponse"], timer });
    this.write(line);
  }

  /** `send` as a promise, for callers that don't need the synchronous ordering. */
  request<M extends keyof WispRequests>(
    method: M,
    params: WispRequests[M]["params"],
    timeoutMs: number,
  ): Promise<RpcResponse<WispRequests[M]["result"]>> {
    return new Promise((resolve) => this.send(method, params, timeoutMs, resolve));
  }

  /** Fails every pending request and ignores anything received after. */
  close(message: string): void {
    this.closed = true;
    for (const { onResponse, timer } of this.pending.values()) {
      clearTimeout(timer);
      onResponse(failure(ErrorCodes.InternalError, message));
    }
    this.pending.clear();
  }

  private notify(method: string, params: unknown): void {
    if (!this.closed) this.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private buffer(part: Buffer): void {
    if (part.length === 0) return;
    this.buffered.push(part);
    this.bufferedBytes += part.length;
    if (this.bufferedBytes > MAX_FRAME_BYTES) {
      this.close("wispd sent a frame larger than maxFrameBytes");
      this.handlers.onFatal("wispd sent a frame larger than maxFrameBytes");
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // NDJSON resyncs at the next newline, so one bad line costs only itself.
      this.handlers.onBadLine?.(line);
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { id, method, params, result, error } = message as Record<string, unknown>;
    if (typeof method === "string") {
      // wispd sends no requests to clients yet, only notifications.
      if (id === undefined) this.handlers.onNotification(method, params);
      return;
    }
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!pending) return; // Timed out, or not ours.
    this.pending.delete(id as number);
    clearTimeout(pending.timer);
    pending.onResponse(error !== undefined ? { error: error as RpcError } : { result });
  }
}

function failure(code: number, message: string): { error: RpcError } {
  return { error: { code, message } };
}
