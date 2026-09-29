import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  ErrorCodes,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type EventsEventParams,
  type EventsSubscribeParams,
  type IncompatibleProtocolDetail,
  type InitializeResult,
  type LogId,
  type SubscriptionId,
  type WispRequests,
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
// `attach` may spend its 10 s connect timeout starting wispd before it forwards `initialize`.
export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 30_000;

/** The wait before reconnect attempt `failures + 1`: 1 s, doubling, capped at 10 s. */
export const backoffMs = (failures: number) => Math.min(1000 * 2 ** failures, 10_000);

/**
 * The command that reaches an SSH host's wispd (0007, 0022). The destination was checked when it
 * was saved (`checkHost`), and `--` keeps ssh from reading it as an option. `ssh` is the program,
 * which a setting can override (0023).
 */
// prettier-ignore
export const sshCommand = (destination: string, ssh = "ssh") => [
  ssh, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlPath=none",
  "--", destination, "wispd", "attach",
];

export type ConnectionOptions = {
  /**
   * The program and arguments that run `wispd attach`, or undefined if wispd can't be found.
   * Asked again on every attempt.
   */
  command: () => string[] | undefined;
  /** An SSH host's destination, which its errors name. Undefined for this computer. */
  destination?: string;
  /** The app's version, sent in `initialize`. */
  clientVersion: string;
  onState: (state: ConnectionState) => void;
  /** Starts `wispd attach`. Tests pass a fake. */
  spawn?: (file: string, args: string[]) => ChildProcessWithoutNullStreams;
};

type Subscription = {
  /** `after` advances with every event, so a reconnect resumes from the last `seq`. */
  params: EventsSubscribeParams;
  /** The log `params.after` counts in. */
  logId: LogId;
  listener: (message: SubscriptionMessage) => void;
  /** wispd's id for it on the current connection. */
  id?: SubscriptionId;
};

/**
 * One host's connection: a `wispd attach` child speaking JSON-RPC over its stdio, kept alive
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
  }

  request<M extends keyof WispRequests>(
    method: M,
    params: WispRequests[M]["params"],
  ): Promise<HostResponse<WispRequests[M]["result"]>> {
    const { client, logId } = this;
    if (this.state.status !== "connected" || !client || logId === undefined) {
      return Promise.resolve({
        error: { code: ErrorCodes.InternalError, message: "not connected" },
      });
    }
    // Only this client answers, and a new log needs a new connection, so this is its log.
    return client
      .request(method, params, REQUEST_TIMEOUT_MS)
      .then((response) => ("result" in response ? { ...response, logId } : response));
  }

  /**
   * See `WispBridge.subscribe`. The listener may get a `resync` before this returns.
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
      () => this.end({ reason: "unresponsive", message: "wispd stopped answering" }),
      LIVENESS_MS,
    );
  }

  private connect(): void {
    clearTimeout(this.retryTimer);
    const [file, ...args] = this.options.command() ?? [];
    if (!file) {
      return this.fail({
        reason: "notFound",
        message: "wispd wasn't found. Set WISPD_PATH to the wispd binary.",
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
          return console.warn("wispd sent a line that isn't JSON:", line.slice(0, 200));
        }
        // attach writes nothing but wispd's frames to stdout, so this came from the host's shell
        // as it started, and would keep corrupting the handshake.
        this.end({
          reason: "sshSetup",
          message: destination
            ? `${destination}'s shell printed text before wispd started. Keep its startup files quiet for commands that aren't interactive.`
            : "wispd attach printed something that isn't wispd's protocol.",
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
      // Any received byte, such as a long replay, proves wispd is alive.
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
        client: { name: "wisp", version: this.options.clientVersion },
        capabilities: {},
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
      wispd: result.wispd,
      protocol: result.protocol,
      capabilities: result.capabilities,
    });
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
    client?.close("the connection to wispd ended");
    for (const subscription of this.subscriptions) subscription.id = undefined;
    child?.kill();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onState(state);
  }
}

function spawnAttach(file: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(file, args, { stdio: "pipe", windowsHide: true });
}

const ignore = () => {};

/**
 * Why `wispd attach` exited (0010), or ssh for the host at `destination` (0022), in words that
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
        `wispd isn't on ${destination}'s PATH for ssh commands. Install it there, or add its folder to PATH in the shell file that ssh commands read.`,
      );
    }
    if (code === 255 && stderr.includes("Could not resolve hostname")) {
      return error("exited", `Couldn't find ${destination}. Check its name, or your ssh config.`);
    }
    if (code === 255) {
      return error("exited", `Couldn't reach ${destination}. Check that it's on and accepts ssh.`);
    }
    if (code === 4)
      return error("exited", `wispd couldn't be reached or started on ${destination}`);
  }
  if (code === 127) return error("notFound", "wispd isn't installed");
  const message =
    code === 4
      ? "wispd couldn't be reached or started"
      : code === 2
        ? "wispd attach rejected its arguments. Update wispd."
        : `wispd attach exited with ${code ?? signal}`;
  return error("exited", message);
}

function handshakeError(error: RpcError): ConnectionError {
  if (error.data?.kind !== "incompatibleProtocol") {
    return { reason: "protocolError", message: `initialize failed: ${error.message}` };
  }
  const detail = error.data.detail as IncompatibleProtocolDetail | undefined;
  const update =
    detail && detail.supported.max < PROTOCOL_VERSION ? "Update wispd." : "Update the app.";
  return { reason: "incompatibleProtocol", message: `${error.message}. ${update}` };
}
