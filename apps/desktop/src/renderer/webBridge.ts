// The web client's `window.parallax` (PLX-651, 0065): the preload API for a browser that plxd
// served, over that plxd's `/ws` WebSocket with the session this browser paired for. Its one host
// is that plxd, as `local`. What only the desktop app can do (other hosts, the updater, editors,
// file pickers, the account) answers empty or with an error for people.
//
// It imports no runtime code from the renderer, so the desktop app's chunks stay as they are.

import type {
  ConnectionState,
  HostResponse,
  ParallaxBridge,
  RpcError,
  RpcResponse,
  SubscribeParams,
  SubscriptionMessage,
  TerminalMessage,
  WatchMessage,
  WatchParams,
} from "../preload/bridge";
import type {
  EventsEventParams,
  EventsResyncParams,
  InitializeResult,
  LogId,
  SubscribeShellResult,
  SubscribeThreadResult,
  SubscriptionId,
  TerminalExitParams,
  TerminalOpenParams,
  TerminalOutputParams,
} from "../protocol/generated/protocol";

// The generated protocol's, copied so this chunk shares nothing with the app's (webBridge.test.ts).
export const PROTOCOL_VERSION = 1;
export const INTERNAL_ERROR = -32603;
export const INVALID_PARAMS = -32602;

const LOCAL = "local";
// 0007's client rules, as connection.ts has them.
const HEARTBEAT_MS = 30_000;
const LIVENESS_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const NOT_HERE = "Only the desktop app can do this.";

/** A paired browser's session: its token, and the `DPoP` key it's bound to, which never leaves. */
export type Session = { token: string; key: CryptoKeyPair };

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const encoded = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * An ES256 `DPoP` proof (RFC 9449) for a `method` request to this origin's `path`, with
 * `token`'s hash once there is one, as plxd's `verify_proof` checks it.
 */
export async function proof(key: CryptoKeyPair, method: string, path: string, token?: string) {
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", key.publicKey);
  const ath =
    token && base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const header = encoded({ typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } });
  const claims = encoded({
    htm: method,
    htu: `${location.origin}${path}`,
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...(ath && { ath }),
  });
  const input = new TextEncoder().encode(`${header}.${claims}`);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    input,
  );
  return `${header}.${claims}.${base64url(signature)}`;
}

/** The session in this browser's IndexedDB, which can keep a key that can't be read out. */
function sessionStore<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("parallax", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("session");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = run(open.result.transaction("session", "readwrite").objectStore("session"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}
export const savedSession = () =>
  sessionStore<Session | undefined>((store) => store.get("session"));
const forget = () => sessionStore((store) => store.delete("session"));

/** This browser's name in the host's list of paired devices. */
function deviceLabel(): string {
  const agent = navigator.userAgent;
  const device =
    ["iPhone", "iPad", "Android", "Mac", "Windows", "Linux"].find((d) => agent.includes(d)) ?? "";
  return device ? `Browser on ${device === "Mac" ? "a Mac" : device}` : "Browser";
}

/**
 * Pairs this browser with the code the host shows, under a new non-extractable `DPoP` key, and
 * keeps the session. Resolves to an error for people, or undefined.
 */
export async function pair(code: string): Promise<string | undefined> {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const path = "/api/pair/browser";
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", DPoP: await proof(key, "POST", path) },
    body: JSON.stringify({ code, clientLabel: deviceLabel() }),
  }).catch(() => undefined);
  if (!response) return "Couldn't reach Parallax. Check that the computer is on.";
  if (response.status === 401) return "That code is wrong, used, or expired. Show a new one.";
  if (!response.ok) return `Parallax couldn't pair (${response.status}).`;
  const { accessToken } = (await response.json()) as { accessToken: string };
  await sessionStore((store) => store.put({ token: accessToken, key }, "session"));
  return undefined;
}

/**
 * A 30 s ticket for `/ws`, or why there's none: `revoked` only when plxd doesn't know the session
 * anymore (`invalid_token`), else an error for people, and the connection tries again.
 */
