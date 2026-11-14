// The web client's `window.parallax` (PLX-651, 0065): the preload API for a browser that plxd
// served, over that plxd's `/ws` WebSocket with the session this browser paired for. Its one host
// is that plxd, as `local`. What only the desktop app can do (other hosts, the updater, editors,
// file pickers, the account) answers empty or with an error for people.
//
// It imports no runtime code from the renderer, so the desktop app's chunks stay as they are.

import i18next from "i18next";

import type {
  ConnectionState,
  DeviceStreamMessage,
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
  DeviceDataParams,
  DeviceEndParams,
  DeviceStreamParams,
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
import {
  capabilitiesFromLegacy,
  CLIENT_CAPABILITY,
  errorFromLegacy,
  eventFromLegacy,
  isLegacy,
  requestToLegacy,
  resultFromLegacy,
} from "../protocol/legacyNames";
import { UpdateNotice } from "../protocol/updateNotice";
import type { ConnectionLog, DisconnectReason } from "../protocol/connectionLog";

// The generated protocol's, copied so this chunk shares nothing with the app's (webBridge.test.ts).
export const PROTOCOL_VERSION = 1;
export const INTERNAL_ERROR = -32603;
export const INVALID_PARAMS = -32602;

const LOCAL = "local";
// 0007's client rules, as connection.ts has them.
const HEARTBEAT_MS = 30_000;
const LIVENESS_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Marks text for `i18next-cli extract`, as ../i18n's `msg` does, which this chunk doesn't import.
const msg = <T extends string>(text: T): T => text;

/**
 * `text` marked with `msg`, in the app's language with `values` in it. Before the app sets up
 * i18next, as on a first connect, it reads as written.
 */
const say = (text: string, values: Record<string, string | number> = {}) =>
  i18next.isInitialized
    ? i18next.t(text, values)
    : text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]));

const notHere = () => say(msg("Only the desktop app can do this."));

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
  if (!response) return { error: say(msg("Couldn't reach Parallax on this computer.")) };
  const answer = (await response.json().catch(() => ({}))) as { ticket?: string; error?: string };
  if (answer.ticket) return { ticket: answer.ticket };
  if (answer.error === "invalid_token") return { error: "revoked" };
  if (answer.error === "access_denied")
    return {
      error: say(msg("Open in a browser is off on this computer. Turn it on there to continue.")),
    };
  if (response.status === 401)
    return {
      error: say(
        msg("Parallax refused this browser's proof. Check that this device's clock is right."),
      ),
    };
  return {
    error: say(msg("Parallax couldn't connect ({{status}})."), { status: response.status }),
  };
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
 * Opens plxd's `/ws` with a new ticket, or says why it can't: `revoked` only when plxd doesn't
 * know the session anymore, else an error for people.
 */
type OpenSocket = () => Promise<WebSocket | { error: string }>;

/** `OpenSocket` for this browser's `session`, to the plxd that served the page. */
export const openSocket =
  (session: Session): OpenSocket =>
  async () => {
    const answer = await ticket(session);
    if ("error" in answer) return answer;
    return new WebSocket(`wss://${location.host}/ws?wsTicket=${answer.ticket}`);
  };

/**
 * The connection to one plxd: JSON-RPC over `/ws`, one message per frame, kept alive with
 * heartbeats and reconnected with backoff, as connection.ts does for `plxd attach`. A revoked
 * session calls `signedOut`, which by default sends the page back to pairing. The mobile app
 * (apps/mobile) uses it too, with its own `open`.
 */
