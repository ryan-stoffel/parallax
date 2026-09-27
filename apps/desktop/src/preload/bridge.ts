// The `window.wisp` contract. The preload implements it and the renderer types
// against it, so it must not import anything from Node or Electron.
import type {
  ErrorData,
  EventsEventParams,
  EventsSubscribeParams,
  WispRequests,
} from "../protocol/generated/protocol";

export interface WispBridge {
  /** Node's `process.platform`, e.g. "darwin", "win32", "linux". */
  platform: string;
  /** The app's version. */
  version(): Promise<string>;

  /** Calls a wispd method on a host. Resolves to its result or its error; never rejects. */
  request<M extends RendererMethod>(
    hostId: string,
    method: M,
    params: WispRequests[M]["params"],
  ): Promise<RpcResponse<WispRequests[M]["result"]>>;
  /**
   * Streams a host's events after `params.after`, surviving reconnects. Ends with a `resync`
   * message when the events are gone: reload the snapshot, then subscribe again from its `seq`.
   * Returns the unsubscribe function.
   */
  subscribe(
    hostId: string,
    params: EventsSubscribeParams,
    listener: (message: SubscriptionMessage) => void,
  ): () => void;
  /** A host's connection state now. */
  connectionState(hostId: string): Promise<ConnectionState>;
  /** Every later connection state change, for every host. Returns the unsubscribe function. */
  onConnectionState(listener: (hostId: string, state: ConnectionState) => void): () => void;
  /** Reconnects a failed host now, including one that stopped retrying. */
  retry(hostId: string): Promise<void>;
}

/** The methods the renderer may call. Main owns the handshake and event subscriptions. */
export type RendererMethod = Exclude<
  keyof WispRequests,
  "initialize" | "events/subscribe" | "events/unsubscribe"
>;

/** A JSON-RPC error. A wisp error (code -32000) carries `data.kind`. */
export type RpcError = { code: number; message: string; data?: ErrorData };

export type RpcResponse<R> = { result: R } | { error: RpcError };

export type SubscriptionMessage =
  | { type: "event"; event: EventsEventParams }
  /** The subscription ended because wispd can't replay what was missed. */
  | { type: "resync" }
  /** The subscription ended with an error, such as `projectNotFound`. */
  | { type: "error"; error: RpcError };

export type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; wispd: string; protocol: number }
  /** `retrying` is false once only `retry` can bring it back. */
  | { status: "failed"; error: ConnectionError; retrying: boolean };

export type ConnectionError = {
  reason: "notFound" | "incompatibleProtocol" | "exited" | "unresponsive" | "protocolError";
  message: string;
  /** How `wispd attach` exited, for `exited`. */
  exitCode?: number | null;
  /** The end of attach's stderr, if it wrote any. */
  stderr?: string;
};