async function ticket({ token, key }: Session): Promise<{ ticket: string } | { error: string }> {
  const path = "/api/auth/websocket-ticket";
  const response = await fetch(path, {
    method: "POST",
    headers: { Authorization: `DPoP ${token}`, DPoP: await proof(key, "POST", path, token) },
  }).catch(() => undefined);
  if (!response) return { error: "Couldn't reach Parallax on this computer." };
  const answer = (await response.json().catch(() => ({}))) as { ticket?: string; error?: string };
  if (answer.ticket) return { ticket: answer.ticket };
  if (answer.error === "invalid_token") return { error: "revoked" };
  if (answer.error === "access_denied")
    return { error: "Open in a browser is off on this computer. Turn it on there to continue." };
  if (response.status === 401)
    return {
      error: "Parallax refused this browser's proof. Check that this device's clock is right.",
    };
  return { error: `Parallax couldn't connect (${response.status}).` };
}

type Pending = { done: (response: RpcResponse<unknown>) => void; timer: number };
type Subscription = {
  params: Omit<SubscribeParams, "logId">;
  logId: LogId;
  listener: (message: SubscriptionMessage) => void;
  id?: SubscriptionId;
};
type Watch = {
  params: WatchParams;
  listener: (message: WatchMessage) => void;
  seq?: number;
  logId?: LogId;
  id?: SubscriptionId;
};

/**
 * The connection to the serving plxd: JSON-RPC over `/ws`, one message per frame, kept alive with
 * heartbeats and reconnected with backoff, as connection.ts does for `plxd attach`. A refused
 * ticket means the session was revoked, so the page goes back to pairing.
 */
export class WebHost {
  state: ConnectionState = { status: "connecting" };
  readonly stateListeners = new Set<(hostId: string, state: ConnectionState) => void>();
  private socket?: WebSocket;
  private logId?: LogId;
  private nextId = 1;
  private failures = 0;
  private retryTimer?: number;
  private heartbeatTimer?: number;
  private livenessTimer?: number;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly watches = new Set<Watch>();
  /** The terminals opened, by the id the renderer gave, which is plxd's `terminalId` too. */
  readonly terminals = new Map<string, TerminalOpenParams>();
  /** Who shows each terminal, by its id. */
  readonly terminalListeners = new Map<string, (message: TerminalMessage) => void>();

  constructor(
    private readonly session: Session,
    private readonly signedOut = () => location.reload(),
  ) {}