export class WebHost {
  state: ConnectionState = { status: "connecting" };
  readonly stateListeners = new Set<(hostId: string, state: ConnectionState) => void>();
  private socket?: WebSocket;
  private logId?: LogId;
  /** plxd is from before 0093, so requests and answers go through `legacyNames`. */
  private legacy = false;
  private nextId = 1;
  private failures = 0;
  private closed = false;
  private retryTimer?: number;
  private heartbeatTimer?: number;
  private livenessTimer?: number;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly watches = new Set<Watch>();
  /** The subscriptions and watches sent behind this socket's `initialize` (PLX-1480). */
  private readonly early = new Set<Subscription | Watch>();
  /** `initialize` is sent and unanswered, and what opens now goes right behind it (PLX-1480). */
  private pipelining = false;
  private readonly updateNotice = new UpdateNotice(() => {
    if (this.state.updating) this.setState(this.state);
  });
  /** The terminals opened, by the id the renderer gave, which is plxd's `terminalId` too. */
  readonly terminals = new Map<string, TerminalOpenParams>();
  /** Who shows each terminal, by its id. */
  readonly terminalListeners = new Map<string, (message: TerminalMessage) => void>();
  /** Who gets each device stream's messages (PLX-886), by its id. */
  readonly deviceStreams = new Map<string, (message: DeviceStreamMessage) => void>();

  /** `log` keeps its connection events: the mobile app's Connection log. A browser has none. */
  constructor(
    private readonly open: OpenSocket,
    private readonly signedOut = async () => {
      await forget();
      location.reload();
    },
    private readonly log?: ConnectionLog,
  ) {}

