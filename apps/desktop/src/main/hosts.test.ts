import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import type { ConnectionState } from "../preload/bridge";
import type { ConnectionOptions } from "./connection";

// Electron as hosts.ts uses it, and connections the test drives: each answers from `answers`,
// shared by every host, an answer or a function of the params that makes one, and records its
// retries and whether it was dropped.
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
    async request(method: string, params?: unknown) {
      const answer = answers.get(method);
      if (typeof answer === "function") return (answer as (p: unknown) => unknown)(params);
      return answer ?? { error: { code: -32603, message: "timed out" } };
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

test("streamFile answers ranges in agent/file slices, and refuses what isn't a file plxd serves", async () => {
  vi.useFakeTimers();
  fake.userData = mkdtempSync(path.join(tmpdir(), "plx836-"));
  vi.resetModules();
  fake.made.length = 0;
  try {
    const { startHosts, streamFile } = await import("./hosts");
    startHosts(undefined, () => "1.0.0");
    const [local] = fake.made;
    const capabilities = { fileChunks: { chunkBytes: 4, maxBytes: 1024 } };
    local!.set({ status: "connected", plxd: "1.0.0", protocol: 1, capabilities });
    // A 20-byte file, read 4 bytes a slice.
    const file = Buffer.from("0123456789abcdefghij");
    const reads: unknown[] = [];
    fake.answers.set("agent/file", (params: { offset?: number; length?: number }) => {
      reads.push(params);
      const { offset = 0, length = 4 } = params;
      const content = file.subarray(offset, offset + length).toString("base64");
      return {
        result: { path: "", side: "working", exists: true, size: 20, content, tooLarge: false },
      };
    });
    const url = "plx-file://file/local/run-1/clips%2Fdemo.mp4";
    const read = async (range: string | null) => {
      reads.length = 0;
      const response = await streamFile(url, range);
      return { response, text: await response.text(), reads: reads.slice() };
    };
    const slices = (...offsets: number[]) =>
      offsets.map((offset) => ({
        runId: "run-1",
        path: "clips/demo.mp4",
        side: "working",
        offset,
        length: 4,
      }));

    const some = await read("bytes=2-5");
    expect(some.response.status).toBe(206);
    expect(Object.fromEntries(some.response.headers)).toEqual({
      "accept-ranges": "bytes",
      "content-length": "4",
      "content-range": "bytes 2-5/20",
      "content-type": "video/mp4",
    });
    expect(some.text).toBe("2345");
    expect(some.reads).toEqual(slices(2));

    const open = await read("bytes=3-");
    expect(open.response.headers.get("content-range")).toBe("bytes 3-19/20");
    expect(open.text).toBe("3456789abcdefghij");
    expect(open.reads).toEqual([...slices(3, 7, 11, 15), { ...slices(19)[0], length: 1 }]);

    const tail = await read("bytes=-5");
    expect(tail.response.headers.get("content-range")).toBe("bytes 15-19/20");
    expect(tail.text).toBe("fghij");
    expect(tail.reads[0]).toEqual({
      runId: "run-1",
      path: "clips/demo.mp4",
      side: "working",
      sizeOnly: true,
    });

    const whole = await read(null);
    expect(whole.response.status).toBe(200);
    expect(whole.response.headers.get("content-length")).toBe("20");
    expect(whole.response.headers.has("content-range")).toBe(false);
    expect(whole.text).toBe(file.toString());
    expect(whole.reads).toEqual(slices(0, 4, 8, 12, 16));

    const past = await read("bytes=25-");
    expect(past.response.status).toBe(416);
    expect(past.response.headers.get("content-range")).toBe("bytes */20");
    expect((await read("bytes=0-1,4-5")).response.status).toBe(416);

    // A malformed address, a host that isn't this app's or can't read slices, and plxd's refusals.
    const status = async (address: string) => (await streamFile(address, "bytes=0-")).status;
    for (const address of [
      "plx-file://file/local/run-1",
      "plx-file://file/local/run-1/clips/demo.mp4",
      "plx-file://file/local/run-1/%zz",
    ])
      expect(await status(address)).toBe(400);
    expect(await status("plx-file://file/elsewhere/run-1/demo.mp4")).toBe(404);
    fake.answers.set("agent/file", { error: { code: -32602, message: "path is under .git" } });
    expect(await status("plx-file://file/local/run-1/.git%2Fconfig")).toBe(403);
    fake.answers.set("agent/file", { error: { code: -32000, message: "unknown run" } });
    expect(await status("plx-file://file/local/run-2/demo.mp4")).toBe(404);
    fake.answers.set("agent/file", {
      result: { path: "", side: "working", exists: false, tooLarge: false },
    });
    expect(await status(url)).toBe(404);
    local!.set({ status: "connected", plxd: "1.0.0", protocol: 1, capabilities: {} });
    expect(await status(url)).toBe(404);
  } finally {
    fake.answers.delete("agent/file");
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});