  async connect(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.setState({ status: "connecting" });
    const answer = await ticket(this.session);
    if ("error" in answer) {
      if (answer.error !== "revoked") return this.fail(answer.error);
      await forget();
      return this.signedOut();
    }
    const socket = new WebSocket(`wss://${location.host}/ws?wsTicket=${answer.ticket}`);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
      this.receive(String(event.data));
    };
    socket.onclose = () => {
      if (socket === this.socket) this.end("The connection to Parallax ended.");
    };
    socket.onopen = () => {
      const capabilities = { resyncNotice: {} };
      const client = { name: "parallax-web", version: "web" };
      const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION };
      this.send("initialize", { protocol, client, capabilities }, (response) => {
        if (socket !== this.socket) return;
        if ("error" in response) return this.end(`initialize failed: ${response.error.message}`);
        this.initialized(response.result as InitializeResult);
      });
    };
  }

  request(method: string, params: unknown): Promise<HostResponse<unknown>> {
    const logId = this.logId;
    if (this.state.status !== "connected" || logId === undefined) {
      return Promise.resolve({ error: { code: INTERNAL_ERROR, message: "not connected" } });
    }
    return new Promise((resolve) =>
      this.send(method, params, (response) =>
        resolve("result" in response ? { ...response, logId } : response),
      ),
    );
  }

  /** See `ParallaxBridge.subscribe`. */
  subscribe({ logId, ...params }: SubscribeParams, listener: Subscription["listener"]): () => void {
    const subscription: Subscription = { params, logId, listener };
    this.subscriptions.add(subscription);
    if (this.state.status === "connected") this.sendSubscribe(subscription);
    return () => {
      if (this.subscriptions.delete(subscription) && subscription.id)
        this.send("events/unsubscribe", { subscription: subscription.id });
    };
  }

  /** See `ParallaxBridge.watch`. */
  watch(params: WatchParams, listener: Watch["listener"]): () => void {
    const watch: Watch = { params, listener };
    this.watches.add(watch);
    if (this.state.status === "connected") this.sendWatch(watch);
    return () => {
      if (this.watches.delete(watch) && watch.id)
        this.send("events/unsubscribe", { subscription: watch.id });
    };
  }

  /** Opens or attaches to plxd's terminal `params`. Resolves to an error for people. */
  async openTerminal(params: TerminalOpenParams): Promise<string | undefined> {
    this.terminals.set(params.terminalId, params);
    const answer = await this.request("terminal/open", params);
    if (!("error" in answer)) return undefined;
    this.terminals.delete(params.terminalId);
    return answer.error.message;
  }

  /** Sends a notification, which gets no response. */
  notify(method: string, params: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Sends `host/health`, and reconnects if nothing comes back within 10 s. */
  heartbeat(): void {
    if (this.state.status !== "connected") return;
    this.send("host/health", {});
    this.livenessTimer ??= window.setTimeout(
      () => this.end("Parallax stopped answering."),
      LIVENESS_MS,
    );
  }

  /** Reconnects now if the connection failed. */
  retry(): void {
    if (this.state.status !== "failed") return;
    this.failures = 0;
    void this.connect();
  }

  send(method: string, params: unknown, done?: Pending["done"]): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      done?.({ error: { code: INTERNAL_ERROR, message: "not connected" } });
      return;
    }
    const id = this.nextId++;
    if (done) {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        done({ error: { code: -32800, message: `${method} timed out` } });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { done, timer });
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const { id, method, params, result, error } = message;
    if (typeof method === "string") return this.notified(method, params);
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as number);
    clearTimeout(pending.timer);
    pending.done(error !== undefined ? { error: error as RpcError } : { result });
  }

  private initialized(result: InitializeResult): void {
    this.logId = result.logId;
    this.failures = 0;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    const { plxd, protocol, capabilities } = result;
    this.setState({ status: "connected", plxd, protocol, capabilities });
    for (const subscription of this.subscriptions) this.sendSubscribe(subscription);
    for (const watch of this.watches) this.sendWatch(watch);
    // A shell opened again replays what it printed.
    for (const [id, params] of this.terminals) {
      this.send("terminal/open", params, (response) => {
        if ("error" in response) this.endTerminal(id, -1);
      });
    }
  }

  private sendSubscribe(subscription: Subscription): void {
    if (subscription.logId !== this.logId) return this.endSubscription(subscription);
    const socket = this.socket;
    this.send("events/subscribe", subscription.params, (response) => {
      if (socket !== this.socket) return;
      if (!this.subscriptions.has(subscription)) {
        if ("result" in response) this.send("events/unsubscribe", response.result);
        return;
      }
      if ("result" in response)
        subscription.id = (response.result as { subscription: SubscriptionId }).subscription;
      else if (response.error.data?.kind === "resyncRequired") this.endSubscription(subscription);
      else this.endSubscription(subscription, { type: "error", error: response.error });
    });
  }

  private endSubscription(
    subscription: Subscription,
    message: SubscriptionMessage = { type: "resync" },
  ): void {
    this.subscriptions.delete(subscription);
    subscription.listener(message);
  }

  private sendWatch(watch: Watch): void {
    const socket = this.socket;
    // A `seq` from another log is meaningless, so a new log starts from a snapshot.
    const afterSeq = watch.logId === this.logId ? watch.seq : undefined;
    const after = afterSeq === undefined ? {} : { afterSeq };
    watch.id = undefined;
    const answered = (response: RpcResponse<unknown>) => {
      if (socket !== this.socket) return;
      if (!this.watches.has(watch)) {
        if ("result" in response) this.send("events/unsubscribe", response.result);
        return;
      }
      if ("error" in response) {
        this.watches.delete(watch);
        return watch.listener({ type: "error", error: response.error });
      }
      const { subscription, snapshot } = response.result as
        | SubscribeShellResult
        | SubscribeThreadResult;
      watch.id = subscription;
      if (!snapshot) return;
      watch.seq = snapshot.seq;
      watch.logId = this.logId;
      watch.listener({ type: "snapshot", snapshot });
    };
    if ("threadId" in watch.params) {
      const params = { threadId: watch.params.threadId, ...after };
      this.send("orchestration/subscribeThread", params, answered);
    } else this.send("orchestration/subscribeShell", after, answered);
  }

  private notified(method: string, params: unknown): void {
    if (method === "terminal/output") {
      const { data, replay, terminalId } = params as TerminalOutputParams;
      this.terminalListeners.get(terminalId)?.({ type: replay ? "replay" : "data", data });
      return;
    }
    if (method === "terminal/exit") {
      const { exitCode, terminalId } = params as TerminalExitParams;
      return this.endTerminal(terminalId, exitCode);
    }
    if (method === "events/resync") {
      const { subscription: id } = params as EventsResyncParams;
      for (const subscription of this.subscriptions)
        if (subscription.id === id) return this.endSubscription(subscription);
      for (const watch of this.watches) if (watch.id === id) return this.sendWatch(watch);
      return;
    }
    if (method !== "events/event") return;
    const event = params as EventsEventParams;
    for (const watch of this.watches) {
      if (watch.id !== event.subscription) continue;
      if (watch.seq !== undefined && event.seq <= watch.seq) return;
      watch.seq = event.seq;
      return watch.listener({ type: "event", event });
    }
    for (const subscription of this.subscriptions) {
      if (subscription.id !== event.subscription) continue;
      if (event.seq <= subscription.params.after) return;
      subscription.params.after = event.seq;
      return subscription.listener({ type: "event", event });
    }
  }

  private endTerminal(id: string, exitCode: number): void {
    this.terminals.delete(id);
    this.terminalListeners.get(id)?.({ type: "exit", exitCode });
  }

  /** Drops the socket, then reconnects with backoff: 1 s, doubling, up to 10 s. */
  private end(message: string): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.livenessTimer);
    this.livenessTimer = undefined;
    for (const { done, timer } of this.pending.values()) {
      clearTimeout(timer);
      done({ error: { code: INTERNAL_ERROR, message } });
    }
    this.pending.clear();
    for (const subscription of this.subscriptions) subscription.id = undefined;
    for (const watch of this.watches) watch.id = undefined;
    // plxd ends a command with the connection that opened it.
    for (const [id, params] of this.terminals) if (params.command) this.endTerminal(id, -1);
    this.fail(message);
  }

  private fail(message: string): void {
    this.setState({ status: "failed", error: { reason: "exited", message }, retrying: true });
    const wait = Math.min(1000 * 2 ** this.failures++, 10_000);
    this.retryTimer = window.setTimeout(() => void this.connect(), wait);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(LOCAL, state);
  }
}

