import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import type { ConnectionState } from "../preload/bridge";
import type { ConnectionOptions } from "./connection";

// Electron as hosts.ts uses it, and connections the test drives: each answers from `answers`,
// shared by every host, and records its retries and whether it was dropped.
const fake = vi.hoisted(() => {
  process.env["PLX_CONNECT_PATH"] = "/nonexistent/plx-connect";
  const answers = new Map<string, unknown>();
  class FakeConnection {
    state: ConnectionState = { status: "connecting" };
    retry = vi.fn();
    disposed = false;
    constructor(readonly options: ConnectionOptions) {
      made.push(this);
    }
    start() {}
    dispose() {
      this.disposed = true;
    }
    async request(method: string) {
      return answers.get(method) ?? { error: { code: -32603, message: "timed out" } };
    }
    set(state: ConnectionState) {
      this.state = state;
      this.options.onState(state);
    }
  }
  const made: FakeConnection[] = [];
  return { userData: "", answers, made, FakeConnection, connect: [] as unknown[] };
});
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "1.0.0",
    getPath: () => fake.userData,
    getAppPath: () => "/repo/apps/desktop",
    on: () => {},
  },
  ipcMain: { handle: () => {}, on: () => {} },
  powerMonitor: { on: () => {} },
}));
vi.mock("./windows", () => ({
  broadcast: (channel: string, value: unknown) => {
    if (channel === "parallax:connect") fake.connect.push(value);
  },
  perWindow: () => new Map(),
}));
vi.mock("./connection", async (actual) => ({
  ...(await actual<typeof import("./connection")>()),
  Connection: fake.FakeConnection,
}));

test("discovery follows connect, keeps devices through a failed read, and revives a stopped one", async () => {
  vi.useFakeTimers();
  fake.userData = mkdtempSync(path.join(tmpdir(), "plx823-"));
  try {
    const device = { id: "n1", hostName: "thinkpad", ip: "100.64.0.2", os: "linux" };
    writeFileSync(
      path.join(fake.userData, "settings.json"),
      JSON.stringify({ hosts: [], devices: [device] }),
    );
    const { startHosts } = await import("./hosts");
    startHosts(undefined, () => "1.0.0");
    const [local] = fake.made;
    const devices = () => fake.made.filter((each) => each.options.device === "thinkpad");
    const settings = (connect: boolean) =>
      fake.answers.set("host/settings/get", { result: { connect } });
    fake.answers.set("connect/devices", { result: { devices: [] } });

    settings(false);
    local!.set({ status: "connected", plxd: "1.0.0", protocol: 1, capabilities: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.connect.at(-1)).toMatchObject({ on: false });
    expect(devices()).toHaveLength(0);

    // `plxd connect on`, run outside the app, is followed at the next discovery.
    settings(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.connect.at(-1)).toMatchObject({ on: true });
    expect(devices()).toHaveLength(1);
    const [thinkpad] = devices();

    // One that stopped retrying, as after an incompatible protocol, tries again. Until then, it's
    // left alone.
    expect(thinkpad!.retry).not.toHaveBeenCalled();
    thinkpad!.state = {
      status: "failed",
      error: { reason: "incompatibleProtocol", message: "old" },
      retrying: false,
    };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(thinkpad!.retry).toHaveBeenCalled();

    // A failed or timed-out read keeps the devices.
    fake.answers.delete("host/settings/get");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(thinkpad!.disposed).toBe(false);
    expect(fake.connect.at(-1)).toMatchObject({ on: true });

    // A definite off drops them.
    settings(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(thinkpad!.disposed).toBe(true);
    expect(fake.connect.at(-1)).toMatchObject({ on: false });
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});
