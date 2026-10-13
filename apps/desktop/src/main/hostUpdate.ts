import type { ConnectionState, HostUpdateEvent, RpcResponse } from "../preload/bridge";
import type { HostUpdateResult } from "../protocol/generated/protocol";

// Keeping every connected computer's plxd on the app's version (PLX-700, decision 0066). Once the
// local plxd runs the app's version, so after an update, each remote host whose plxd is older is
// updated once per launch: through its own `host/update` when it has it, else by the SSH install
// for an SSH host once no agent's turn is running there, else the user is told how. A host that
// restarts and doesn't come back on the new plxd in time counts as failed.

/** A release version's numbers, without its channel: `[2610, 10912, 13045]` (0030). */
export function versionNumbers(version: string): number[] | undefined {
  const numbers = version.split("-")[0]!.split(".");
  if (!numbers.every((n) => /^\d+$/.test(n))) return undefined;
  return numbers.map(Number);
}

/**
 * Compares two versions by their numbers, a missing one counting as 0, and the channel not at
 * all: negative when `a` is older. Undefined when either isn't a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const [x, y] = [versionNumbers(a), versionNumbers(b)];
  if (!x || !y) return undefined;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const order = (x[i] ?? 0) - (y[i] ?? 0);
    if (order !== 0) return order;
  }
  return 0;
}

/** Whether plxd `plxd` is older than the app's `version`. */
export const isOlder = (plxd: string, version: string) => (compareVersions(plxd, version) ?? 0) < 0;

/** How a remote host is reached, which decides how its plxd updates without `host/update`. */
export type HostKind = "ssh" | "remote";

/** How often an SSH host with running agents is asked again before plxd is reinstalled there. */
export const IDLE_POLL_MS = 15_000;

/** How long a host that restarts now has to reconnect on the new plxd before it counts as failed. */
export const RECONNECT_TIMEOUT_MS = 3 * 60_000;

export type HostUpdaterDeps = {
  /** A packaged app, not a development build or one running `PLXD_PATH`. */
  packaged: boolean;
  /** The app's version, which each host's plxd is updated to. */
  version: string;
  /** The channel plx-connect installs from. */
  channel: "stable" | "nightly";
  /** `ssh` for a saved SSH host, `remote` for a LAN computer or Connect device, else undefined. */
  kindOf: (hostId: string) => HostKind | undefined;
  /** Each host's connection state now, `local` included. */
  states: () => Iterable<[string, ConnectionState]>;
  /** Sends `host/update`, waiting as long as a download takes; restarting at once with `now`. */
  update: (
    hostId: string,
    version: string,
    now?: boolean,
  ) => Promise<RpcResponse<HostUpdateResult>>;
  /** Agents with a turn running on the host, from `host/health`; undefined when it didn't answer. */
  runningAgents: (hostId: string) => Promise<number | undefined>;
  /** Installs the app's plxd over ssh and reconnects; resolves to an error for people. */
  installSsh: (hostId: string) => Promise<string | undefined>;
  /** The host's OS, as `host/version` names it. */
  osOf: (hostId: string) => Promise<string | undefined>;
  /** Tells the windows. */
  emit: (event: HostUpdateEvent) => void;
};

/** A host updating, which is done once it reconnects on `version`. */
type Pending = {
  version: string;
  /** It restarted, or was reinstalled, so reconnecting on an older plxd means it failed. */
  restarted: boolean;
  /** Fails it if it hasn't reconnected on `version` in time. */
  timer?: ReturnType<typeof setTimeout>;
};

/** What to tell a user whose plxd can't update itself, on a host the app can't reach by ssh. */
export function unsupportedMessage(plxd: string, os: string | undefined, channel: string): string {
  const old = `plxd ${plxd} there is too old to update itself.`;
  if (/^(macos|windows)/i.test(os ?? "")) return `${old} Update Parallax on that computer.`;
  return `${old} On that computer, run: npx plx-connect setup --channel ${channel}`;
}

export class HostUpdater {
  /** Hosts tried this launch, as `hostId@version`, so each is tried once. */
  private readonly tried = new Set<string>();
  /** Hosts updating now: from the first step until they reconnect updated or fail. */
  private readonly active = new Set<string>();
  /** Hosts waiting to reconnect on the new plxd. */
  private readonly pending = new Map<string, Pending>();
  /** Each update started here until plxd answers, so `updateNow` sends after it, not over it. */
  private readonly running = new Map<string, Promise<void>>();
  /** The local plxd ran the app's version once this launch. */
  private localCurrent = false;

  constructor(private readonly deps: HostUpdaterDeps) {}

  /** Follows every host's connection state. */
  onState(hostId: string, state: ConnectionState): void {
    if (state.status !== "connected") return;
    if (hostId === "local") {
      if (this.localCurrent || compareVersions(state.plxd, this.deps.version) !== 0) return;
      this.localCurrent = true;
      for (const [id, each] of this.deps.states()) if (id !== "local") this.consider(id, each);
      return;
    }
    const waiting = this.pending.get(hostId);
    if (waiting !== undefined) {
      if (!isOlder(state.plxd, waiting.version)) {
        this.done(hostId);
        this.deps.emit({ hostId, status: "updated", version: state.plxd });
      } else if (waiting.restarted) {
        this.fail(
          hostId,
          `plxd restarted, but it's still plxd ${state.plxd}, not ${waiting.version}.`,
        );
      }
      // Otherwise it's still the old plxd, waiting for its agents.
      return;
    }
    if (this.localCurrent) this.consider(hostId, state);
  }

