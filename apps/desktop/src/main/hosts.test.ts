import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import type { ConnectionState, DeviceHost } from "../preload/bridge";
import type { ConnectionOptions } from "./connection";

// Electron as hosts.ts uses it, and connections the test drives: each answers from `answers`,
// shared by every host, an answer or a function of the params and the connection that makes one,
// and records its retries and whether it was dropped. Main's IPC handlers and app events are kept
// by channel, what it broadcasts by channel, and the `plxd dial` runs it makes are faked.
const fake = vi.hoisted(() => {
  process.env["PLX_CONNECT_PATH"] = "/nonexistent/plx";
  process.env["PLXD_PATH"] = process.execPath;
  const answers = new Map<string, unknown>();
  class FakeConnection {
    state: ConnectionState = { status: "connecting" };
    retry = vi.fn();
    reconnect = vi.fn();
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
      if (typeof answer === "function")
        return (answer as (p: unknown, c: FakeConnection) => unknown)(params, this);
      return answer ?? { error: { code: -32603, message: "timed out" } };
    }
    set(state: ConnectionState) {
      this.state = state;
      this.options.onState(state);
    }
  }
  const made: FakeConnection[] = [];
  return {
    userData: "",
    answers,
    made,
    FakeConnection,
    connect: [] as unknown[],
    sent: new Map<string, unknown>(),
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    appEvents: new Map<string, () => void>(),
    /** Each `plxd dial` run: its arguments and what it read on stdin. */
    dials: [] as { args: string[]; stdin: string }[],
    /** What the next `plxd dial` run prints, a line each, and its exit code. */
    dialOutput: { lines: [] as string[], code: 0 },
    opened: [] as { runner: unknown; params: unknown }[],
  };
});
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "1.0.0",
    getPath: () => fake.userData,
    getAppPath: () => "/repo/apps/desktop",
    on: (event: string, listener: () => void) => fake.appEvents.set(event, listener),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      fake.handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) =>
      fake.handlers.set(channel, handler),
  },
  powerMonitor: { on: () => {} },
}));
vi.mock("./windows", () => ({
  broadcast: (channel: string, value: unknown) => {
    if (channel === "parallax:connect") fake.connect.push(value);
    fake.sent.set(channel, value);
  },
  perWindow: () => new Map(),
}));
vi.mock("./connection", async (actual) => ({
  ...(await actual<typeof import("./connection")>()),
  Connection: fake.FakeConnection,
}));
vi.mock("./terminal", async (actual) => ({
  ...(await actual<typeof import("./terminal")>()),
  openTerminal: (_sender: unknown, _id: string, runner: unknown, params: unknown) => {
    fake.opened.push({ runner, params });
    return Promise.resolve(undefined);
  },
}));
// `plxd dial`: `--sign-in` streams its lines through spawn, the rest answer through execFile.
vi.mock("node:child_process", async (actual) => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { promisify } = await import("node:util");
  const run = (args: string[]) => {
    const record = { args, stdin: "" };
    fake.dials.push(record);
    return { record, ...fake.dialOutput };
  };
  const spawn = (_file: string, args: string[]) => {
    const { record, lines, code } = run(args);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.on("data", (chunk: Buffer) => (record.stdin += String(chunk)));
    // A line every 10 ms, so a test sees where a sign-in stands between them.
    lines.forEach((line, i) => setTimeout(() => child.stdout.write(`${line}\n`), 10 * i));
    setTimeout(() => {
      child.stdout.end();
      child.emit("close", code);
    }, 10 * lines.length);
    return child;
  };
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: (_file: string, args: string[]) => {
      const { record, lines, code } = run(args);
      const stdin = { end: (text: string) => (record.stdin += text) };
      const done = new Promise((resolve, reject) =>
        setTimeout(() =>
          code === 0
            ? resolve({ stdout: lines.join("\n"), stderr: "" })
            : reject(Object.assign(new Error("plxd dial failed"), { code, stderr: "" })),
        ),
      );
      return Object.assign(done, { child: { stdin } });
    },
  });
  return { ...(await actual<typeof import("node:child_process")>()), spawn, execFile };
});

