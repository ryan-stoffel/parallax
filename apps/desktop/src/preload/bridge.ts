// The `window.wisp` contract. The preload implements it and the renderer types
// against it, so it must not import anything from Node or Electron.
import type {
  Capabilities,
  CliKind,
  ErrorData,
  EventsEventParams,
  EventsSubscribeParams,
  LogId,
  WispRequests,
} from "../protocol/generated/protocol";

/** The Appearance setting: follow the OS, or force a theme. */
export const THEME_PREFERENCES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface WispBridge {
  /** Node's `process.platform`, e.g. "darwin", "win32", "linux". */
  platform: string;
  /** The app's version. */
  version(): Promise<string>;
  /** Sets Electron's `nativeTheme.themeSource`, so native UI matches the app's theme. */
  setThemeSource(preference: ThemePreference): void;
  /** Opens the OS folder picker over this window. Resolves to the folder's path, or null if cancelled. */
  pickFolder(): Promise<string | null>;

  /**
   * Names a new thread from its first prompt, with a model that runs on this computer. Resolves
   * at once, from the prompt's words, while the model isn't ready. Never rejects.
   */
  nameThread(prompt: string): Promise<ThreadName>;

  /**
   * Calls a wispd method on a host. Resolves to its result or its error, also for an unknown
   * host or method; never rejects.
   */
  request<M extends RendererMethod>(
    hostId: string,
    method: M,
    params: WispRequests[M]["params"],
  ): Promise<HostResponse<WispRequests[M]["result"]>>;
  /**
   * Streams a host's events after `params.after`, surviving reconnects. Ends with a `resync`
   * message when the events are gone, or at once if the host's log isn't `params.logId`
   * anymore: reload the snapshot, then subscribe again from its `seq`.
   * Returns the unsubscribe function.
   */
  subscribe(
    hostId: string,
    params: SubscribeParams,
    listener: (message: SubscriptionMessage) => void,
  ): () => void;
  /** A host's connection state now. Rejects for an unknown host id, as `retry` does. */
  connectionState(hostId: string): Promise<ConnectionState>;
  /** Every later connection state change, for every host. Returns the unsubscribe function. */
  onConnectionState(listener: (hostId: string, state: ConnectionState) => void): () => void;
  /** Reconnects a failed host now, including one that stopped retrying. */
  retry(hostId: string): Promise<void>;

  /** The saved SSH hosts, oldest first. This computer is host `local`, which isn't one of them. */
  hosts(): Promise<SshHost[]>;
  /** Every later change to the saved hosts. Returns the unsubscribe function. */
  onHosts(listener: (hosts: SshHost[]) => void): () => void;
  /** Adds a host, or edits the one with `id`. Resolves to an error for people, or undefined. */
  saveHost(host: HostInput, id?: string): Promise<string | undefined>;
  /**
   * Forgets a host and disconnects from it. Nothing on the host changes. Resolves to an error for
   * people, or undefined.
   */
  removeHost(id: string): Promise<string | undefined>;

  /**
   * Opens this window's terminal, running `cli`'s own sign-in on a host (0004), in place of any
   * terminal it had. Resolves to an error for people, or undefined once it runs. The app only
   * passes on what's typed and printed; it never reads or keeps it.
   */
  openTerminal(
    hostId: string,
    cli: CliKind,
    cols: number,
    rows: number,
  ): Promise<string | undefined>;
  /** Types into the terminal. */
  terminalInput(data: string): void;
  /** Resizes the terminal, in character cells. */
  resizeTerminal(cols: number, rows: number): void;
  /** Ends the terminal, killing what runs in it. */
  closeTerminal(): void;
  /** What the terminal prints, then its exit. Returns the unsubscribe function. */
  onTerminal(listener: (message: TerminalMessage) => void): () => void;
}

export type TerminalMessage = { type: "data"; data: string } | { type: "exit"; exitCode: number };

/** A thread's name: a `title` for lists, and a `slug` to name its worktree branch `wisp/<slug>`. */
export type ThreadName = { title?: string; slug?: string };

/** A host the user added, reached with `ssh <destination> wispd attach` (0022). */
export type SshHost = { id: string; name: string; destination: string };

/** What the Hosts settings edit. The main process checks it and picks the id. */
export type HostInput = { name: string; destination: string };

/** The methods the renderer may call. Main owns the handshake and event subscriptions. */
export type RendererMethod = Exclude<
  keyof WispRequests,
  "initialize" | "events/subscribe" | "events/unsubscribe"
>;

/** A JSON-RPC error. A wisp error (code -32000) carries `data.kind`. */
export type RpcError = { code: number; message: string; data?: ErrorData };

export type RpcResponse<R> = { result: R } | { error: RpcError };

/**
 * A host's answer. A result carries the `logId` of the event log it was read under (0007),
 * for `subscribe` to check a `seq` from it against.
 */
export type HostResponse<R> = { result: R; logId: LogId } | { error: RpcError };

/** `events/subscribe`'s params, plus the `logId` of the response `after` came from. */
export type SubscribeParams = EventsSubscribeParams & { logId: LogId };

export type SubscriptionMessage =
  | { type: "event"; event: EventsEventParams }
  /** The subscription ended because wispd can't replay what was missed. */
  | { type: "resync" }
  /** The subscription ended with an error, such as `projectNotFound`. */
  | { type: "error"; error: RpcError };

export type ConnectionState =
  | { status: "connecting" }
  /** `capabilities` are what wispd's `initialize` advertised, such as `runOptions`. */
  | { status: "connected"; wispd: string; protocol: number; capabilities: Capabilities }
  /** `retrying` is false once only `retry` can bring it back. */
  | { status: "failed"; error: ConnectionError; retrying: boolean };

export type ConnectionError = {
  /** `sshSetup`: the host needs the user, such as to accept its host key, so it isn't retried. */
  reason:
    | "notFound"
    | "incompatibleProtocol"
    | "exited"
    | "unresponsive"
    | "protocolError"
    | "sshSetup";
  /** For people: what went wrong and how to fix it. */
  message: string;
  /** How `wispd attach` exited, or ssh for a host. */
  exitCode?: number | null;
  /** The end of attach's stderr, and ssh's for a host, if they wrote any. */
  stderr?: string;
};
