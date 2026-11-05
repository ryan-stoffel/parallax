import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState } from "../preload/bridge";
import { RECONNECT_GRACE_MS, ReconnectGrace } from "./reconnectGrace";

const connected = (plxd = "1"): ConnectionState => ({
  status: "connected",
  plxd,
  protocol: 1,
  capabilities: {},
});
const connecting: ConnectionState = { status: "connecting" };
const failed = (retrying: boolean): ConnectionState => ({
  status: "failed",
  error: { reason: "exited", message: "gone" },
  retrying,
});

/** A grace that keeps what it shows in `shown`, and each thing it showed in `log`. */
function setup() {
  const shown = new Map<string, ConnectionState>();
  const log: ConnectionState[] = [];
  const grace = new ReconnectGrace(
    (id) => shown.get(id),
    (id, state) => {
      shown.set(id, state);
      log.push(state);
    },
  );
  return { grace, shown, log };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

test("a reconnect inside the grace shows only the new connection", () => {
  const { grace, log } = setup();
  const before = connected("1");
  const after = connected("2");
  grace.hear("a", before);
  grace.hear("a", failed(true));
  vi.advanceTimersByTime(1000);
  grace.hear("a", connecting);
  vi.advanceTimersByTime(1000);
  grace.hear("a", after);
  vi.advanceTimersByTime(RECONNECT_GRACE_MS * 2);
  expect(log).toEqual([before, after]);
});

test("a connection still down when the grace ends shows its latest real state", () => {
  const { grace, shown } = setup();
  grace.hear("a", connected());
  grace.hear("a", failed(true));
  grace.hear("a", connecting);
  vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
  expect(shown.get("a")?.status).toBe("connected");
  vi.advanceTimersByTime(1);
  expect(shown.get("a")).toEqual(connecting);
  // No longer connected, so what follows shows at once.
  grace.hear("a", failed(true));
  expect(shown.get("a")).toEqual(failed(true));
});

test("a restart for an update shows at once as that, not as its failure", () => {
  const { grace, shown } = setup();
  grace.hear("a", connected());
  grace.hear("a", {
    status: "failed",
    error: { reason: "exited", message: "gone" },
    retrying: true,
    updating: true,
  });
  expect(shown.get("a")).toEqual({ status: "connecting", updating: true });
  // What the connection says when its notice runs out shows at once, with no second grace.
  grace.hear("a", failed(true));
  expect(shown.get("a")).toEqual(failed(true));
});

test("a first connect shows at once", () => {
  const { grace, log } = setup();
  grace.hear("a", connecting);
  grace.hear("a", failed(true));
  expect(log).toEqual([connecting, failed(true)]);
});

test("a failure that can't come back shows at once, and ends a grace already running", () => {
  const { grace, shown, log } = setup();
  grace.hear("a", connected());
  grace.hear("a", failed(false));
  expect(shown.get("a")).toEqual(failed(false));

  grace.hear("b", connected());
  grace.hear("b", connecting);
  grace.hear("b", failed(false));
  expect(shown.get("b")).toEqual(failed(false));
  const shownSoFar = log.length;
  vi.advanceTimersByTime(RECONNECT_GRACE_MS);
  expect(log.length).toBe(shownSoFar);
});

test("a forgotten host's grace shows nothing when it would have ended", () => {
  const { grace, log } = setup();
  grace.hear("a", connected());
  grace.hear("a", connecting);
  grace.forget("a");
  vi.advanceTimersByTime(RECONNECT_GRACE_MS);
  expect(log.length).toBe(1);
});

test("each host has its own grace", () => {
  const { grace, shown } = setup();
  grace.hear("a", connected());
  grace.hear("b", connected());
  grace.hear("a", connecting);
  vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1000);
  grace.hear("b", connecting);
  vi.advanceTimersByTime(1000);
  expect(shown.get("a")).toEqual(connecting);
  expect(shown.get("b")?.status).toBe("connected");
});