/** A fake signed-in account, whose sign-ins the test calls. */
function signedIn() {
  const listeners: (() => void)[] = [];
  return {
    account: {
      accessToken: async () => "relay-token",
      currentToken: () => "relay-token",
      freshToken: async () => "fresh-token",
      onSignIn: (listener: () => void) => void listeners.push(listener),
    },
    signIn: () => listeners.forEach((listener) => listener()),
  };
}

const studio = "alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o";
const buildBox = "Q2s9vX1k7d0b8Lr4mT6pWc3eYh5uNz2aFgJ_iK-oPqR";
const connected = (capabilities = {}): ConnectionState => ({
  status: "connected",
  plxd: "1.0.0",
  protocol: 1,
  capabilities,
});
const refused: ConnectionState = {
  status: "failed",
  error: { reason: "refused", message: "studio hasn't let this computer in yet." },
  retrying: false,
};
/** `access/get` as plxd answers it at once, vouching for `approvedHosts`; a wait never answers. */
const accessState = (approvedHosts: string[]) => (params: { after?: number }) =>
  params.after === undefined
    ? {
        result: { version: 1, approvedClients: [], removedClients: [], approvedHosts },
      }
    : new Promise(() => {});

/** Starts hosts.ts afresh with `settings`, and answers its local connection. */
async function start(settings: object, account?: ReturnType<typeof signedIn>["account"]) {
  vi.resetModules();
  fake.made.length = 0;
  fake.dials.length = 0;
  fake.opened.length = 0;
  fake.handlers.clear();
  fake.appEvents.clear();
  fake.sent.clear();
  fake.userData = mkdtempSync(path.join(tmpdir(), "plx1163-"));
  writeFileSync(
    path.join(fake.userData, "settings.json"),
    JSON.stringify({ hosts: [], ...settings }),
  );
  const { startHosts } = await import("./hosts");
  startHosts(account as never, () => "1.0.0");
  return fake.made[0]!;
}

/** Account computer `relayId`'s latest connection. */
const accountConnection = (relayId: string) =>
  fake.made.findLast((c) => c.options.command()?.includes(relayId));

/** What the renderer last heard of account computer `relayId`. */
const listed = (relayId: string) =>
  (fake.sent.get("parallax:devices") as DeviceHost[] | undefined)?.find(
    (d) => d.id === `account:${relayId}`,
  );

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

