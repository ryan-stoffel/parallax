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
  type SubscriptionId,
  type ParallaxRequests,
} from "../protocol/generated/protocol";
import type {
  ConnectionError,
  ConnectionState,
  HostResponse,
  RpcError,
  SubscribeParams,
  SubscriptionMessage,
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
 * The command that reaches an SSH host's plxd (0007, 0022). The destination was checked when it
 * was saved (`checkHost`), and `--` keeps ssh from reading it as an option. `ssh` is the program,
 * which a setting can override (0023).
 */
// prettier-ignore
export const sshCommand = (destination: string, ssh = "ssh") => [
  ssh, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlPath=none",
  "--", destination, "plxd", "attach",
];

export type ConnectionOptions = {
  /**
   * The program and arguments that run `plxd attach`, or undefined if plxd can't be found.
   * Asked again on every attempt.
   */
  command: () => string[] | undefined;
  /** An SSH host's destination, which its errors name. Undefined for this computer. */
  destination?: string;
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
      if (child === this.child) this.end(exitError(code, signal, stderr, destination));
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

  private onNotification(method: string, params: unknown): void {
    if (method === "events/resync") {
      // plxd already dropped it; its owner reloads its snapshot and subscribes again.
      const { subscription: id } = params as EventsResyncParams;
      for (const subscription of this.subscriptions) {
        if (subscription.id === id) return this.endSubscription(subscription, { type: "resync" });
      }
      return;
    }
    if (method !== "events/event") return;
    const event = params as EventsEventParams;
    for (const subscription of this.subscriptions) {
      if (subscription.id !== event.subscription) continue;
      if (event.seq <= subscription.params.after) return; // Already seen.
      subscription.params.after = event.seq;
      subscription.listener({ type: "event", event });
      return;
    }
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
 * Why `plxd attach` exited (0010), or ssh for the host at `destination` (0022), in words that
 * say what to do. ssh exits 255 for its own errors, and the remote shell 127 for a missing
 * command. The raw stderr rides along for the tooltip.
 */
export function exitError(
  code: number | null,
  signal: string | null,
  stderr: string,
  destination?: string,
  platform = process.platform,
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
      const agent =
        platform === "win32" ? "start the ssh-agent service, then run `ssh-add`" : "run `ssh-add`";
      return error(
        "sshSetup",
        `ssh couldn't log in to ${destination} without a prompt. If your key has a passphrase, ${agent}. Otherwise, ${inTerminal}.`,
      );
    }
    // cmd.exe, on a Windows host, exits 1.
    if (code === 127 || /not recognized as an internal or external command/.test(stderr)) {
      return error(
        "notFound",
        `plxd isn't on ${destination}'s PATH for ssh commands. Install it there, or add its folder to PATH in the shell file that ssh commands read.`,
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
