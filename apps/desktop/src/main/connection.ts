import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  ErrorCodes,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type EventsEventParams,
  type EventsResyncParams,
  type EventsSubscribeParams,
  type IncompatibleProtocolDetail,
  type InitializeResult,
  type LogId,
  type SubscribeShellResult,
  type SubscribeThreadResult,
  type SubscriptionId,
  type ParallaxRequests,
  type TerminalExitParams,
  type TerminalKey,
  type TerminalOpenParams,
  type TerminalOutputParams,
} from "../protocol/generated/protocol";
import type {
  ConnectionError,
  ConnectionState,
  HostResponse,
  RpcError,
  RpcResponse,
  SubscribeParams,
  SubscriptionMessage,
  TerminalMessage,
  WatchMessage,
  WatchParams,
} from "../preload/bridge";
import { RpcClient } from "./rpc";

// 0007's client rules.
export const HEARTBEAT_MS = 30_000;
export const LIVENESS_MS = 10_000;
// `attach` may spend its 10 s connect timeout starting plxd before it forwards `initialize`.
export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 30_000;

/** Methods that keep a command receipt (0052). */
const RECEIPTED_METHODS = new Set([
  "agent/approve",
  "agent/commit",
  "agent/push",
  "agent/openPr",
  "agent/resumeNow",
  "queue/cancel",
  "queue/steer",
  "question/ask",
  "question/answer",
  "question/escalate",
  "land/queue",
  "land/approve",
  "land/sendBack",
  "project/start",
  "project/delete",
  "thread/delete",
  "orchestration/dispatch",
]);

/** Mutating methods get one commandId per logical request, including its transport retry. */
const MUTATING_METHODS = new Set([
  ...RECEIPTED_METHODS,
  "agent/start",
  "agent/send",
  "agent/cancel",
  "agent/accept",
  "agent/requestChanges",
  "agent/autoResume",
  "thread/start",
  "thread/fork",
  "thread/archive",
  "thread/update",
  "thread/delete",
  "project/create",
  "project/update",
  "project/fromThreads",
  "inbox/seen",
  "pr/link",
  "pr/unlink",
  "queue/edit",
  "queue/reorder",
  "accounts/defaults/set",
  "accounts/keys/add",
  "accounts/keys/remove",
  "accounts/refresh",
  "host/settings/set",
  "repo/add",
  "repo/update",
  "context/write",
  "memory/write",
  "memory/delete",
  "memory/propose",
  "providers/save",
  "providers/remove",
  "github/install",
  "github/signIn",
  "github/signInCancel",
  "pr/act",
]);

/** The wait before reconnect attempt `failures + 1`: 1 s, doubling, capped at 10 s. */
export const backoffMs = (failures: number) => Math.min(1000 * 2 ** failures, 10_000);

/**
 * Runs `plxd attach` on a macOS or Linux host from `~/.parallax-plxd`, where the app installs plxd
 * at its own version (`installPlxd`, PLX-642); else from PATH, where it may have been added since;
 * else from where Parallax and plx-connect put plxd (PLX-580): `~/.local/bin`, or inside the app
 * in `/Applications` or `~/Applications`, either channel. A computer with Parallax from the dmg
 * has no plxd on PATH. Exits 127 when none is there. It's one argument to ssh, which the host's
 * login shell runs.
 */
export const LOCATE_PLXD = `sh -c '[ -x "$HOME/.parallax-plxd/plxd" ] && exec "$HOME/.parallax-plxd/plxd" attach; command -v plxd >/dev/null && exec plxd attach; for p in "$HOME/.local/bin/plxd" "/Applications/Parallax.app/Contents/Resources/plxd" "/Applications/Parallax (Nightly).app/Contents/Resources/plxd" "$HOME/Applications/Parallax.app/Contents/Resources/plxd" "$HOME/Applications/Parallax (Nightly).app/Contents/Resources/plxd"; do [ -x "$p" ] && exec "$p" attach; done; exit 127'`;