test("the account's computers are asked for on sign-in, focus, the network, and Settings opening, never on a timer", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { account, signIn } = signedIn();
    let asked = 0;
    let hosts = [
      { hostId: studio, name: "studio", online: true, thisComputer: false },
      { hostId: buildBox, name: "macbook", online: true, thisComputer: true },
    ];
    fake.answers.set("relay/hosts", () => (asked++, { result: { hosts } }));
    const local = await start({}, account);
    // The local plxd connecting asks once.
    local.set(connected());
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(1);
    const connection = accountConnection(studio)!;
    expect(connection.options.command()).toEqual([
      process.execPath,
      "dial",
      "--account",
      studio,
      "--",
      `relay:${studio}`,
    ]);
    expect(connection.options.env?.()).toEqual({ PLXD_RELAY_TOKEN: "relay-token" });
    expect(accountConnection(buildBox)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked).toBe(1);

    const triggers = [
      () => fake.appEvents.get("browser-window-focus")!(),
      () => fake.handlers.get("parallax:network")!(),
      () => fake.handlers.get("parallax:discoverAccount")!(),
      signIn,
    ];
    for (const trigger of triggers) {
      trigger();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(asked).toBe(5);

    // A connection that stopped retrying starts again at the next one.
    connection.state = {
      status: "failed",
      error: { reason: "incompatibleProtocol", message: "old" },
      retrying: false,
    };
    fake.appEvents.get("browser-window-focus")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.retry).toHaveBeenCalled();

    // One the account no longer lists is dropped.
    hosts = hosts.slice(1);
    fake.handlers.get("parallax:discoverAccount")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.disposed).toBe(true);
    expect(listed(studio)).toBeUndefined();
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("an account computer on the relay moves once a re-check finds a direct route", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    await start({ accounts: [{ hostId: studio, name: "studio", routes: ["192.168.1.20:7341"] }] });
    const connection = accountConnection(studio)!;
    expect(connection.options.command()?.slice(-2)).toEqual([
      "192.168.1.20:7341",
      `relay:${studio}`,
    ]);
    connection.options.onRoute!(`relay:${studio}`);
    connection.set(connected());

    fake.dialOutput = { lines: ['{"route":"192.168.1.20:7341"}'], code: 0 };
    fake.handlers.get("parallax:network")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.dials.at(-1)?.args).toEqual([
      "dial",
      "--probe",
      "--account",
      studio,
      "--",
      "192.168.1.20:7341",
    ]);
    expect(connection.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a new computer takes its code, one run each and 5 an hour; a vouched one signs in and shows its code while it waits", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const merged: unknown[] = [];
    fake.answers.set("access/get", accessState([studio]));
    fake.answers.set("access/merge", (params: unknown) => (merged.push(params), { result: {} }));
    const local = await start(
      {
        localName: "macbook",
        accounts: [
          { hostId: studio, name: "studio", routes: ["192.168.1.20:7341"] },
          { hostId: buildBox, name: "build-box", routes: [] },
        ],
      },
      signedIn().account,
    );
    local.set(connected({ accountAccess: {} }));
    const box = accountConnection(buildBox)!;
    box.set(refused);
    await vi.advanceTimersByTimeAsync(0);
    expect(listed(buildBox)?.access).toEqual({ step: "needsCode" });

    const enter = (code: string) =>
      fake.handlers.get("parallax:enterSetupCode")!({}, `account:${buildBox}`, code) as Promise<
        string | undefined
      >;
    expect(await enter("12 34")).toBe("Enter the 6 digits it shows.");
    expect(fake.dials).toHaveLength(0);

    fake.dialOutput = { lines: [], code: 5 };
    const wrong = enter("482 913");
    await vi.advanceTimersByTimeAsync(0);
    expect(await wrong).toMatch(/wrong, used, or expired/);
    expect(fake.dials.at(-1)).toEqual({
      args: ["dial", "--account", buildBox, "--pair", "--name=macbook", "--", `relay:${buildBox}`],
      stdin: "482913\n",
    });
    expect(listed(buildBox)?.access).toMatchObject({
      step: "needsCode",
      error: expect.any(String),
    });

    const paired = {
      fingerprint: "f",
      name: "build-box",
      routes: ["10.0.0.5:7341", `relay:${buildBox}`],
    };
    fake.dialOutput = { lines: [JSON.stringify(paired)], code: 0 };
    const right = enter("123456");
    await vi.advanceTimersByTimeAsync(0);
    expect(await right).toBeUndefined();
    expect(merged).toContainEqual({
      approvedClients: [],
      removedClients: [],
      approvedHosts: [buildBox],
    });
    expect(box.retry).toHaveBeenCalled();
    expect(listed(buildBox)?.access).toBeUndefined();
    expect(box.options.command()?.slice(-2)).toEqual(["10.0.0.5:7341", `relay:${buildBox}`]);

    // Two runs so far; three more, then none this hour, without running plxd.
    fake.dialOutput = { lines: [], code: 5 };
    for (let i = 0; i < 3; i++) {
      const tried = enter("000000");
      await vi.advanceTimersByTimeAsync(0);
      await tried;
    }
    const dials = fake.dials.length;
    expect(await enter("000000")).toMatch(/5 tries/);
    expect(fake.dials).toHaveLength(dials);

    // The local plxd vouches for studio, so it signs in with a fresh token.
    fake.dialOutput = {
      lines: [
        '{"status":"pending","request":"r1","code":"731905"}',
        `{"status":"approved","name":"studio","routes":["192.168.1.30:7341","relay:${studio}"]}`,
      ],
      code: 0,
    };
    const connection = accountConnection(studio)!;
    connection.set(refused);
    await vi.advanceTimersByTimeAsync(5);
    expect(fake.dials.at(-1)).toEqual({
      args: [
        "dial",
        "--account",
        studio,
        "--sign-in",
        "--name=macbook",
        "--",
        "192.168.1.20:7341",
        `relay:${studio}`,
      ],
      stdin: "fresh-token\n",
    });
    expect(listed(studio)?.access).toEqual({ step: "pending", code: "731905" });
    await vi.advanceTimersByTimeAsync(20);
    expect(listed(studio)?.access).toBeUndefined();
    expect(connection.retry).toHaveBeenCalled();
    expect(connection.options.command()?.slice(-2)).toEqual([
      "192.168.1.30:7341",
      `relay:${studio}`,
    ]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("an account computer's agent install and CLI sign-in run in its own plxd's terminals, with no ssh", async () => {
  fake.answers.clear();
  try {
    await start({ accounts: [{ hostId: studio, name: "studio", routes: [] }] });
    const connection = accountConnection(studio)!;
    connection.set(connected());
    fake.answers.set("host/version", {
      result: { plxd: "1.0.0", protocol: { min: 1, max: 1 }, os: "linux", arch: "x86_64" },
    });
    fake.answers.set("accounts/list", {
      result: { clis: [{ cli: "claude", path: "/home/me/.local/bin/claude" }] },
    });
    const open = (target: object) =>
      fake.handlers.get("parallax:openTerminal")!(
        { sender: {} },
        "t1",
        { hostId: `account:${studio}`, ...target },
        80,
        24,
      );

    expect(await open({ install: "claude" })).toBeUndefined();
    expect(await open({ cli: "claude" })).toBeUndefined();
    type Opened = { runner: unknown; params: { command: { program: string; args: string[] } } };
    const [install, signIn] = fake.opened as Opened[];
    expect(install!.runner).toBe(connection);
    expect(install!.params.command.program).toBe("/bin/sh");
    expect(install!.params.command.args[0]).toBe("-lc");
    expect(signIn!.runner).toBe(connection);
    expect(signIn!.params.command).toMatchObject({ program: "/home/me/.local/bin/claude" });
    for (const each of fake.opened) expect(JSON.stringify(each.params)).not.toMatch(/\bssh\b/);
    expect(
      await fake.handlers.get("parallax:install")!({}, `account:${studio}`, "opencode"),
    ).toMatch(/install in a terminal there/);
  } finally {
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

/** Lists a connection answers `access/get` with, by connection; a wait never answers. */
function listsBy(of: (connection: unknown) => object | undefined) {
  return (params: { after?: number }, connection: unknown) =>
    params.after !== undefined
      ? new Promise(() => {})
      : {
          result: {
            version: 1,
            approvedClients: [],
            removedClients: [],
            approvedHosts: [],
            ...of(connection),
          },
        };
}

test("a connecting computer and this one copy approved and removed keys and host ids both ways", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const local = await start({ accounts: [{ hostId: studio, name: "studio", routes: [] }] });
    const connection = accountConnection(studio)!;
    fake.answers.set(
      "access/get",
      listsBy((c) =>
        c === local
          ? { approvedClients: ["k1", "k2"] }
          : { approvedClients: ["k3"], removedClients: ["k2"], approvedHosts: [buildBox] },
      ),
    );
    fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
      result: { hostId: c === local ? "self" : studio },
    }));
    const merged = new Map<unknown, unknown>();
    fake.answers.set("access/merge", (params: unknown, c: unknown) => {
      merged.set(c, params);
      return { result: {} };
    });
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(merged.size).toBe(0);

    connection.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    const union = {
      approvedClients: ["k1", "k3"],
      removedClients: ["k2"],
      approvedHosts: [buildBox, "self", studio].sort(),
    };
    expect(merged.get(local)).toEqual(union);
    expect(merged.get(connection)).toEqual(union);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("revoking a signed-in device here removes its key on every other computer this app reaches", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const local = await start({ accounts: [{ hostId: studio, name: "studio", routes: [] }] });
    const connection = accountConnection(studio)!;
    let revoked = false;
    fake.answers.set(
      "access/get",
      listsBy((c) => (c === local && revoked ? { removedClients: ["phone-key"] } : {})),
    );
    const sessions = { sessions: [], listening: true, pairing: false };
    fake.answers.set("remote/revoke", (params: { id: string }, c: unknown) => {
      revoked = c === local && params.id === "s1";
      return { result: sessions };
    });
    const removed: [unknown, unknown][] = [];
    fake.answers.set("access/remove", (params: unknown, c: unknown) => {
      removed.push([c, params]);
      return { result: {} };
    });
    local.set(connected({ accountAccess: {} }));
    connection.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);

    const answer = await fake.handlers.get("parallax:revokeDevice")!({}, "s1");
    expect(answer).toEqual(sessions);
    expect(removed).toEqual([[connection, { thumbprint: "phone-key" }]]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a tailnet device matched to its account computer by relay/id is approved over Tailscale, then dropped once the account one answers", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const device = { id: "n1", hostName: "thinkpad", ip: "100.64.0.2", os: "linux" };
    const local = await start(
      {
        localName: "macbook",
        devices: [device],
        accounts: [{ hostId: studio, name: "studio", routes: [] }],
      },
      signedIn().account,
    );
    fake.answers.set("host/settings/get", { result: { connect: true } });
    fake.answers.set("connect/devices", { result: { devices: [] } });
    // Nothing vouches for studio but the tailnet device with its relay id.
    fake.answers.set(
      "access/get",
      listsBy(() => ({})),
    );
    const tailnet = () => fake.made.find((c) => c.options.device === "thinkpad");
    fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
      result: { hostId: c === tailnet() ? studio : "self" },
    }));
    const approved: [unknown, unknown][] = [];
    fake.answers.set("access/approve", (params: unknown, c: unknown) => {
      approved.push([c, params]);
      return { result: {} };
    });
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    tailnet()!.set(connected());
    await vi.advanceTimersByTimeAsync(0);

    // studio has no session yet: it signs in, and the tailnet connection allows the request.
    fake.dialOutput = {
      lines: [
        '{"status":"pending","request":"r1","code":"731905"}',
        `{"status":"approved","name":"studio","routes":["192.168.1.30:7341"]}`,
      ],
      code: 0,
    };
    const account = accountConnection(studio)!;
    account.set(refused);
    await vi.advanceTimersByTimeAsync(5);
    expect(fake.dials.at(-1)?.args).toContain("--sign-in");
    expect(listed(studio)?.access).toEqual({ step: "pending", code: "731905" });
    expect(approved).toEqual([[tailnet(), { request: "r1" }]]);
    await vi.advanceTimersByTimeAsync(20);
    expect(account.retry).toHaveBeenCalled();

    // Once studio answers as `account:`, the tailnet connection goes, and discovery doesn't bring it back.
    const old = tailnet()!;
    account.set(connected());
    await vi.advanceTimersByTimeAsync(0);
    expect(old.disposed).toBe(true);
    expect((fake.sent.get("parallax:devices") as DeviceHost[]).map((d) => d.id)).toEqual([
      `account:${studio}`,
    ]);
    const made = fake.made.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.made.slice(made).some((c) => c.options.device === "thinkpad")).toBe(false);
    const saved = JSON.parse(readFileSync(path.join(fake.userData, "settings.json"), "utf8"));
    expect(saved.devices[0]).toMatchObject({ id: "n1", migrated: studio });
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});
