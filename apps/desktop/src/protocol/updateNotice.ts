import type { ConnectionState } from "../preload/bridge";

/**
 * How long after plxd's `host/updating` a connection that's down says Updating, before its real
 * state shows. A restart takes seconds, and a service manager may hold a restart back for 10 s.
 */
export const UPDATE_NOTICE_MS = 60_000;

/**
 * A connection's memory of plxd's `host/updating` (PLX-1418), which `Connection` and `WebHost` both
 * keep. `mark` adds `updating` to each state on the way out, so the status stays real for what
 * loads, syncs, or retries by it. `ended` runs once the notice runs out, for the connection to send
 * a state still marked through `mark` again.
 */
export class UpdateNotice {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly ended: () => void) {}

  heard(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ended();
    }, UPDATE_NOTICE_MS);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** `state`, saying `updating` while a notice holds. Being back, or needing a retry, ends one. */
  mark(state: ConnectionState): ConnectionState {
    if (state.status === "connected" || (state.status === "failed" && !state.retrying)) {
      this.stop();
      return state;
    }
    if (this.timer !== undefined) return { ...state, updating: true };
    return state.updating ? { ...state, updating: undefined } : state;
  }
}