  async connect(): Promise<void> {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.log?.attempt();
    this.setState({ status: "connecting" });
    const socket = await this.open();
    // Closed while it opened: the socket it got goes too.
    if (this.closed) {
      if (!("error" in socket)) socket.close();
      return;
    }
    if ("error" in socket) {
      if (socket.error !== "revoked") return this.fail(socket.error);
      return this.signedOut();
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
      this.receive(String(event.data));
    };
    socket.onclose = () => {
      if (socket === this.socket)
        this.end(say(msg("The connection to Parallax ended.")), "transport_closed");
    };
    socket.onopen = () => {
      const capabilities = { resyncNotice: {}, [CLIENT_CAPABILITY]: {} };
      const client = { name: "parallax-web", version: "web" };
      const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION };
      this.send("initialize", { protocol, client, capabilities }, (response) => {
        if (socket !== this.socket) return;
        if ("error" in response)
          return this.end(
            say(msg("initialize failed: {{error}}"), { error: response.error.message }),
            "protocol_error",
          );
        this.initialized(response.result as InitializeResult);
      });
      // Behind `initialize`, without waiting for its answer, which saves a round trip (PLX-1480).
      // plxd reads a connection's requests in order until `initialize` succeeds and refuses any
      // before it, so these see the session or make nothing. Each answer, after `initialize`'s,
      // checks the log it assumed. Those opened before `initialize` answers go the same way, so
      // a cold connect's first watches save it too.
      this.pipelining = true;
      for (const subscription of this.subscriptions) this.sendSubscribe(subscription, true);
      for (const watch of this.watches) this.sendWatch(watch, true);
    };
  }

  request(method: string, params: unknown): Promise<HostResponse<unknown>> {
    const logId = this.logId;
    if (this.state.status !== "connected" || logId === undefined) {
      return Promise.resolve({
        error: { code: INTERNAL_ERROR, message: say(msg("not connected")) },
      });
    }
    // An emulator can take minutes to boot, past plxd's own 3 minute wait, and a cold Mac's
    // simulators over 30 seconds to list (PLX-886). `host/update`, which only the phone sends here,
    // downloads plxd before it answers, so it gets what the desktop's main gives it (PLX-1366).
    const timeout =
      method === "host/update"
        ? 15 * 60_000
        : method === "device/boot" || method === "device/state"
          ? 4 * 60_000
          : REQUEST_TIMEOUT_MS;
    // A plxd from before 0093 takes and answers the old names.
    const legacy = this.legacy;
    const [sent, outgoing] = legacy ? requestToLegacy(method, params) : [method, params];
    return new Promise((resolve) =>
      this.send(
        sent,
        outgoing,
        (response) => {
          if ("error" in response)
            return resolve(legacy ? { error: errorFromLegacy(response.error) } : response);
          const result = legacy ? resultFromLegacy(method, response.result) : response.result;
          resolve({ ...response, result, logId });
        },
        timeout,
      ),
    );
  }

  /** See `ParallaxBridge.subscribe`. */
  subscribe({ logId, ...params }: SubscribeParams, listener: Subscription["listener"]): () => void {
    const subscription: Subscription = { params, logId, listener };
    this.subscriptions.add(subscription);
    if (this.state.status === "connected") this.sendSubscribe(subscription);
    else if (this.pipelining) this.sendSubscribe(subscription, true);
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
    else if (this.pipelining) this.sendWatch(watch, true);
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

  /** See `ParallaxBridge.openDeviceStream`. */
  async openDeviceStream(
    params: DeviceStreamParams,
    listener: (message: DeviceStreamMessage) => void,
  ): Promise<string | undefined> {
    // Set first: plxd may relay the stream's first messages before it answers.
    this.deviceStreams.set(params.streamId, listener);
    const answer = await this.request("device/stream", params);
    if (!("error" in answer)) {
      // Closed while it opened: plxd hadn't listed it yet, so it takes the close now.
      if (this.deviceStreams.get(params.streamId) !== listener)
        this.notify("device/close", { streamId: params.streamId });
      return undefined;
    }
    if (this.deviceStreams.get(params.streamId) === listener)
      this.deviceStreams.delete(params.streamId);
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
      () => this.end(say(msg("Parallax stopped answering.")), "liveness_timeout"),
      LIVENESS_MS,
    );
  }

  /** Ends the connection for good, as the mobile app does for a computer it removes. */
  close(): void {
    this.closed = true;
    this.updateNotice.stop();
    clearTimeout(this.retryTimer);
    if (this.socket) this.end(say(msg("The connection was closed.")), "app_closed");
  }

  /** Reconnects now if the connection failed. */
  retry(): void {
    if (this.state.status !== "failed") return;
    this.failures = 0;
    void this.connect();
  }

  send(
    method: string,
    params: unknown,
    done?: Pending["done"],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      done?.({ error: { code: INTERNAL_ERROR, message: say(msg("not connected")) } });
      return;
    }
    const id = this.nextId++;
    if (done) {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        done({ error: { code: -32800, message: say(msg("{{method}} timed out"), { method }) } });
      }, timeoutMs);
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
    this.pipelining = false;
    this.logId = result.logId;
    this.failures = 0;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.legacy = isLegacy(result.capabilities);
    const { plxd, protocol } = result;
    const capabilities = this.legacy
      ? capabilitiesFromLegacy(result.capabilities)
      : result.capabilities;
    this.log?.connected(plxd, result.startId);
    this.setState({ status: "connected", plxd, protocol, capabilities });
    for (const subscription of this.subscriptions)
      if (!this.early.has(subscription)) this.sendSubscribe(subscription);
    for (const watch of this.watches) if (!this.early.has(watch)) this.sendWatch(watch);
    this.early.clear();
    // A shell opened again replays what it printed.
    for (const [id, params] of this.terminals) {
      this.send("terminal/open", params, (response) => {
        if ("error" in response) this.endTerminal(id, -1);
      });
    }
  }

  /** Sends `events/subscribe`. `early` sends it before `initialize` answered, so before the
   *  connection's log is known: the answer then checks it. */
  private sendSubscribe(subscription: Subscription, early = false): void {
    if (!early && subscription.logId !== this.logId) return this.endSubscription(subscription);
    if (early) this.early.add(subscription);
    const socket = this.socket;
    this.send("events/subscribe", subscription.params, (response) => {
      if (socket !== this.socket) return;
      // Unsubscribed while waiting, or sent early in another log: its events are dropped.
      const stale = subscription.logId !== this.logId;
      if (!this.subscriptions.has(subscription) || stale) {
        if ("result" in response) this.send("events/unsubscribe", response.result);
        if (stale && this.subscriptions.has(subscription)) this.endSubscription(subscription);
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

  /** Sends a watch's subscribe. `early` sends it before `initialize` answered, assuming the
   *  watch's log, and the answer checks it. */
  private sendWatch(watch: Watch, early = false): void {
    const socket = this.socket;
    // A `seq` from another log is meaningless, so a new log starts from a snapshot.
    const log = watch.logId;
    const afterSeq = log !== undefined && (early || log === this.logId) ? watch.seq : undefined;
    const after = afterSeq === undefined ? {} : { afterSeq };
    watch.id = undefined;
    if (early) this.early.add(watch);
    const answered = (response: RpcResponse<unknown>) => {
      if (socket !== this.socket) return;
      // Sent early after a `seq` in another log: dropped, and sent again for a snapshot.
      const stale = afterSeq !== undefined && log !== this.logId;
      if (!this.watches.has(watch) || stale) {
        if ("result" in response) this.send("events/unsubscribe", response.result);
        if (stale && this.watches.has(watch)) this.sendWatch(watch);
        return;
      }
      if ("error" in response) {
        this.watches.delete(watch);
        return watch.listener({ type: "error", error: response.error });
      }
      const answer = this.legacy
        ? resultFromLegacy("orchestration/subscribeShell", response.result)
        : response.result;
      const { subscription, snapshot } = answer as SubscribeShellResult | SubscribeThreadResult;
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
    if (method === "host/updating") return this.updateNotice.heard();
    if (method === "device/data") {
      const { streamId, data, text } = params as DeviceDataParams;
      const bytes = () => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      this.deviceStreams.get(streamId)?.({ type: "data", data: text ? data : bytes() });
      return;
    }
    if (method === "device/end") {
      const { streamId, error } = params as DeviceEndParams;
      const listener = this.deviceStreams.get(streamId);
      this.deviceStreams.delete(streamId);
      listener?.({ type: "end", error });
      return;
    }
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
    const event = eventFromLegacy(params as EventsEventParams);
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
  private end(message: string, reason: DisconnectReason): void {
    this.log?.disconnected(reason);
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
    this.pipelining = false;
    this.early.clear();
    for (const subscription of this.subscriptions) subscription.id = undefined;
    for (const watch of this.watches) watch.id = undefined;
    // plxd ends a command with the connection that opened it.
    for (const [id, params] of this.terminals) if (params.command) this.endTerminal(id, -1);
    // plxd closes a connection's device streams with it.
    const streams = [...this.deviceStreams.values()];
    this.deviceStreams.clear();
    for (const listener of streams) listener({ type: "end", error: message });
    this.fail(message);
  }

  private fail(message: string): void {
    this.setState({
      status: "failed",
      error: { reason: "exited", message },
      retrying: !this.closed,
    });
    if (this.closed) return;
    const wait = Math.min(1000 * 2 ** this.failures++, 10_000);
    this.retryTimer = window.setTimeout(() => void this.connect(), wait);
  }

  private setState(state: ConnectionState): void {
    this.state = this.updateNotice.mark(state);
    for (const listener of this.stateListeners) listener(LOCAL, this.state);
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
    firstRun: false,
    version: async () => (host.state.status === "connected" ? host.state.plxd : "web"),
    setThemeSource: () => {},
    setZoom: (factor) => void (document.documentElement.style.zoom = String(factor)),
    zoomed: () => {},
    onFullScreen: none,
    pickFolder: async () => null,
    listFolders: async () => ({ error: notHere() }),
    createRepo: async () => ({ error: notHere() }),
    copyPicture: () => Promise.reject(new Error(notHere())),
    // The web client has no webview, so no page asks anything.
    onBrowser: () => () => {},
    extensions: () => Promise.resolve([]),
    installExtension: () => Promise.resolve(notHere()),
    loadUnpackedExtension: () => Promise.resolve(notHere()),
    removeExtension: () => Promise.resolve(),
    onExtensionsChanged: () => () => {},
    selectBrowserTab: () => {},
    // A browser has no userData: its own localStorage count is the only record.
    claimSupportAsk: () => Promise.resolve(true),
    clearBrowsingData: () => Promise.resolve(),
    downloads: () => Promise.resolve([]),
    onDownloads: () => () => {},
    googleAccount: () => Promise.resolve(undefined),
    siteIcon: () => Promise.resolve(undefined),
    onGoogleAccount: () => () => {},
    downloadAction: () => {},
    setDownloadPrefs: () => {},
    updatable: false,
    locale: navigator.language,
    setLanguage: () => {},
    update: async () => notHere(),
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
    // A web client has only this host, whose plxd it doesn't update.
    onHostUpdate: () => () => {},
    retryHostUpdate: async () => {},
    updateHostNow: async () => {},

    hosts: async () => [],
    onHosts: none,
    sshSuggestions: async () => [],
    onLocalName: (listener) => (listener(name), () => {}),
    renameLocal: async () => notHere(),
    saveHost: async () => notHere(),
    removeHost: async () => notHere(),
    installPlxd: async () => notHere(),
    discoverLan: async () => notHere(),
    pairLan: async () => notHere(),
    registerRelay: async () => notHere(),
    relayHosts: async () => notHere(),
    removeRelayHost: async () => notHere(),
    checkRelay: async () => notHere(),

    onConnect: (listener) => (listener({ icon: "laptop", channel: "stable" }), () => {}),
    setConnect: async () => notHere(),
    onDevices: (listener) => (listener([]), () => {}),
    saveDevice: async () => notHere(),
    setDeviceEnabled: async () => {},
    removeDevice: async () => {},
    editRoutes: async () => undefined,
    discoverAccount: async () => {},
    enterSetupCode: async () => notHere(),
    showSetupCode: async () => notHere(),
    onSetupApproved: () => () => {},
    askAgain: async () => {},
    onKeyStanding: () => () => {},
    startOver: async () => notHere(),
    answerCompare: async () => notHere(),
    deviceKey: async () => undefined,
    onAccessRequests: (listener) => (listener([]), () => {}),
    answerAccess: async () => notHere(),
    revokeDevice: async () => notHere(),
    makeDeviceReadOnly: async () => notHere(),
    turnOnReach: async () => notHere(),

    acpRegistry: async () => notHere(),

    // Shells in a host's folder run in plxd, as in the app. Sign-ins and installs pick a command
    // to run, which only the app does.
    async openTerminal(id, target, cols, rows) {
      if (target.hostId !== LOCAL || !("path" in target)) return notHere();
      const cwd = target.path;
      return host.openTerminal({
        threadId: target.threadId ?? "",
        terminalId: id,
        cwd,
        cols,
        rows,
      });
    },
    install: async () => notHere(),
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

    openDeviceStream: async (hostId, params, listener) =>
      hostId === LOCAL ? host.openDeviceStream(params, listener) : notHere(),
    sendDeviceStream: (streamId, data) => {
      if (typeof data === "string") host.notify("device/send", { streamId, data, text: true });
      else {
        let binary = "";
        for (const byte of data) binary += String.fromCharCode(byte);
        host.notify("device/send", { streamId, data: btoa(binary) });
      }
    },
    closeDeviceStream: (streamId) => {
      if (host.deviceStreams.delete(streamId)) host.notify("device/close", { streamId });
    },

    openTargets: async () => [],
    openFolder: async () => undefined,
    sshDestination: async () => undefined,
    setSshDestination: async () => undefined,
    showFile: async () => notHere(),
    terminalApp: async () => null,
    terminalApps: async () => [],
    selectTerminalApp: async () => null,
    // A browser has no terminal of this computer's to put a command in.
    command: async () => ({ state: "unavailable" as const, path: "", onPath: true }),
    installCommand: async () => notHere(),
    removeCommand: async () => notHere(),

    onProfile: (listener) => (listener(null), () => {}),
    accountMoved: async () => false,
    onConnectNotice: () => () => {},
    onRelayUsage: () => () => {},
    signIn: async () => notHere(),
    editProfile: async () => {},
    signOut: async () => {},
    storage: async () => [],
    showFolder: async () => {},
    clearCache: async () => {},
  };
}
