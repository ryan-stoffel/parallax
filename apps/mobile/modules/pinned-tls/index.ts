// The JS side of PinnedTlsModule.swift: HTTPS and WebSocket to plxd, pinned to its certificate.
import { requireNativeModule } from "expo";

type SocketEvent = { id: string; type: "open" | "message" | "close"; data?: string };

const native = requireNativeModule<{
  randomBytes(count: number): Uint8Array;
  privateFile(name: string): string;
  request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    pin: string | null,
  ): Promise<{ status: number; body: string; fingerprint: string }>;
  discover(seconds: number): Promise<{ name: string; route: string }[]>;
  open(id: string, url: string, pin: string): void;
  send(id: string, text: string): void;
  close(id: string): void;
  addListener(event: "onSocket", listener: (event: SocketEvent) => void): unknown;
}>("PinnedTls");

export const randomBytes = (count: number) => native.randomBytes(count);

/** The `file://` URL of `name` in a folder of Application Support kept out of backups. */
export const privateFile = (name: string) => native.privateFile(name);

/** The computers showing a pairing code on this network, by name, found over mDNS in `seconds`. */
export const discover = (seconds: number) => native.discover(seconds);

/**
 * One HTTPS request, trusting only the certificate whose SHA-256 is `pin`, or with no pin any,
 * whose fingerprint comes back. Rejects with code `ERR_WRONG_HOST` when another certificate
 * answered, else `ERR_NETWORK`.
 */
export const request = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: object | undefined,
  pin: string | undefined,
) => native.request(url, method, headers, body ? JSON.stringify(body) : null, pin ?? null);

const sockets = new Map<string, PinnedSocket>();
native.addListener("onSocket", ({ id, type, data }) => {
  const socket = sockets.get(id);
  if (!socket) return;
  if (type === "open") {
    socket.readyState = WebSocket.OPEN;
    socket.onopen?.();
  } else if (type === "message") socket.onmessage?.({ data: data ?? "" });
  else {
    sockets.delete(id);
    socket.readyState = WebSocket.CLOSED;
    socket.onclose?.();
  }
});

let nextId = 0;

/** A WebSocket, as much of one as `WebHost` uses, trusting only the certificate `pin`. */
export class PinnedSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  private readonly id = String(++nextId);

  constructor(url: string, pin: string) {
    sockets.set(this.id, this);
    native.open(this.id, url, pin);
  }

  send(text: string) {
    native.send(this.id, text);
  }

  close() {
    sockets.delete(this.id);
    this.readyState = WebSocket.CLOSED;
    native.close(this.id);
  }
}