/**
 * Where a host's Sign in (0007) leaves its ssh master: a Unix socket named by ssh's `%C`, a hash of
 * the connection's host, port, and user, so each host gets its own. A socket path can't pass about
 * 104 bytes on macOS, and ssh adds 17 while binding, so it stays in `~/.ssh` with a short name
 * rather than the temp folder, which is longer on macOS.
 */
export const SSH_CONTROL_PATH = "~/.ssh/parallax-%C";

/**
 * The ssh command that runs `remote` on an SSH host (0007, 0022): by default `plxd attach` on its
 * PATH, or `[LOCATE_PLXD]`. The destination was checked when it was saved (`checkHost`), and `--`
 * keeps ssh from reading it as an option. `ssh` is the program, which a setting can override
 * (0023).
 * - Never prompts (`BatchMode`), so a password or 2FA host connects only through the master its
 *   Sign in left at `SSH_CONTROL_PATH`. With no master, or a dead one, ssh connects directly.
 * - Windows' OpenSSH has no ControlMaster, so it never shares a connection.
 */
export const sshCommand = (
  destination: string,
  ssh = "ssh",
  remote = ["plxd", "attach"],
  platform = process.platform,
) => [
  ssh,
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  ...(platform === "win32"
    ? ["-o", "ControlPath=none"]
    : ["-o", "ControlMaster=no", "-o", `ControlPath=${SSH_CONTROL_PATH}`]),
  "--",
  destination,
  ...remote,
];

export type ConnectionOptions = {
  /**
   * The program and arguments that run `plxd attach`, or undefined if plxd can't be found.
   * Asked again on every attempt.
   */
  command: () => string[] | undefined;
  /** An SSH host's destination, which its errors name. Undefined for this computer. */
  destination?: string;
  /** A Parallax Connect device's name, reached with `plxd dial` (0056), which its errors name. */
  device?: string;
  /** A LAN computer's name, reached with `plxd dial --remote` (PLX-641), which its errors name. */
  lan?: string;
  /** The app's version, sent in `initialize`. */
  clientVersion: string;
  onState: (state: ConnectionState) => void;
  /** Starts `plxd attach`. Tests pass a fake. */
  spawn?: (file: string, args: string[]) => ChildProcessWithoutNullStreams;
};

type Subscription = {
  /** `after` advances with every event, so a reconnect resumes from the last `seq`. */
  params: EventsSubscribeParams;
  /** The log `params.after` counts in. */
  logId: LogId;
  listener: (message: SubscriptionMessage) => void;
  /** plxd's id for it on the current connection. */
  id?: SubscriptionId;
};

/**
 * An `orchestration/subscribeShell` or `subscribeThread` (0059): a snapshot, then its events. A
 * reconnect or a resync subscribes again after the last `seq` delivered, which plxd answers by
 * replaying a short gap or with a fresh snapshot.
 */
type Watch = {
  params: WatchParams;
  listener: (message: WatchMessage) => void;
  /** The last `seq` delivered, in log `logId`. */
  seq?: number;
  logId?: LogId;
  /** plxd's id for it on the current connection. */
  id?: SubscriptionId;
};

/** A terminal plxd runs, as this connection opened it, and who shows it. */
type Terminal = { params: TerminalOpenParams; listeners: Set<(message: TerminalMessage) => void> };

/** A terminal's key in `Connection.terminals`. */
const terminalKey = ({ threadId, terminalId }: TerminalKey) => `${threadId}\n${terminalId}`;

/**
 * One host's connection: a `plxd attach` child speaking JSON-RPC over its stdio, kept alive
 * with heartbeats and reconnected with backoff when it ends. The main process makes one per
 * host id.
 */
export class Connection {
  state: ConnectionState = { status: "connecting" };
  private child?: ChildProcessWithoutNullStreams;
  private client?: RpcClient;
  private logId?: LogId;
  private failures = 0;
  private retryTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private livenessTimer?: NodeJS.Timeout;
  private readonly subscriptions = new Set<Subscription>();
  private readonly watches = new Set<Watch>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly reconnectWaiters = new Set<() => void>();

  constructor(private readonly options: ConnectionOptions) {}

