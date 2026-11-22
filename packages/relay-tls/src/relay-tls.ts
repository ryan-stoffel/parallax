// plxd's pinned TLS 1.3 inside a relay stream's WebSocket, for the hosted browser client (0108).
// The TLS is rustls in WebAssembly (crates/parallax-browser-tls), checking the host's certificate
// with plxd's own pin code, so the relay carries ciphertext only and can't stand in for the host.

import init, { TlsClient } from "../pkg/parallax_browser_tls.js";

/** The host a connection must reach: its relay id (its key's JWK thumbprint), or for a LAN pin
 * its certificate's SHA-256 in lowercase hex. */
export type RelayPin = { hostId: string } | { fingerprint: string };

export interface ConnectOptions {
  /** Plaintext to send first, such as the `/ws` upgrade. With a ticket from an earlier connect to
   * this pin in the page's life, it goes as 0-RTT early data, and again after the handshake when
   * the host refuses that. Without one it goes once the host proved its key. */
  first?: Uint8Array;
}

/** What `loadRelayTls` takes: the module's bytes, or where to fetch them. */
export type ModuleSource = BufferSource | URL | string | Response | WebAssembly.Module;

let loading: Promise<unknown> | undefined;

/** Loads the WebAssembly once per page: from `source`, or else the `.wasm` beside the module's
 * JavaScript. `RelayTls.connect` calls it with no source when nothing loaded it first. */
export function loadRelayTls(source?: ModuleSource): Promise<unknown> {
  loading ??= init(source === undefined ? undefined : { module_or_path: source });
  return loading;
}

/** One TLS connection to plxd over a WebSocket that carries the relay stream's bytes. */
export class RelayTls {
  readonly #socket: WebSocket;
  readonly #tls: TlsClient;
  readonly #chunks: Uint8Array[] = [];
  readonly #readers: ((chunk: Uint8Array | null) => void)[] = [];
  #ended = false;
  #freed = false;

  private constructor(socket: WebSocket, tls: TlsClient) {
    this.#socket = socket;
    this.#tls = tls;
  }

  /** Runs the handshake over `socket`, open or opening, pinned to `pin`. Resolves once the host
   * proved it holds the pinned key, and rejects, having sent no plaintext, when it doesn't. */
  static async connect(
    socket: WebSocket,
    pin: RelayPin,
    options: ConnectOptions = {},
  ): Promise<RelayTls> {
    await loadRelayTls();
    socket.binaryType = "arraybuffer";
    if (socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("close", () => reject(new Error("the relay closed the stream")), {
          once: true,
        });
      });
    }
    if (socket.readyState !== WebSocket.OPEN) throw new Error("the relay stream isn't open");
    const first = options.first ?? new Uint8Array();
    const tls =
      "hostId" in pin ? TlsClient.toHost(pin.hostId, first) : TlsClient.toFingerprint(pin.fingerprint, first);
    const connection = new RelayTls(socket, tls);
    return new Promise((resolve, reject) => {
      socket.addEventListener("message", (event: MessageEvent) => {
        if (connection.#freed) return;
        try {
          tls.feed(new Uint8Array(event.data as ArrayBuffer));
        } catch (error) {
          // The alert, if any, goes before the close. It carries no plaintext.
          connection.#flush();
          connection.#end();
          socket.close();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        connection.#flush();
        const plaintext = tls.read();
        if (plaintext.length > 0) connection.#push(plaintext);
        if (!tls.handshaking) resolve(connection);
        if (tls.peerClosed) {
          connection.#end();
          reject(new Error("plxd closed the connection during the TLS handshake"));
        }
      });
      // Once the handshake resolved, these rejections do nothing.
      socket.addEventListener("close", () => {
        connection.#end();
        reject(new Error("the relay stream closed during the TLS handshake"));
      });
      connection.#flush();
    });
  }

  /** The ALPN protocol plxd picked: `plxd-early-ws`, or `http/1.1` from a plxd before PLX-1483. */
  get alpn(): string | undefined {
    return this.#freed ? undefined : this.#tls.alpn;
  }

  /** Whether the handshake resumed with a ticket from an earlier connect to this pin. */
  get resumed(): boolean {
    return !this.#freed && this.#tls.resumed;
  }

  /** Whether plxd took `first` as early data. */
  get earlyAccepted(): boolean {
    return !this.#freed && this.#tls.earlyAccepted;
  }

  /** Sends plaintext to plxd. */
  write(data: Uint8Array): void {
    if (this.#ended) throw new Error("the connection is closed");
    this.#tls.write(data);
    this.#flush();
  }

  /** The next plaintext from plxd, or null once the connection has ended. */
  read(): Promise<Uint8Array | null> {
    const chunk = this.#chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => this.#readers.push(resolve));
  }

  /** Ends the connection with a `close_notify`, then closes the WebSocket. */
  close(): void {
    if (this.#ended) return;
    this.#tls.close();
    this.#flush();
    this.#end();
    this.#socket.close();
  }

  #flush(): void {
    if (this.#freed) return;
    const out = this.#tls.take();
    if (out.length > 0 && this.#socket.readyState === WebSocket.OPEN) {
      // wasm-bindgen copies it out of the module's memory into its own ArrayBuffer.
      this.#socket.send(out as Uint8Array<ArrayBuffer>);
    }
  }

  #push(chunk: Uint8Array): void {
    const reader = this.#readers.shift();
    if (reader) reader(chunk);
    else this.#chunks.push(chunk);
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const reader of this.#readers.splice(0)) reader(null);
    this.#freed = true;
    this.#tls.free();
  }
}
