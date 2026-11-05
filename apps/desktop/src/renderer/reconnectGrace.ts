import type { ConnectionState } from "../preload/bridge";

/**
 * How long a dropped connection keeps showing as connected. Relay reconnects take 1 to 3 s, and
 * backoff waits 1 s, then 2 s, so this also covers a reconnect whose first retry fails, while a
 * real outage still shows within seconds.
 */
export const RECONNECT_GRACE_MS = 5_000;

/**
 * What to show for each host's connection, so a short reconnect doesn't read as an outage. A host
 * showing as connected keeps showing so for `RECONNECT_GRACE_MS` while it reconnects, then shows
 * its real state. Anything else shows at once: a first connect, a host already down, and a failure
 * that can't come back by itself, such as a refused session or a closed connection.
 *
 * This is for display only. Requests still go by the real state, so one sent meanwhile fails or
 * waits as it would without this.
 */
export class ReconnectGrace {
  private readonly held = new Map<
    string,
    { latest: ConnectionState; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly shown: (hostId: string) => ConnectionState | undefined,
    private readonly show: (hostId: string, state: ConnectionState) => void,
  ) {}

  /** Takes `hostId`'s real state, each time it changes. */
  hear(hostId: string, state: ConnectionState): void {
    const comingBack =
      state.status === "connecting" || (state.status === "failed" && state.retrying);
    if (!comingBack || this.shown(hostId)?.status !== "connected") {
      this.forget(hostId);
      return this.show(hostId, state);
    }
    const held = this.held.get(hostId);
    if (held) {
      held.latest = state;
      return;
    }
    const timer = setTimeout(() => {
      const { latest } = this.held.get(hostId)!;
      this.held.delete(hostId);
      this.show(hostId, latest);
    }, RECONNECT_GRACE_MS);
    this.held.set(hostId, { latest: state, timer });
  }

  /** Stops holding `hostId`'s state back, without showing anything. */
  forget(hostId: string): void {
    clearTimeout(this.held.get(hostId)?.timer);
    this.held.delete(hostId);
  }

  /** Stops holding every host's state back. */
  clear(): void {
    for (const hostId of this.held.keys()) this.forget(hostId);
  }
}