  start(): void {
    this.connect();
  }

  /** Reconnects now if the connection failed, whether or not it would retry by itself. */
  retry(): void {
    if (this.state.status !== "failed") return;
    this.failures = 0;
    this.connect();
  }

  /** Stops for good: kills the child and drops every subscription. */
  dispose(): void {
    this.subscriptions.clear();
    this.watches.clear();
    this.teardown();
    for (const done of this.reconnectWaiters) done();
  }

  request<M extends keyof ParallaxRequests>(
    method: M,
    params: ParallaxRequests[M]["params"],
  ): Promise<HostResponse<ParallaxRequests[M]["result"]>> {
    const { client, logId } = this;
    if (this.state.status !== "connected" || !client || logId === undefined) {
      return Promise.resolve({
        error: { code: ErrorCodes.InternalError, message: "not connected" },
      });
    }
    const outgoing = withCommandId(method, params);
    // Keep each attempt's log id with its response.
    return client.request(method, outgoing, REQUEST_TIMEOUT_MS).then(async (first) => {
      let response = first;
      let responseLogId = logId;
      if (RECEIPTED_METHODS.has(method) && "error" in first) {
        // Retry only transport failures, once, within this logical request.
        const retryClient =
          this.client !== client
            ? await this.afterReconnect()
            : first.error.code === ErrorCodes.RequestCancelled
              ? client
              : undefined;
        if (retryClient && this.logId !== undefined) {
          responseLogId = this.logId;
          response = await retryClient.request(method, outgoing, REQUEST_TIMEOUT_MS);
        }
      }
      return "result" in response ? { ...response, logId: responseLogId } : response;
    });
  }