  /** Tries a host again, as the failure notice's Retry does, unless it's updating already. */
  retry(hostId: string): void {
    if (this.active.has(hostId)) return;
    this.tried.delete(`${hostId}@${this.deps.version}`);
    const state = new Map(this.deps.states()).get(hostId);
    if (state) this.consider(hostId, state);
  }

  /**
   * Updates `hostId` to `version` now, cutting off its agents' turns, as Update everything does
   * (PLX-746): even one waiting for its agents, or one that failed. One this launch is updating
   * already is asked once plxd has answered that. Resolves once plxd answers; the result comes as
   * the usual event once it reconnects. A plxd that doesn't know `now` waits for its agents.
   */
  async updateNow(hostId: string, version: string): Promise<void> {
    await this.running.get(hostId);
    this.tried.add(`${hostId}@${this.deps.version}`);
    this.active.add(hostId);
    const answer = await this.deps.update(hostId, version, true).catch((error: unknown) => ({
      error: { message: error instanceof Error ? error.message : String(error) },
    }));
    if ("error" in answer) {
      // Already restarting into the last update, which may cut this request off: its reconnect
      // says how that went.
      if (this.pending.get(hostId)?.restarted) return;
      return this.fail(hostId, answer.error.message);
    }
    if (answer.result.restart === "upToDate") return this.done(hostId);
    this.wait(hostId, answer.result.restart === "now", version);
  }

  /** Updates `hostId` if it's a remote host, connected on an older plxd, not tried yet. */
  private consider(hostId: string, state: ConnectionState): void {
    const { packaged, version } = this.deps;
    if (!packaged || state.status !== "connected" || !isOlder(state.plxd, version)) return;
    const kind = this.deps.kindOf(hostId);
    const key = `${hostId}@${version}`;
    if (!kind || this.tried.has(key) || this.active.has(hostId)) return;
    this.tried.add(key);
    this.active.add(hostId);
    const running = this.run(hostId, kind, state)
      .catch((error: unknown) =>
        this.fail(hostId, error instanceof Error ? error.message : String(error)),
      )
      .finally(() => this.running.delete(hostId));
    this.running.set(hostId, running);
  }

  private async run(
    hostId: string,
    kind: HostKind,
    state: Extract<ConnectionState, { status: "connected" }>,
  ): Promise<void> {
    const { version } = this.deps;
    if ("hostUpdate" in state.capabilities) {
      const answer = await this.deps.update(hostId, version);
      if ("error" in answer) return this.fail(hostId, answer.error.message);
      if (answer.result.restart === "upToDate") return this.done(hostId);
      // It reconnects on the new version: now, or once its agents' turns end.
      this.wait(hostId, answer.result.restart === "now");
      return;
    }
    if (kind === "ssh") {
      // The SSH install restarts plxd at once, so it waits until no agent's turn is running.
      if (!(await this.idle(hostId))) return this.done(hostId);
      // The new connection may be up before this resolves, so it waits first.
      this.wait(hostId, false);
      const error = await this.deps.installSsh(hostId);
      if (error) return this.fail(hostId, error);
      // Unless it's back on the new plxd already, it has a while to reconnect on it.
      if (this.pending.has(hostId)) this.wait(hostId, true);
      return;
    }
    const os = await this.deps.osOf(hostId);
    this.fail(hostId, unsupportedMessage(state.plxd, os, this.deps.channel));
  }

  /**
   * Resolves once `host/health` reports no running agents on `hostId`, asking every
   * `IDLE_POLL_MS`; false if the host leaves Parallax meanwhile.
   */
  private async idle(hostId: string): Promise<boolean> {
    for (;;) {
      if (!this.deps.kindOf(hostId)) return false;
      if ((await this.deps.runningAgents(hostId)) === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
  }

  /**
   * Waits for `hostId` to reconnect on plxd `version`, the app's unless given; within
   * `RECONNECT_TIMEOUT_MS` if `restarted`.
   */
  private wait(hostId: string, restarted: boolean, version = this.deps.version): void {
    clearTimeout(this.pending.get(hostId)?.timer);
    const pending: Pending = { version, restarted };
    if (restarted) {
      pending.timer = setTimeout(
        () =>
          this.fail(
            hostId,
            `plxd didn't come back on ${version} within ${RECONNECT_TIMEOUT_MS / 60_000} minutes of restarting.`,
          ),
        RECONNECT_TIMEOUT_MS,
      );
    }
    this.pending.set(hostId, pending);
  }

  /** Stops following `hostId`'s update. */
  private done(hostId: string): void {
    clearTimeout(this.pending.get(hostId)?.timer);
    this.pending.delete(hostId);
    this.active.delete(hostId);
  }

  private fail(hostId: string, error: string): void {
    this.done(hostId);
    this.deps.emit({ hostId, status: "failed", error });
  }
}