/** `process.platform`'s name for this browser's OS, for the app's keyboard shortcuts. */
const platform = () => {
  const agent = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(agent)) return "darwin";
  return agent.includes("Windows") ? "win32" : "linux";
};

const unknownHost = { error: { code: INVALID_PARAMS, message: "unknown host" } };
const none = () => () => {};

/** The bridge for `host`, the serving plxd, whose name is `name`. */
export function webBridge(host: WebHost, name: string): ParallaxBridge {
  return {
    platform: platform(),
    version: async () => (host.state.status === "connected" ? host.state.plxd : "web"),
    setThemeSource: () => {},
    setZoom: (factor) => void (document.documentElement.style.zoom = String(factor)),
    pickFolder: async () => null,
    listFolders: async () => ({ error: NOT_HERE }),
    createRepo: async () => ({ error: NOT_HERE }),
    cloneRepo: async () => ({ error: NOT_HERE }),
    copyPicture: () => Promise.reject(new Error(NOT_HERE)),
    updatable: false,
    locale: navigator.language,
    update: async () => NOT_HERE,
    onUpdateState: none,

    request: (async (hostId: string, method: string, params: unknown) =>
      hostId === LOCAL ? host.request(method, params) : unknownHost) as ParallaxBridge["request"],
    subscribe: (hostId, params, listener) =>
      hostId === LOCAL ? host.subscribe(params, listener) : none(),
    watch: ((hostId: string, params: WatchParams, listener: (message: WatchMessage) => void) =>
      hostId === LOCAL ? host.watch(params, listener) : none()) as ParallaxBridge["watch"],
    async connectionState(hostId) {
      if (hostId !== LOCAL) throw new Error("unknown host");
      return host.state;
    },
    onConnectionState(listener) {
      host.stateListeners.add(listener);
      return () => host.stateListeners.delete(listener);
    },
    retry: async (hostId) => {
      if (hostId === LOCAL) host.retry();
    },

    hosts: async () => [],
    onHosts: none,
    sshSuggestions: async () => [],
    onLocalName: (listener) => (listener(name), () => {}),
    renameLocal: async () => NOT_HERE,
    saveHost: async () => NOT_HERE,
    removeHost: async () => NOT_HERE,
    installPlxd: async () => NOT_HERE,
    discoverLan: async () => NOT_HERE,
    pairLan: async () => NOT_HERE,

    onConnect: (listener) => (listener({ icon: "laptop", channel: "stable" }), () => {}),
    installConnect: async () => NOT_HERE,
    setConnect: async () => NOT_HERE,
    onDevices: (listener) => (listener([]), () => {}),
    saveDevice: async () => NOT_HERE,
    setDeviceEnabled: async () => {},
    removeDevice: async () => {},

    acpRegistry: async () => NOT_HERE,

    // Shells in a host's folder run in plxd, as in the app. Sign-ins and installs pick a command
    // to run, which only the app does.
    async openTerminal(id, target, cols, rows) {
      if (target.hostId !== LOCAL || !("path" in target)) return NOT_HERE;
      const cwd = target.path;
      return host.openTerminal({
        threadId: target.threadId ?? "",
        terminalId: id,
        cwd,
        cols,
        rows,
      });
    },
    install: async () => NOT_HERE,
    terminalInput: (id, data) => {
      const params = host.terminals.get(id);
      if (params)
        host.notify("terminal/write", { threadId: params.threadId, terminalId: id, data });
    },
    resizeTerminal: (id, cols, rows) => {
      const params = host.terminals.get(id);
      if (!params) return;
      host.terminals.set(id, { ...params, cols, rows });
      host.notify("terminal/resize", { threadId: params.threadId, terminalId: id, cols, rows });
    },
    closeTerminal: (id) => {
      const params = host.terminals.get(id);
      host.terminals.delete(id);
      if (params) host.send("terminal/close", { threadId: params.threadId, terminalId: id });
    },
    // A shell nobody shows keeps running in plxd, which stops streaming it here.
    onTerminal(id, listener) {
      host.terminalListeners.set(id, listener);
      return () => {
        if (host.terminalListeners.get(id) !== listener) return;
        host.terminalListeners.delete(id);
        const params = host.terminals.get(id);
        host.terminals.delete(id);
        if (params) host.notify("terminal/detach", { threadId: params.threadId, terminalId: id });
      };
    },

    openTargets: async () => [],
    openTargetIcons: async () => ({}),
    openFolder: async () => {},
    terminalApp: async () => null,
    chooseTerminalApp: async () => null,

    onProfile: (listener) => (listener(null), () => {}),
    signIn: async () => NOT_HERE,
    saveName: async () => NOT_HERE,
    signOut: async () => {},
    storage: async () => [],
    showFolder: async () => {},
    clearCache: async () => {},
  };
}