  private afterReconnect(): Promise<RpcClient | undefined> {
    if (this.state.status === "connected") return Promise.resolve(this.client);
    if (this.state.status === "failed" && !this.state.retrying) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.reconnectWaiters.delete(done);
        resolve(this.state.status === "connected" ? this.client : undefined);
      };
      const timer = setTimeout(done, REQUEST_TIMEOUT_MS);
      this.reconnectWaiters.add(done);
    });
  }

  /**
   * See `ParallaxBridge.subscribe`. The listener may get a `resync` before this returns.
   * Returns the unsubscribe function.
   */
  subscribe({ logId, ...params }: SubscribeParams, listener: Subscription["listener"]): () => void {
    const subscription: Subscription = { params, logId, listener };
    this.subscriptions.add(subscription);
    if (this.state.status === "connected") this.sendSubscribe(subscription);
    return () => {
      if (this.subscriptions.delete(subscription) && subscription.id) {
        this.client?.send(
          "events/unsubscribe",
          { subscription: subscription.id },
          REQUEST_TIMEOUT_MS,
          ignore,
        );
      }
    };
  }

  /** See `ParallaxBridge.watch`. Returns the function that ends it. */
  watch(params: WatchParams, listener: Watch["listener"]): () => void {
    const watch: Watch = { params, listener };
    this.watches.add(watch);
    if (this.state.status === "connected") this.sendWatch(watch);
    return () => {
      if (this.watches.delete(watch) && watch.id) {
        this.client?.send(
          "events/unsubscribe",
          { subscription: watch.id },
          REQUEST_TIMEOUT_MS,
          ignore,
        );
      }
    };
  }

  /**
   * Passes what plxd's terminal `params` prints, and its exit, to `listener` (PLX-637). After a
   * reconnect, a shell is opened again, which replays what it printed; a command ends with the
   * connection, as plxd ends it. Returns the function that stops listening, which, for the last
   * listener, stops plxd streaming it here and leaves it running (PLX-664).
   */
  attachTerminal(params: TerminalOpenParams, listener: (message: TerminalMessage) => void) {
    const key = terminalKey(params);
    let terminal = this.terminals.get(key);
    if (!terminal) this.terminals.set(key, (terminal = { params, listeners: new Set() }));
    terminal.params = params;
    terminal.listeners.add(listener);
    return () => {
      terminal.listeners.delete(listener);
      if (!terminal.listeners.size && this.terminals.get(key) === terminal) {
        this.terminals.delete(key);
        this.detachUnshown(params);
      }
    };
  }

  /**
   * Stops plxd streaming terminal `key` here if nothing listens to it, as when its last listener
   * left while it was being opened. It keeps running.
   */
  private detachUnshown({ threadId, terminalId }: TerminalKey): void {
    if (this.terminals.has(terminalKey({ threadId, terminalId }))) return;
    this.client?.notify("terminal/detach", { threadId, terminalId });
  }

  /** Opens plxd's terminal `params`. Resolves to an error for people, or undefined once it runs. */
  async openTerminal(params: TerminalOpenParams): Promise<string | undefined> {
    if (this.state.status === "connected" && !this.state.capabilities["terminals"]) {
      return "This host's plxd is too old to run terminals. Update Parallax there.";
    }
    const answer = await this.request("terminal/open", params);
    if ("error" in answer) return answer.error.message;
    this.detachUnshown(params);
    return undefined;
  }

  /** Types `data` into a terminal, in order with what was typed before. */
  writeTerminal(key: TerminalKey, data: string): void {
    this.client?.notify("terminal/write", { ...key, data });
  }

  resizeTerminal(key: TerminalKey, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalKey(key));
    if (terminal) terminal.params = { ...terminal.params, cols, rows };
    this.client?.notify("terminal/resize", { ...key, cols, rows });
  }

  /** Ends a terminal, killing what runs in it. Its exit reaches its listeners. */
  closeTerminal(key: TerminalKey): void {
    this.client?.send("terminal/close", key, REQUEST_TIMEOUT_MS, ignore);
  }

  /**
   * Sends `host/health`. If nothing is received in the next 10 s, the child is killed and the
   * connection reconnects. Runs every 30 s, and the main process calls it on wake.
   */
  heartbeat(): void {
    if (this.state.status !== "connected" || !this.client) return;
    this.client.send("host/health", {}, REQUEST_TIMEOUT_MS, ignore);
    this.livenessTimer ??= setTimeout(
      () => this.end({ reason: "unresponsive", message: "plxd stopped answering" }),
      LIVENESS_MS,
    );
  }

  private connect(): void {
    clearTimeout(this.retryTimer);
    const [file, ...args] = this.options.command() ?? [];
    if (!file) {
      return this.fail({
        reason: "notFound",
        message: "plxd wasn't found. Set PLXD_PATH to the plxd binary.",
      });
    }
    const { destination } = this.options;
    this.setState({ status: "connecting" });

    const child = (this.options.spawn ?? spawnAttach)(file, args);
    const client = new RpcClient((line) => child.stdin.write(line), {
      onNotification: (method, params) => this.onNotification(method, params),
      onFatal: (message) => this.end({ reason: "protocolError", message }),
      onBadLine: (line) => {
        if (child !== this.child) return;
        if (this.state.status === "connected") {
          return console.warn("plxd sent a line that isn't JSON:", line.slice(0, 200));
        }
        // attach writes nothing but plxd's frames to stdout, so this came from the host's shell
        // as it started, and would keep corrupting the handshake.
        this.end({
          reason: "sshSetup",
          message: destination
            ? `${destination}'s shell printed text before plxd started. Keep its startup files quiet for commands that aren't interactive.`
            : "plxd attach printed something that isn't plxd's protocol.",
          stderr: `stdout: ${line.slice(0, 200)}`,
        });
      },
    });
    this.child = child;
    this.client = client;

    let stderr = ""; // This run's, capped, so an earlier run's line is never reported.
    child.stdin.on("error", ignore); // EPIPE once attach exits; "close" reports that.
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (child !== this.child) return;
      // Any received byte, such as a long replay, proves plxd is alive.
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
      client.receive(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (child !== this.child) return;
      const missing = error.code === "ENOENT";
      let message = `${file} couldn't be started: ${error.message}`;
      if (missing && destination) {
        message =
          process.platform === "win32"
            ? "ssh wasn't found. Add OpenSSH Client in Settings > System > Optional features."
            : "ssh wasn't found. Install OpenSSH.";
      }
      this.end({ reason: missing ? "notFound" : "exited", message });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (child === this.child)
        this.end(
          exitError(
            code,
            signal,
            stderr,
            destination,
            process.platform,
            this.options.device,
            this.options.lan,
          ),
        );
    });

    client.send(
      "initialize",
      {
        protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
        client: { name: "parallax", version: this.options.clientVersion },
        // A subscription that falls behind ends with `events/resync`, not the connection.
        capabilities: { resyncNotice: {} },
      },
      HANDSHAKE_TIMEOUT_MS,
      (response) => {
        if (child !== this.child) return;
        if ("error" in response) return this.end(handshakeError(response.error));
        this.onInitialized(client, response.result);
      },
    );
  }

  private onInitialized(client: RpcClient, result: InitializeResult): void {
    client.maxFrameBytes = Math.min(MAX_FRAME_BYTES, result.maxFrameBytes);
    this.logId = result.logId;
    this.failures = 0;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.setState({
      status: "connected",
      plxd: result.plxd,
      protocol: result.protocol,
      capabilities: result.capabilities,
    });
    for (const done of this.reconnectWaiters) done();
    for (const subscription of this.subscriptions) this.sendSubscribe(subscription);
    for (const watch of this.watches) this.sendWatch(watch);
    for (const [key, terminal] of this.terminals) {
      client.send("terminal/open", terminal.params, REQUEST_TIMEOUT_MS, (response) => {
        if ("error" in response) this.endTerminal(key, -1);
        else this.detachUnshown(terminal.params);
      });
    }
  }

  private sendSubscribe(subscription: Subscription): void {
    // A new log numbers its events from scratch, so a `seq` from another log is meaningless.
    if (subscription.logId !== this.logId) {
      return this.endSubscription(subscription, { type: "resync" });
    }
    const client = this.client;
    // `send`'s callback runs before the next line is read, so the id is known before its events.
    client?.send("events/subscribe", subscription.params, REQUEST_TIMEOUT_MS, (response) => {
      // The connection ended; the next one resubscribes.
      if (client !== this.client) return;
      if (!this.subscriptions.has(subscription)) {
        // Unsubscribed while waiting.
        if ("result" in response) {
          client.send("events/unsubscribe", response.result, REQUEST_TIMEOUT_MS, ignore);
        }
        return;
      }
      if ("result" in response) subscription.id = response.result.subscription;
      else if (response.error.data?.kind === "resyncRequired") {
        this.endSubscription(subscription, { type: "resync" });
      } else this.endSubscription(subscription, { type: "error", error: response.error });
    });
  }

  private sendWatch(watch: Watch): void {
    const client = this.client;
    // A `seq` from another log is meaningless, so a new log starts from a snapshot.
    const afterSeq = watch.logId === this.logId ? watch.seq : undefined;
    const after = afterSeq === undefined ? {} : { afterSeq };
    watch.id = undefined;
    // `send`'s callback runs before the next line is read, so the id is known before its events.
    const answered = (response: RpcResponse<SubscribeShellResult | SubscribeThreadResult>) => {
      if (client !== this.client) return; // The next connection subscribes again.
      if (!this.watches.has(watch)) {
        if ("result" in response) {
          const { subscription } = response.result;
          client?.send("events/unsubscribe", { subscription }, REQUEST_TIMEOUT_MS, ignore);
        }
        return;
      }
      if ("error" in response) {
        this.watches.delete(watch);
        return watch.listener({ type: "error", error: response.error });
      }
      watch.id = response.result.subscription;
      const { snapshot } = response.result;
      if (!snapshot) return;
      watch.seq = snapshot.seq;
      watch.logId = this.logId;
      watch.listener({ type: "snapshot", snapshot });
    };
    if ("threadId" in watch.params) {
      const params = { threadId: watch.params.threadId, ...after };
      client?.send("orchestration/subscribeThread", params, REQUEST_TIMEOUT_MS, answered);
    } else client?.send("orchestration/subscribeShell", after, REQUEST_TIMEOUT_MS, answered);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "terminal/output") {
      const { data, replay, ...key } = params as TerminalOutputParams;
      const message: TerminalMessage = { type: replay ? "replay" : "data", data };
      for (const listener of this.terminals.get(terminalKey(key))?.listeners ?? []) {
        listener(message);
      }
      return;
    }
    if (method === "terminal/exit") {
      const { exitCode, ...key } = params as TerminalExitParams;
      return this.endTerminal(terminalKey(key), exitCode);
    }
    if (method === "events/resync") {
      // plxd already dropped it; its owner reloads its snapshot and subscribes again.
      const { subscription: id } = params as EventsResyncParams;
      for (const subscription of this.subscriptions) {
        if (subscription.id === id) return this.endSubscription(subscription, { type: "resync" });
      }
      // A watch subscribes again after its last `seq`, which replays or snapshots.
      for (const watch of this.watches) if (watch.id === id) return this.sendWatch(watch);
      return;
    }
    if (method !== "events/event") return;
    const event = params as EventsEventParams;
    for (const watch of this.watches) {
      if (watch.id !== event.subscription) continue;
      if (watch.seq !== undefined && event.seq <= watch.seq) return; // Already seen.
      watch.seq = event.seq;
      watch.listener({ type: "event", event });
      return;
    }
    for (const subscription of this.subscriptions) {
      if (subscription.id !== event.subscription) continue;
      if (event.seq <= subscription.params.after) return; // Already seen.
      subscription.params.after = event.seq;
      subscription.listener({ type: "event", event });
      return;
    }
  }

  private endTerminal(key: string, exitCode: number): void {
    const terminal = this.terminals.get(key);
    this.terminals.delete(key);
    for (const listener of terminal?.listeners ?? []) listener({ type: "exit", exitCode });
  }

  private endSubscription(subscription: Subscription, message: SubscriptionMessage): void {
    this.subscriptions.delete(subscription);
    subscription.listener(message);
  }

  /** Ends the current connection, then retries with backoff unless the error needs the user. */
  private end(error: ConnectionError): void {
    this.teardown();
    this.fail(error);
  }

  private fail(error: ConnectionError): void {
    // These can't fix themselves: the binary is missing or incompatible, rejects `attach`'s
    // arguments (exit 2, a usage error), or the host needs setting up.
    const retrying =
      error.reason !== "notFound" &&
      error.reason !== "incompatibleProtocol" &&
      error.reason !== "sshSetup" &&
      error.reason !== "refused" &&
      error.exitCode !== 2;
    this.setState({ status: "failed", error, retrying });
    if (retrying) this.retryTimer = setTimeout(() => this.connect(), backoffMs(this.failures++));
  }

  private teardown(): void {
    const { child, client } = this;
    // Cleared first, so the callbacks that follow see a connection that already ended.
    this.child = undefined;
    this.client = undefined;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.livenessTimer);
    this.livenessTimer = undefined;
    client?.close("the connection to plxd ended");
    for (const subscription of this.subscriptions) subscription.id = undefined;
    // plxd ends a command with the connection that opened it.
    for (const [key, terminal] of this.terminals) {
      if (terminal.params.command) this.endTerminal(key, -1);
    }
    child?.kill();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onState(state);
  }
}

