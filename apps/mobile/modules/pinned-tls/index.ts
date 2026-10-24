// The JS side of PinnedTlsModule.swift: HTTPS and WebSocket to plxd, pinned to its certificate,
// and Parallax Connect's TCP over Tailscale.
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
  openTcp(id: string, host: string, port: number): void;
  tailnetAddress(): string | null;
  authorize(url: string): Promise<string>;
  appVersion(): { version: string; build: string };
  preview(url: string): Promise<void>;
  send(id: string, text: string): void;
  close(id: string): void;
  addListener(event: "onSocket", listener: (event: SocketEvent) => void): unknown;
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

/** This phone's Tailscale address, or null while Tailscale isn't connected. */
export const tailnetAddress = () => native.tailnetAddress();

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

/**
 * A WebSocket, as much of one as `WebHost` uses: to `url`, trusting only the certificate `pin`,
 * or with `tcp`, Connect's newline-delimited JSON-RPC to plxd's port 7340 on a tailnet address.
 */
export class PinnedSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  private readonly id = String(++nextId);

  constructor(url: string, pin: string);
  constructor(tcp: { host: string; port: number });
  constructor(target: string | { host: string; port: number }, pin?: string) {
    sockets.set(this.id, this);
    if (typeof target === "string") native.open(this.id, target, pin!);
    else native.openTcp(this.id, target.host, target.port);
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
