import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Capabilities } from "../protocol/generated/protocol";
import type { ConnectionState, HostUpdateEvent } from "../preload/bridge";
import {
  compareVersions,
  HostUpdater,
  IDLE_POLL_MS,
  isOlder,
  RECONNECT_TIMEOUT_MS,
  unsupportedMessage,
  type HostUpdaterDeps,
} from "./hostUpdate";

const APP = "2610.10912.13045-nightly";

const connected = (plxd: string, capabilities: Capabilities = {}): ConnectionState => ({
  status: "connected",
  plxd,
  protocol: 1,
  capabilities,
});
const updatable = (plxd: string) => connected(plxd, { hostUpdate: {} });

/** An updater over `states`, whose `host/update` answers `answer`, recording what it does. */
function rig(states: Map<string, ConnectionState>, overrides: Partial<HostUpdaterDeps> = {}) {
  const events: HostUpdateEvent[] = [];
  const deps: HostUpdaterDeps = {
    packaged: true,
    version: APP,
    channel: "nightly",
    kindOf: (id) => (id.startsWith("ssh") ? "ssh" : id === "local" ? undefined : "remote"),
    states: () => states,
    update: vi.fn(async (_id: string, version: string) => ({
      result: { version, restart: "now" as const, runningAgents: 0, message: "Installed." },
    })),
    runningAgents: vi.fn(async () => 0),
    installSsh: vi.fn(async () => undefined),
    osOf: vi.fn(async () => "linux"),
    emit: (event) => events.push(event),
    ...overrides,
  };
  const updater = new HostUpdater(deps);
  /** Sets a host's state and tells the updater, as a connection's `onState` does. */
  const set = (id: string, state: ConnectionState) => {
    states.set(id, state);
    updater.onState(id, state);
  };
  return { deps, updater, events, set };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

test("versions compare by their numbers, not their channel", () => {
  expect(compareVersions("0.1.0", APP)).toBeLessThan(0);
  expect(compareVersions("2610.10912.13045", APP)).toBe(0);
  expect(compareVersions("2610.10912.13046", APP)).toBeGreaterThan(0);
  expect(compareVersions("2610.11001.10000", "2610.10923.15959")).toBeGreaterThan(0);
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
  expect(compareVersions("dev", APP)).toBeUndefined();
  expect(isOlder("0.1.0", APP)).toBe(true);
  expect(isOlder(APP, APP)).toBe(false);
  expect(isOlder("dev", APP)).toBe(false);
});

test("only an older remote plxd updates, once the local one runs the app's version", async () => {
  const states = new Map<string, ConnectionState>();
  const { deps, events, set } = rig(states);
  set("tailnet:old", updatable("0.1.0"));
  set("tailnet:same", updatable("2610.10912.13045"));
  set("tailnet:newer", updatable("2610.10912.13046"));
  set("local", connected("2610.10912.13044"));
  await settle();
  // The local plxd is still the old app's.
  expect(deps.update).not.toHaveBeenCalled();

  set("local", connected(APP));
  await settle();
  expect(deps.update).toHaveBeenCalledExactlyOnceWith("tailnet:old", APP);
  expect(events).toEqual([]);

  // It reconnects on the new version.
  set("tailnet:old", { status: "connecting" });
  set("tailnet:old", updatable(APP));
  expect(events).toEqual([{ hostId: "tailnet:old", status: "updated", version: APP }]);

  // A host that connects later updates at once.
  set("lan:abc", updatable("2610.10912.13000"));
  await settle();
  expect(deps.update).toHaveBeenLastCalledWith("lan:abc", APP);
});

test("each host is tried once per launch, until Retry", async () => {
  const states = new Map<string, ConnectionState>();
  const update = vi.fn(async () => ({ error: { code: -32000, message: "Couldn't download it." } }));
  const { events, set, updater } = rig(states, { update });
  set("local", connected(APP));
  set("tailnet:a", updatable("0.1.0"));
  await settle();
  expect(events).toEqual([
    { hostId: "tailnet:a", status: "failed", error: "Couldn't download it." },
  ]);

  set("tailnet:a", { status: "connecting" });
  set("tailnet:a", updatable("0.1.0"));
  await settle();
  expect(update).toHaveBeenCalledTimes(1);

  updater.retry("tailnet:a");
  await settle();
  expect(update).toHaveBeenCalledTimes(2);
  expect(events).toHaveLength(2);
});

test("a host that waits for its agents reports success when it comes back updated", async () => {
  const states = new Map<string, ConnectionState>();
  const update = vi.fn(async (_id: string, version: string) => ({
    result: { version, restart: "afterRuns" as const, runningAgents: 2, message: "Later." },
  }));
  const { events, set } = rig(states, { update });
  set("local", connected(APP));
  set("tailnet:a", updatable("0.1.0"));
  await settle();
  // A reconnect before the restart is still the old plxd, and isn't tried again.
  set("tailnet:a", updatable("0.1.0"));
  await settle();
  expect(update).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
  set("tailnet:a", updatable(APP));
  expect(events).toEqual([{ hostId: "tailnet:a", status: "updated", version: APP }]);
});

test("without host/update, an SSH host installs over ssh and another host is told how", async () => {
  const states = new Map<string, ConnectionState>();
  const osOf = vi.fn(async (id: string) => (id === "tailnet:mac" ? "macOS 26.0" : "linux"));
  const { deps, events, set } = rig(states, { osOf });
  set("local", connected(APP));
  set("ssh-box", connected("0.1.0"));
  set("tailnet:thinkpad", connected("0.1.0"));
  set("tailnet:mac", connected("0.1.0"));
  await settle();
  expect(deps.installSsh).toHaveBeenCalledExactlyOnceWith("ssh-box");
  expect(deps.update).not.toHaveBeenCalled();
  expect(events).toEqual([
    {
      hostId: "tailnet:thinkpad",
      status: "failed",
      error:
        "plxd 0.1.0 there is too old to update itself. On that computer, run: npx plx-connect setup --channel nightly",
    },
    {
      hostId: "tailnet:mac",
      status: "failed",
      error: "plxd 0.1.0 there is too old to update itself. Update Parallax on that computer.",
    },
  ]);
  // The SSH host's new connection lands on the new plxd.
  set("ssh-box", connected(APP));
  expect(events.at(-1)).toEqual({ hostId: "ssh-box", status: "updated", version: APP });
});

test("an SSH install that fails says why", async () => {
  const states = new Map<string, ConnectionState>();
  const installSsh = vi.fn(async () => "Installing plxd needs curl or wget on the host.");
  const { events, set } = rig(states, { installSsh });
  set("local", connected(APP));
  set("ssh-box", connected("0.1.0"));
  await settle();
  expect(events).toEqual([
    {
      hostId: "ssh-box",
      status: "failed",
      error: "Installing plxd needs curl or wget on the host.",
    },
  ]);
});

test("a development build, the local host, and unknown hosts never update", async () => {
  const states = new Map<string, ConnectionState>();
  const { deps, set } = rig(states, { packaged: false });
  set("local", connected(APP));
  set("tailnet:a", updatable("0.1.0"));
  await settle();
  expect(deps.update).not.toHaveBeenCalled();

  const other = rig(new Map(), { kindOf: () => undefined });
  other.set("local", connected(APP));
  other.set("gone", updatable("0.1.0"));
  await settle();
  expect(other.deps.update).not.toHaveBeenCalled();
});

test("the unsupported message fits the computer's OS", () => {
  expect(unsupportedMessage("0.1.0", "Windows 11 Pro", "stable")).toContain("Update Parallax");
  expect(unsupportedMessage("0.1.0", undefined, "stable")).toContain(
    "npx plx-connect setup --channel stable",
  );
});

test("an SSH host is reinstalled only once no agent's turn is running there", async () => {
  vi.useFakeTimers();
  const states = new Map<string, ConnectionState>();
  const running = [2, undefined, 1, 0];
  const runningAgents = vi.fn(async () => running.shift());
  const { deps, set, updater } = rig(states, { runningAgents });
  set("local", connected(APP));
  set("ssh-box", connected("0.1.0"));
  await vi.advanceTimersByTimeAsync(0);
  expect(runningAgents).toHaveBeenCalledTimes(1);
  expect(deps.installSsh).not.toHaveBeenCalled();
  // Retry while it waits starts nothing new.
  updater.retry("ssh-box");
  await vi.advanceTimersByTimeAsync(0);
  expect(runningAgents).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
  expect(runningAgents).toHaveBeenCalledTimes(3);
  expect(deps.installSsh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
  expect(runningAgents).toHaveBeenCalledTimes(4);
  expect(deps.installSsh).toHaveBeenCalledExactlyOnceWith("ssh-box");
});

test("an SSH host removed while it waits for its agents is left alone", async () => {
  vi.useFakeTimers();
  const states = new Map<string, ConnectionState>();
  let saved = true;
  const { deps, events, set } = rig(states, {
    runningAgents: vi.fn(async () => 1),
    kindOf: (id) => (id === "ssh-box" && saved ? "ssh" : undefined),
  });
  set("local", connected(APP));
  set("ssh-box", connected("0.1.0"));
  await vi.advanceTimersByTimeAsync(0);
  saved = false;
  await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
  expect(deps.installSsh).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

test("a host that restarts now fails if it comes back on the old plxd or not at all", async () => {
  vi.useFakeTimers();
  const states = new Map<string, ConnectionState>();
  const { events, set, updater } = rig(states);
  set("local", connected(APP));
  set("tailnet:a", updatable("0.1.0"));
  set("tailnet:b", updatable("0.1.0"));
  await vi.advanceTimersByTimeAsync(0);

  set("tailnet:a", { status: "connecting" });
  set("tailnet:a", updatable("0.1.0"));
  expect(events).toEqual([
    {
      hostId: "tailnet:a",
      status: "failed",
      error: `plxd restarted, but it's still plxd 0.1.0, not ${APP}.`,
    },
  ]);

  await vi.advanceTimersByTimeAsync(RECONNECT_TIMEOUT_MS);
  expect(events.at(-1)).toEqual({
    hostId: "tailnet:b",
    status: "failed",
    error: `plxd didn't come back on ${APP} within 3 minutes of restarting.`,
  });
  // A late reconnect on the new plxd still says so.
  updater.retry("tailnet:b");
  await vi.advanceTimersByTimeAsync(0);
  set("tailnet:b", updatable(APP));
  expect(events.at(-1)).toEqual({ hostId: "tailnet:b", status: "updated", version: APP });
  // Nothing fires after it's done.
  await vi.advanceTimersByTimeAsync(RECONNECT_TIMEOUT_MS);
  expect(events).toHaveLength(3);
});

test("an SSH install that doesn't reconnect on the new plxd fails", async () => {
  vi.useFakeTimers();
  const states = new Map<string, ConnectionState>();
  const { events, set } = rig(states);
  set("local", connected(APP));
  set("ssh-box", connected("0.1.0"));
  await vi.advanceTimersByTimeAsync(RECONNECT_TIMEOUT_MS);
  expect(events).toEqual([
    {
      hostId: "ssh-box",
      status: "failed",
      error: `plxd didn't come back on ${APP} within 3 minutes of restarting.`,
    },
  ]);
});

test("Retry doesn't start a second update while one is running", async () => {
  const states = new Map<string, ConnectionState>();
  let answer!: (value: { error: { code: number; message: string } }) => void;
  const update = vi.fn(
    () =>
      new Promise<{ error: { code: number; message: string } }>((resolve) => {
        answer = resolve;
      }),
  );
  const { events, set, updater } = rig(states, { update });
  set("local", connected(APP));
  set("tailnet:a", updatable("0.1.0"));
  await settle();
  updater.retry("tailnet:a");
  await settle();
  expect(update).toHaveBeenCalledTimes(1);

  answer({ error: { code: -32000, message: "No network." } });
  await settle();
  expect(events).toEqual([{ hostId: "tailnet:a", status: "failed", error: "No network." }]);
  updater.retry("tailnet:a");
  await settle();
  expect(update).toHaveBeenCalledTimes(2);
});

test("Update everything updates a host now, even one waiting for its agents", async () => {
  vi.useFakeTimers();
  const states = new Map<string, ConnectionState>();
  const update = vi.fn(async (_id: string, version: string, now?: boolean) => ({
    result: {
      version,
      restart: now ? ("now" as const) : ("afterRuns" as const),
      runningAgents: 2,
      message: "Installed.",
    },
  }));
  const { events, set, updater } = rig(states, { update });
  set("tailnet:a", updatable("0.1.0"));
  set("local", connected(APP));
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenLastCalledWith("tailnet:a", APP);

  const next = "2610.11001.10000-nightly";
  await updater.updateNow("tailnet:a", next);
  expect(update).toHaveBeenLastCalledWith("tailnet:a", next, true);
  // Back on the app's version isn't the release it went to.
  set("tailnet:a", updatable(APP));
  expect(events).toEqual([
    { hostId: "tailnet:a", status: "failed", error: expect.stringContaining(next) },
  ]);
  await updater.updateNow("tailnet:a", next);
  set("tailnet:a", updatable(next));
  expect(events.at(-1)).toEqual({ hostId: "tailnet:a", status: "updated", version: next });
});

test("Update everything waits for an update already running, and an older plxd's agents", async () => {
  const states = new Map<string, ConnectionState>();
  let answer!: () => void;
  const update = vi.fn(async (_id: string, version: string, now?: boolean) => {
    // The update this launch started is still downloading when Update everything asks.
    if (!now) await new Promise<void>((resolve) => (answer = resolve));
    // A plxd from before `now` waits for its agents either way.
    return {
      result: { version, restart: "afterRuns" as const, runningAgents: 1, message: "Installed." },
    };
  });
  const { events, set, updater } = rig(states, { update });
  set("tailnet:a", updatable("0.1.0"));
  set("local", connected(APP));
  await settle();
  const asked = updater.updateNow("tailnet:a", APP);
  await settle();
  expect(update).toHaveBeenCalledTimes(1);
  answer();
  await asked;
  expect(update).toHaveBeenLastCalledWith("tailnet:a", APP, true);
  // Still on the old plxd while its agents run: no failure, and success once it's back.
  set("tailnet:a", updatable("0.1.0"));
  expect(events).toEqual([]);
  set("tailnet:a", updatable(APP));
  expect(events).toEqual([{ hostId: "tailnet:a", status: "updated", version: APP }]);
});

test("Update everything doesn't fail a host its launch update is restarting", async () => {
  const states = new Map<string, ConnectionState>();
  const update = vi.fn(async (_id: string, version: string, now?: boolean) =>
    now
      ? { error: { code: -32603, message: "The connection closed." } }
      : { result: { version, restart: "now" as const, runningAgents: 0, message: "Installed." } },
  );
  const { events, set, updater } = rig(states, { update });
  set("tailnet:a", updatable("0.1.0"));
  set("local", connected(APP));
  await settle();
  // plxd restarts into the launch's update and cuts off Update everything's request.
  await updater.updateNow("tailnet:a", "2610.11001.10000-nightly");
  expect(events).toEqual([]);
  set("tailnet:a", updatable(APP));
  expect(events).toEqual([{ hostId: "tailnet:a", status: "updated", version: APP }]);
});