function withCommandId<M extends keyof ParallaxRequests>(
  method: M,
  params: ParallaxRequests[M]["params"],
): ParallaxRequests[M]["params"] {
  if (!MUTATING_METHODS.has(method)) return params;
  return { ...(params as object), commandId: crypto.randomUUID() } as ParallaxRequests[M]["params"];
}

function spawnAttach(file: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(file, args, { stdio: "pipe", windowsHide: true });
}

const ignore = () => {};

/**
 * Why `plxd attach` exited (0010), ssh for the host at `destination` (0022), or `plxd dial` for
 * the Connect device named `device` (0056) or the LAN computer named `lan` (PLX-641), in words
 * that say what to do. ssh exits 255 for its
 * own errors, and the remote shell 127 for a missing command. The raw stderr rides along for the
 * tooltip.
 */
export function exitError(
  code: number | null,
  signal: string | null,
  stderr: string,
  destination?: string,
  platform = process.platform,
  device?: string,
  lan?: string,
): ConnectionError {
  const details = { exitCode: code, ...(stderr.trim() && { stderr: stderr.trim() }) };
  const error = (reason: ConnectionError["reason"], message: string): ConnectionError => ({
    reason,
    message,
    ...details,
  });
  if (destination !== undefined) {
    const inTerminal = `run \`ssh ${destination}\` once in a terminal`;
    if (code === 255 && stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")) {
      return error(
        "sshSetup",
        `${destination}'s host key has changed. If you expected that, remove its old key from known_hosts, then ${inTerminal}.`,
      );
    }
    if (code === 255 && stderr.includes("Host key verification failed")) {
      return error(
        "sshSetup",
        `${destination}'s host key isn't trusted yet. To accept it, ${inTerminal}.`,
      );
    }
    if (code === 255 && stderr.includes("Permission denied")) {
      // With BatchMode, a key whose passphrase isn't in an agent is skipped without a word.
      if (platform === "win32") {
        return error(
          "sshSetup",
          `ssh couldn't log in to ${destination} without a prompt. If your key has a passphrase, start the ssh-agent service, then run \`ssh-add\`. Otherwise, ${inTerminal}.`,
        );
      }
      return error(
        "sshSetup",
        `ssh couldn't log in to ${destination} without a prompt. If it needs a password, press Sign in. If your key has a passphrase, run \`ssh-add\`.`,
      );
    }
    // cmd.exe, on a Windows host, exits 1.
    if (code === 127 || /not recognized as an internal or external command/.test(stderr)) {
      return error(
        "notFound",
        `Parallax couldn't find plxd on ${destination}: it isn't on PATH for ssh commands, in ~/.local/bin, or in a Parallax app in Applications. Install plxd from Settings > Connections, or add plxd's folder to PATH in the shell file that ssh commands read.`,
      );
    }
    if (code === 255 && stderr.includes("Could not resolve hostname")) {
      return error("exited", `Couldn't find ${destination}. Check its name, or your ssh config.`);
    }
    if (code === 255) {
      return error("exited", `Couldn't reach ${destination}. Check that it's on and accepts ssh.`);
    }
    if (code === 4) return error("exited", `plxd couldn't be reached or started on ${destination}`);
  }
  if (lan !== undefined && code === 4)
    return error(
      "exited",
      `Couldn't reach ${lan} on this network. Check that it's on, on the same network, and that Same network is on there.`,
    );
  if (lan !== undefined && code === 5)
    return error(
      "refused",
      `${lan} doesn't know this computer anymore. Remove it, then pair again with a new code.`,
    );
  if (device !== undefined && code === 4)
    return error(
      "exited",
      `Couldn't reach ${device} over Tailscale. Check that it's on, and that Parallax Connect is on there.`,
    );
  // plxd closes a connection from another Tailscale user before it answers.
  if (device !== undefined && code === 0)
    return error(
      "exited",
      `${device} closed the connection. If it keeps happening, check that it's signed in to your Tailscale account.`,
    );
  if (code === 127) return error("notFound", "plxd isn't installed");
  const message =
    code === 4
      ? "plxd couldn't be reached or started"
      : code === 2
        ? "plxd attach rejected its arguments. Update plxd."
        : `plxd attach exited with ${code ?? signal}`;
  return error("exited", message);
}

function handshakeError(error: RpcError): ConnectionError {
  if (error.data?.kind !== "incompatibleProtocol") {
    return { reason: "protocolError", message: `initialize failed: ${error.message}` };
  }
  const detail = error.data.detail as IncompatibleProtocolDetail | undefined;
  const update =
    detail && detail.supported.max < PROTOCOL_VERSION ? "Update plxd." : "Update the app.";
  return {
    reason: "incompatibleProtocol",
    message: `${error.message}. ${update}`,
    ...(detail && { plxd: detail.plxd }),
  };
}
