// The JS side of PinnedTlsModule.swift: HTTPS and WebSocket to plxd, pinned to its certificate or,
// for an account's host, its key (0091), directly or inside a Parallax Relay stream.
import { requireNativeModule } from "expo";

type SocketEvent = {
  id: string;
  type: "open" | "message" | "close";
  data?: string;
  /** On a close before `open`: the HTTP status that refused the upgrade, if one did. */
  status?: number;
};

const native = requireNativeModule<{
  randomBytes(count: number): Uint8Array;
  privateFile(name: string): string;
  request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    pin: string | null,
    timeout: number,
  ): Promise<{ status: number; body: string; fingerprint: string }>;
  discover(seconds: number): Promise<{ name: string; route: string }[]>;
  open(id: string, url: string, pin: string, headers: Record<string, string>): void;
  relayOpen(id: string, url: string, token: string): Promise<number>;
  relayRefused(id: string): number | null;
  relayClose(id: string): void;
  authorize(url: string): Promise<string>;
  appVersion(): { version: string; build: string };
  preview(url: string): Promise<void>;
  send(id: string, text: string): void;
  close(id: string): void;
  addListener(event: "onSocket", listener: (event: SocketEvent) => void): unknown;
  addListener(event: "onNetwork", listener: () => void): { remove(): void };
}>("PinnedTls");

export const randomBytes = (count: number) => native.randomBytes(count);

/** The `file://` URL of `name` in a folder of Application Support kept out of backups. */
export const privateFile = (name: string) => native.privateFile(name);

/**
 * Signs in on Clerk's page in a sheet, as the desktop does in a browser (0067). Resolves to the
 * `parallax://` callback URL Clerk sent the sheet to, or rejects with code `ERR_CANCELED`.
 */
export const authorize = (url: string) => native.authorize(url);

/** Shows the file at `url` (`file://`) in Quick Look, whose share button saves or sends it. */
export const preview = (url: string) => native.preview(url);

/** This build's version and build number. */
export const appVersion = () => native.appVersion();

/** The computers showing a pairing code on this network, by name, found over mDNS in `seconds`. */
export const discover = (seconds: number) => native.discover(seconds);

/**
 * One HTTPS request, trusting only the certificate whose SHA-256 is `pin`, or whose key's JWK
 * thumbprint is `<hostId>` when `pin` is `key:<hostId>` (over TLS 1.3 only), or with no pin any.
 * The certificate's SHA-256 comes back. It gives up after `timeout` seconds without a byte.
 * Rejects with code `ERR_WRONG_HOST` when the pin refused the certificate, else `ERR_NETWORK`.
 */
export const request = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: object | undefined,
  pin: string | undefined,
  timeout = 10,
) => native.request(url, method, headers, body ? JSON.stringify(body) : null, pin ?? null, timeout);

/** Calls `listener` when the network comes back or changes, until the returned function. */
export function onNetwork(listener: () => void): () => void {
  const subscription = native.addListener("onNetwork", listener);
  return () => subscription.remove();
}

/** A loopback port whose every connection is a stream to one host through Parallax Relay. */
export interface RelayBridge {
  port: number;
  /** The relay's HTTP status when it last refused a stream, such as 503 while the host is offline. */
  refused(): number | undefined;
  close(): void;
}

let nextBridge = 0;

/**
 * Opens a bridge to the relay's `url` (`wss://…/v1/hosts/<hostId>/connect`), whose streams open
 * with the Clerk `token`. Requests to `https://127.0.0.1:<port>` then reach the host with TLS
 * inside the stream, and the relay sees only TLS records (RelayBridge.swift).
 */
export async function openRelay(url: string, token: string): Promise<RelayBridge> {
  const id = String(++nextBridge);
  const port = await native.relayOpen(id, url, token);
  return {
    port,
    refused: () => native.relayRefused(id) ?? undefined,
    close: () => native.relayClose(id),
  };
}

const sockets = new Map<string, PinnedSocket>();
native.addListener("onSocket", ({ id, type, data, status }) => {
  const socket = sockets.get(id);
  if (!socket) return;
  if (type === "open") {
    socket.readyState = WebSocket.OPEN;
    socket.onopen?.();
  } else if (type === "message") socket.onmessage?.({ data: data ?? "" });
  else {
    sockets.delete(id);
    socket.readyState = WebSocket.CLOSED;
    socket.refusedWith = status;
    socket.ended();
    socket.onclose?.();
  }
});

let nextId = 0;

/**
 * A WebSocket, as much of one as `WebHost` uses: to `url`, trusting only the certificate `pin`
 * (as `request` takes it), with `headers` on the upgrade.
 *
 * A handler set after the socket opened or closed still runs, once, so a caller can wait for it
 * to open before handing it on.
 */
export class PinnedSocket {
  readyState: number = WebSocket.CONNECTING;
  onmessage?: (event: { data: string }) => void;
  /** The HTTP status that refused the upgrade, once closed, if one did. */
  refusedWith?: number;
  /** Runs once when the socket closes, either end closing it, such as to close its relay bridge. */
  onEnd?: () => void;
  private readonly id = String(++nextId);
  private opened?: () => void;
  private closed?: () => void;

  constructor(url: string, pin: string, headers: Record<string, string> = {}) {
    sockets.set(this.id, this);
    native.open(this.id, url, pin, headers);
  }

  get onopen() {
    return this.opened;
  }

  set onopen(handler: (() => void) | undefined) {
    this.opened = handler;
    if (handler && this.readyState === WebSocket.OPEN) queueMicrotask(handler);
  }

  get onclose() {
    return this.closed;
  }

  set onclose(handler: (() => void) | undefined) {
    this.closed = handler;
    if (handler && this.readyState === WebSocket.CLOSED && !sockets.has(this.id))
      queueMicrotask(handler);
  }

  send(text: string) {
    native.send(this.id, text);
  }

  close() {
    sockets.delete(this.id);
    this.readyState = WebSocket.CLOSED;
    native.close(this.id);
    this.ended();
  }

  /** Runs `onEnd`, once. */
  ended() {
    const end = this.onEnd;
    this.onEnd = undefined;
    end?.();
  }
}
