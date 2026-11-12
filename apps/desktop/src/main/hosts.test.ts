import { createHash } from "node:crypto";
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
    subscribe = vi.fn((_params: unknown, _listener: unknown) => () => {});
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
    dialOutput: { lines: [] as string[], code: 0 } as {
      lines: string[];
      code: number;
      /** What it writes to stderr, as plxd says why it failed. */
      stderr?: string;
      /** With this, a `--compare` run: it answers these and ends only on "allow" or "deny". */
      afterAllow?: string[];
    },
    opened: [] as { runner: unknown; params: unknown }[],
    /** Whether a window is on screen. */
    visible: false,
    /** Whether the OS says this computer has a network. */
    online: true,
    /** Whether the account's last refresh couldn't reach Clerk. */
    clerkDown: false,
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
  net: { isOnline: () => fake.online },
}));
vi.mock("./windows", () => ({
  broadcast: (channel: string, value: unknown) => {
    if (channel === "parallax:connect") fake.connect.push(value);
    fake.sent.set(channel, value);
  },
  perWindow: () => new Map(),
  anyWindowVisible: () => fake.visible,
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
    const { record, lines, afterAllow, stderr, code } = run(args);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    if (stderr) child.stderr.write(stderr);
    const end = (exit: number | null) => {
      child.stdout.end();
      child.emit("close", exit);
    };
    child.stdin.on("data", (chunk: Buffer) => {
      record.stdin += String(chunk);
      if (!afterAllow) return;
      if (String(chunk).includes("deny")) return end(5);
      if (!String(chunk).includes("allow")) return;
      afterAllow.forEach((line) => child.stdout.write(`${line}\n`));
      setTimeout(() => end(code), 10);
    });
    // A line every 10 ms, so a test sees where a sign-in stands between them.
    lines.forEach((line, i) => setTimeout(() => child.stdout.write(`${line}\n`), 10 * i));
    if (!afterAllow) setTimeout(() => end(code), 10 * lines.length);
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

/** A Clerk token as the account hands it out: a JWT for user `user_1`, unsigned here. */
const clerkToken = (use: string) =>
  [{ alg: "RS256" }, { sub: "user_1", use }, "sig"]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
const relayToken = clerkToken("relay");
const freshToken = clerkToken("fresh");
/** `token`'s SHA-256, as `relay/sign` takes it. */
const hashOf = (token: string) => createHash("sha256").update(token).digest("base64url");

/** A fake signed-in account, whose sign-ins the test calls. */
function signedIn() {
  const listeners: (() => void)[] = [];
  return {
    account: {
      accessToken: async () => relayToken,
      currentToken: () => relayToken,
      freshToken: async () => freshToken,
      onSignIn: (listener: () => void) => void listeners.push(listener),
      clerkUnreachable: () => fake.clerkDown,
    },
    signIn: () => listeners.forEach((listener) => listener()),
  };
}

const studio = "alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o";
const buildBox = "Q2s9vX1k7d0b8Lr4mT6pWc3eYh5uNz2aFgJ_iK-oPqR";
const newBox = "Z9y8Xw7V6u5T4s3R2q1P0o9N8m7L6k5J4i3H2g1F0eD";
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
  fake.made.findLast((c) => c.options.command()?.includes(`--account=${relayId}`));

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
    const { "content-security-policy": policy, ...headers } = Object.fromEntries(
      some.response.headers,
    );
    expect(headers).toEqual({
      "accept-ranges": "bytes",
      "content-length": "4",
      "content-range": "bytes 2-5/20",
      "content-type": "video/mp4",
    });
    expect(policy).toMatch(/^sandbox allow-scripts allow-forms;/);
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

    // An HTML file is a page, which the side panel frames (PLX-1484), sandboxed by its policy.
    const page = await streamFile("plx-file://file/local/run-1/report.html", null);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(policy);

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

test("the account's computers are asked for on sign-in, focus, the network, Settings opening, and a timer only while a window shows", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { account, signIn } = signedIn();
    let asked = 0;
    let hosts = [
      { hostId: studio, name: "studio", online: true, thisComputer: false },
      { hostId: buildBox, name: "macbook", online: true, thisComputer: true },
    ];
    let removed: string[] = [];
    fake.answers.set("relay/hosts", () => (asked++, { result: { hosts, removed } }));
    const local = await start({}, account);
    // The local plxd connecting asks once.
    local.set(connected());
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(1);
    const connection = accountConnection(studio)!;
    expect(connection.options.command()).toEqual([
      process.execPath,
      "dial",
      `--account=${studio}`,
      "--",
      `relay:${studio}`,
    ]);
    expect(connection.options.env?.()).toEqual({ PLXD_RELAY_TOKEN: relayToken });
    expect(accountConnection(buildBox)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked).toBe(1);

    // A window on screen reads the list by itself, and discovery runs only when it changed, so a
    // new computer's prompt appears unasked and nothing dials on every read.
    fake.visible = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(asked).toBe(2);
    const dials = fake.dials.length;
    const retries = connection.retry.mock.calls.length;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(asked).toBe(5);
    expect(fake.dials.length).toBe(dials);
    expect(connection.retry.mock.calls.length).toBe(retries);
    hosts = [...hosts, { hostId: newBox, name: "new-box", online: true, thisComputer: false }];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(listed(newBox)?.name).toBe("new-box");
    hosts = hosts.slice(0, 2);
    await vi.advanceTimersByTimeAsync(15_000);
    fake.visible = false;
    asked = 1;

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

    // One the account no longer lists stays, and one the relay marks removed is dropped.
    hosts = hosts.slice(1);
    await fake.handlers.get("parallax:discoverAccount")!();
    expect(listed(studio)).toBeDefined();
    removed = [studio];
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
      `--account=${studio}`,
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
    // It answers with its key, so the dialog asks for its code.
    fake.dialOutput = { lines: [`{"route":"relay:${buildBox}"}`], code: 0 };
    box.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    // It shows no code to compare here, so typing is what's left.
    expect(fake.dials.map((d) => d.args[1])).toEqual(["--probe", `--account=${buildBox}`]);
    expect(fake.dials[1]?.args).toContain("--compare");
    expect(listed(buildBox)?.access).toEqual({ step: "needsCode" });

    const enter = (code: string) =>
      fake.handlers.get("parallax:enterSetupCode")!({}, `account:${buildBox}`, code) as Promise<
        string | undefined
      >;
    expect(await enter("12 34")).toBe("Enter the 6 digits it shows.");
    expect(fake.dials).toHaveLength(2);

    fake.dialOutput = { lines: [], code: 5 };
    const wrong = enter("482 913");
    await vi.advanceTimersByTimeAsync(0);
    expect(await wrong).toMatch(/wrong, used, or expired/);
    expect(fake.dials.at(-1)).toEqual({
      args: [
        "dial",
        `--account=${buildBox}`,
        "--pair",
        "--name=macbook",
        "--",
        `relay:${buildBox}`,
      ],
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
        `--account=${studio}`,
        "--sign-in",
        "--name=macbook",
        "--",
        "192.168.1.20:7341",
        `relay:${studio}`,
      ],
      stdin: `${freshToken}\n`,
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

test("a window's subscription reaches plxd with its project, which shell needs", async () => {
  fake.answers.clear();
  const local = await start({});
  try {
    const params = { after: 7, logId: "log-1", project: "o-1", shell: true };
    fake.handlers.get("parallax:subscribe")!({ sender: {} }, "local", "key-1", params);
    expect(local.subscribe.mock.calls[0]?.[0]).toEqual(params);
  } finally {
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a relay id that starts with a hyphen reaches plxd as a value, not a flag", async () => {
  fake.answers.clear();
  const hyphen = "-Kz8DTElabcdefghijklmnopqrstuvwxyz012345678";
  try {
    await start({ accounts: [{ hostId: hyphen, name: "box", routes: [] }] });
    expect(accountConnection(hyphen)!.options.command()).toContain(`--account=${hyphen}`);
  } finally {
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

/**
 * The local plxd, connection `local`, as a store: it keeps merged restrictions and answers with
 * them, and fails while `down`. Other connections answer `access/get` with `others`. `merged` is
 * every merge asked for, and a merge wakes the watch on `local`.
 */
function ownPlxd(local: unknown, others: (connection: unknown) => object = () => ({})) {
  const plxd = { down: false, allowedHosts: [] as string[], merged: [] as unknown[] };
  let wake = () => {};
  const none = { version: 1, approvedClients: [], removedClients: [], approvedHosts: [] };
  const lists = () => ({ ...none, allowedHosts: plxd.allowedHosts });
  const restarted = { error: { code: -32000, message: "plxd restarted" } };
  fake.answers.set("access/get", (params: { after?: number }, c: unknown) => {
    if (params.after !== undefined)
      return new Promise((resolve) => {
        if (c === local) wake = () => resolve({ result: lists() });
      });
    if (c !== local) return { result: { ...none, ...others(c) } };
    return plxd.down ? restarted : { result: lists() };
  });
  fake.answers.set("access/merge", (params: { allowedHosts?: string[] }, c: unknown) => {
    plxd.merged.push(params);
    if (c !== local) return { result: lists() };
    if (plxd.down) return restarted;
    plxd.allowedHosts = [...new Set([...plxd.allowedHosts, ...(params.allowedHosts ?? [])])];
    wake();
    return { result: lists() };
  });
  return plxd;
}

/** `plxd dial` answers with each of `runs` in turn, staying on the last. */
function dialRuns(
  ...runs: { lines: string[]; afterAllow?: string[]; stderr?: string; code: number }[]
) {
  fake.dialOutput = {
    get lines() {
      return runs[0]!.lines;
    },
    get afterAllow() {
      return runs[0]!.afterAllow;
    },
    get stderr() {
      return runs[0]!.stderr;
    },
    get code() {
      return (runs.length > 1 ? runs.shift()! : runs[0]!).code;
    },
  };
}

const offline: ConnectionState = {
  status: "failed",
  error: { reason: "unresponsive", message: "It's offline." },
  retrying: true,
};
const pendingLine = '{"status":"pending","request":"r1","code":"482913"}';
const approvedLine = '{"status":"approved","name":"build-box","routes":[]}';

/**
 * A signed-in app using `studio` and `buildBox`, whose lists `lists` adds to, and its removals.
 * `own` is what this computer's plxd lists.
 */
async function usingBoth(
  lists: object | ((connection: unknown) => object) = {},
  own: object = { approvedHosts: [studio, buildBox] },
  account = signedIn().account,
) {
  const local = await start(
    {
      localName: "macbook",
      accounts: [
        { hostId: studio, name: "studio", routes: [] },
        { hostId: buildBox, name: "build-box", routes: [] },
      ],
    },
    account,
  );
  const removed: unknown[] = [];
  fake.answers.set("access/remove", (params: unknown, c: unknown) => {
    removed.push([c === local, params]);
    return { result: {} };
  });
  fake.answers.set(
    "access/get",
    listsBy((c) => (c === local ? own : typeof lists === "function" ? lists(c) : lists)),
  );
  return {
    local,
    removed,
    first: accountConnection(studio)!,
    second: accountConnection(buildBox)!,
  };
}

const signInRuns = () => fake.dials.filter((d) => d.args.includes("--sign-in"));

const allowAlone = { approvedHosts: [studio], allowedHosts: [buildBox] };

test("a computer added with Allow alone can't lead this app to start over", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const claim = { removedClients: ["old-key"], readOnlyClients: ["old-key"] };
    const { local, removed, second } = await usingBoth(
      (c) => (c === accountConnection(buildBox) ? claim : {}),
      allowAlone,
    );
    dialRuns(
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      // Its refusal of the sign-in says the same.
      { lines: [], code: 6 },
    );
    local.set(connected({ accountAccess: {} }));
    second.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    second.set(refused);
    await vi.advanceTimersByTimeAsync(30);
    expect(signInRuns()).toHaveLength(1);
    expect(listed(buildBox)?.access).toMatchObject({
      step: "ask",
      why: expect.stringMatching(/Allow alone/) as string,
    });
    expect(fake.sent.get("parallax:keyStanding")).toBeUndefined();

    expect(await fake.handlers.get("parallax:startOver")!()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30);
    expect(removed).toEqual([]);
    expect(fake.dials.map((d) => d.args[1])).not.toContain("--new-device-key");
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("starting over sends a computer added with Allow alone no token, and a second click does nothing", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { local, removed, first, second } = await usingBoth(
      (c) => (c === accountConnection(studio) ? { readOnlyClients: ["old-key"] } : {}),
      allowAlone,
    );
    dialRuns(
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"new-key"}'], code: 0 },
      // The verified computer's request is denied.
      { lines: [pendingLine], code: 5 },
    );
    local.set(connected({ accountAccess: {} }));
    first.set(connected({ accountAccess: {} }));
    second.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent.get("parallax:keyStanding")).toBe("readOnly");

    const started = fake.handlers.get("parallax:startOver")!();
    const again = fake.handlers.get("parallax:startOver")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toBeUndefined();
    expect(await again).toBeUndefined();
    first.set(refused);
    second.set(refused);
    await vi.advanceTimersByTimeAsync(30);

    expect(removed).toEqual([[true, { thumbprint: "old-key" }]]);
    expect(signInRuns().map((d) => d.args[1])).toEqual([`--account=${studio}`]);
    expect(listed(studio)?.access?.step).toBe("ask");
    expect(listed(buildBox)?.access).toEqual({ step: "needsCode", quiet: true });

    // With no mark left, another click doesn't remove the new key.
    expect(await fake.handlers.get("parallax:startOver")!()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(removed).toHaveLength(1);
    expect(fake.dials.filter((d) => d.args[1] === "--new-device-key")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a sign-in waiting on its token when this app starts over never runs", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const held = signedIn().account;
    let release = () => {};
    const account = {
      ...held,
      freshToken: () => new Promise<string>((resolve) => (release = () => resolve(freshToken))),
    };
    const { local, first, second } = await usingBoth(
      (c) => (c === accountConnection(studio) ? { readOnlyClients: ["old-key"] } : {}),
      undefined,
      account,
    );
    dialRuns(
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"new-key"}'], code: 0 },
      { lines: [pendingLine], code: 5 },
    );
    local.set(connected({ accountAccess: {} }));
    first.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    // The other computer's sign-in now waits on its token.
    second.set(refused);
    await vi.advanceTimersByTimeAsync(1);
    const stale = release;

    const started = fake.handlers.get("parallax:startOver")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toBeUndefined();
    stale();
    await vi.advanceTimersByTimeAsync(1);
    expect(signInRuns()).toEqual([]);
    // The ask that starting over made is the one that goes on, to the first verified computer.
    release();
    await vi.advanceTimersByTimeAsync(30);
    expect(signInRuns().map((d) => d.args[1])).toEqual([`--account=${studio}`]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("starting over removes the old key, then asks one computer at a time, and a refusal asks no others", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { local, removed, first, second } = await usingBoth();
    dialRuns(
      { lines: [], code: 6 },
      { lines: [], code: 6 },
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"new-key"}'], code: 0 },
      // The first is out of reach, so the second is asked, and its request is denied.
      { lines: [], code: 4 },
      { lines: [pendingLine], code: 5 },
    );
    local.set(connected({ accountAccess: {} }));
    first.set(refused);
    second.set(refused);
    await vi.advanceTimersByTimeAsync(30);
    expect(fake.sent.get("parallax:keyStanding")).toBe("removed");
    expect(listed(studio)?.access).toMatchObject({
      step: "ask",
      why: expect.stringMatching(/removed/) as string,
    });

    fake.dials.length = 0;
    const started = fake.handlers.get("parallax:startOver")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toBeUndefined();
    expect(removed).toEqual([[true, { thumbprint: "old-key" }]]);
    expect(fake.dials.slice(0, 2).map((d) => d.args[1])).toEqual([
      "--device-key",
      "--new-device-key",
    ]);
    expect(fake.sent.get("parallax:keyStanding")).toBeNull();
    expect(first.reconnect).toHaveBeenCalled();
    expect(second.reconnect).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30);
    expect(signInRuns().map((d) => d.args[1])).toEqual([
      `--account=${studio}`,
      `--account=${buildBox}`,
    ]);
    expect(listed(buildBox)?.access?.step).toBe("ask");
    expect(listed(studio)?.access?.step).toBe("ask");
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a computer the relay says is offline reads as Offline, asks nothing, and signs in once it's online", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { local, second } = await usingBoth();
    dialRuns(
      {
        lines: [],
        stderr: "plxd dial: could not sign in: the relay's WebSocket failed: HTTP 503\n",
        code: 4,
      },
      { lines: [], code: 0 },
    );
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    second.set(refused);
    await vi.advanceTimersByTimeAsync(30);
    expect(listed(buildBox)?.access).toEqual({ step: "offline" });
    expect(signInRuns()).toHaveLength(1);

    // While the relay lists it offline, nothing runs again.
    const listing = (online: boolean) => ({
      result: { hosts: [{ hostId: buildBox, name: "build-box", online, thisComputer: false }] },
    });
    const discover = fake.handlers.get("parallax:discoverAccount")!;
    fake.answers.set("relay/hosts", listing(false));
    await discover();
    await vi.advanceTimersByTimeAsync(30);
    expect(signInRuns()).toHaveLength(1);

    fake.answers.set("relay/hosts", listing(true));
    await discover();
    await vi.advanceTimersByTimeAsync(30);
    expect(signInRuns()).toHaveLength(2);
    expect(listed(buildBox)?.access).toBeUndefined();
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a computer that dropped off the relay between two list reads signs in at the next read", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { local, second } = await usingBoth();
    dialRuns(
      {
        lines: [],
        stderr: "plxd dial: could not sign in: the relay's WebSocket failed: HTTP 503\n",
        code: 4,
      },
      { lines: [], code: 0 },
    );
    // The list says it's online throughout, so it never changes.
    fake.answers.set("relay/hosts", {
      result: {
        hosts: [{ hostId: buildBox, name: "build-box", online: true, thisComputer: false }],
      },
    });
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    second.set(refused);
    await vi.advanceTimersByTimeAsync(30);
    expect(listed(buildBox)?.access).toEqual({ step: "offline" });
    expect(signInRuns()).toHaveLength(1);

    fake.visible = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signInRuns()).toHaveLength(2);
    expect(listed(buildBox)?.access).toBeUndefined();
  } finally {
    fake.visible = false;
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("once one computer lets a new key in, the rest sign in, and a read-only mark is noticed", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { local, first, second } = await usingBoth({ readOnlyClients: ["old-key", "another"] });
    dialRuns(
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"old-key"}'], code: 0 },
      { lines: ['{"thumbprint":"new-key"}'], code: 0 },
      { lines: [pendingLine], code: 0 },
    );
    local.set(connected({ accountAccess: {} }));
    first.set(connected({ accountAccess: {} }));
    second.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent.get("parallax:keyStanding")).toBe("readOnly");

    fake.dials.length = 0;
    const started = fake.handlers.get("parallax:startOver")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(await started).toBeUndefined();
    first.set(refused);
    second.set(refused);
    // While the first waits for its Allow, the second doesn't ask.
    await vi.advanceTimersByTimeAsync(5);
    expect(listed(studio)?.access).toEqual({ step: "pending", code: "482913" });
    expect(signInRuns()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(first.retry).toHaveBeenCalled();
    expect(signInRuns().map((d) => d.args[1])).toEqual([
      `--account=${studio}`,
      `--account=${buildBox}`,
    ]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a restriction learned from another computer holds after the relay cuts that computer off", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const local = await start(
      {
        localName: "macbook",
        accounts: [
          { hostId: studio, name: "studio", routes: [] },
          { hostId: buildBox, name: "build-box", routes: [] },
        ],
      },
      signedIn().account,
    );
    const real = accountConnection(studio)!;
    const attacker = accountConnection(buildBox)!;
    let told = false;
    const plxd = ownPlxd(local, (c) =>
      c === real && told
        ? { allowedHosts: [buildBox] }
        : c === attacker
          ? { approvedClients: ["attacker"] }
          : {},
    );
    fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
      result: { hostId: c === local ? "self" : studio },
    }));
    dialRuns({ lines: [approvedLine], code: 0 });
    local.set(connected({ accountAccess: {} }));
    real.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);

    // Another device adds the fake computer, so the real one, already connected and synced, learns
    // its mark and vouches for it, and it signs in. The relay then cuts the real one off before
    // the fake one connects, leaving this computer's plxd as the only word on it.
    told = true;
    attacker.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    expect(fake.dials.filter((d) => d.args.includes("--sign-in"))).toHaveLength(1);
    real.set(offline);
    plxd.merged.length = 0;
    attacker.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(20);

    expect(JSON.stringify(plxd.merged)).not.toContain("attacker");
    expect(plxd.allowedHosts).toEqual([buildBox]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a computer another one restricted gets no sign-in until this computer's plxd has saved that", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const local = await start(
      {
        localName: "macbook",
        accounts: [
          { hostId: studio, name: "studio", routes: [] },
          { hostId: buildBox, name: "build-box", routes: [] },
        ],
      },
      signedIn().account,
    );
    const real = accountConnection(studio)!;
    const restricted = accountConnection(buildBox)!;
    let told = false;
    const tellsOfIt = (c: unknown) => (c === real && told ? { allowedHosts: [buildBox] } : {});
    const plxd = ownPlxd(local, tellsOfIt);
    fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
      result: { hostId: c === local ? "self" : studio },
    }));
    const signIns = () => fake.dials.filter((d) => d.args.includes("--sign-in"));
    dialRuns({ lines: [], code: 5 });
    local.set(connected({ accountAccess: {} }));
    real.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);

    // A write that fails, and an older plxd that answers without keeping the list, both block it.
    told = true;
    plxd.down = true;
    restricted.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    expect(signIns()).toEqual([]);
    plxd.down = false;
    fake.answers.set("access/merge", () => ({ result: { version: 1, approvedHosts: [] } }));
    restricted.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    expect(signIns()).toEqual([]);

    ownPlxd(local, tellsOfIt);
    restricted.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    expect(signIns()).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

/** A signed-in app showing new computer `buildBox`'s code, whose host lists an attacker's key. */
async function showingCode(run: { afterAllow: string[]; code: number }) {
  const local = await start(
    { localName: "macbook", accounts: [{ hostId: buildBox, name: "build-box", routes: [] }] },
    signedIn().account,
  );
  const box = accountConnection(buildBox)!;
  const plxd = ownPlxd(local, (c) => (c === box ? { approvedClients: ["attacker"] } : {}));
  fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
    result: { hostId: c === local ? "self" : studio },
  }));
  dialRuns({ lines: [`{"route":"relay:${buildBox}"}`], code: 0 }, { lines: [pendingLine], ...run });
  local.set(connected({ accountAccess: {} }));
  box.set(refused);
  await vi.advanceTimersByTimeAsync(5);
  expect(listed(buildBox)?.access).toEqual({ step: "compare", code: "482913" });
  const allow = () => fake.handlers.get("parallax:answerCompare")!({}, `account:${buildBox}`, true);
  return { local, box, plxd, allow };
}

test("a plxd restart while Allow waits leaves the fake computer restricted when plxd returns", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { local, box, plxd, allow } = await showingCode({ afterAllow: [approvedLine], code: 0 });
    const answer = allow();
    // plxd goes down while the separate `plxd dial` waits for the computer's final answer.
    plxd.down = true;
    local.set(offline);
    await vi.advanceTimersByTimeAsync(20);
    await expect(answer).resolves.toBeUndefined();
    expect(box.retry).toHaveBeenCalled();

    // The session on disk connects, and plxd comes back.
    box.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(5);
    plxd.down = false;
    plxd.merged.length = 0;
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.stringify(plxd.merged)).not.toContain("attacker");
    expect(plxd.allowedHosts).toEqual([buildBox]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("Allow doesn't reach a new computer when its restriction can't be saved", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { box, plxd, allow } = await showingCode({ afterAllow: [approvedLine], code: 0 });
    plxd.down = true;
    const answer = allow();
    await vi.advanceTimersByTimeAsync(30);
    await expect(answer).resolves.toMatch(/couldn't/i);
    const dial = fake.dials.find((d) => d.args.includes("--compare"))!;
    expect(dial.stdin).toContain("deny");
    expect(dial.stdin).not.toContain("allow");
    expect(box.retry).not.toHaveBeenCalled();
    expect(plxd.allowedHosts).toEqual([]);
    expect(listed(buildBox)?.access).toMatchObject({
      step: "needsCode",
      error: expect.stringMatching(/couldn't/i),
    });
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("saving Allow's restriction leaves the request running, and if it then ends, the typed code", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { box, plxd, allow } = await showingCode({ afterAllow: [], code: 5 });
    const compare = fake.dials.find((d) => d.args.includes("--compare"))!;
    const signIns = () => fake.dials.filter((d) => d.args.includes("--sign-in"));
    const started = signIns().length;
    const answer = allow();
    // The save wakes this app's watch on its plxd, which isn't another computer vouching.
    await vi.advanceTimersByTimeAsync(1);
    expect(plxd.allowedHosts).toEqual([buildBox]);
    expect(compare.stdin).toContain("allow");
    expect(compare.stdin).not.toContain("deny");

    await vi.advanceTimersByTimeAsync(20);
    await expect(answer).resolves.toMatch(/Type the code/);
    expect(listed(buildBox)?.access).toMatchObject({ step: "needsCode" });

    // Its own mark vouches for nothing: a look later still asks for the code, with no new sign-in.
    box.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    expect(signIns()).toHaveLength(started);
    expect(listed(buildBox)?.access).toMatchObject({ step: "needsCode" });
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("with this computer's plxd down, whose lists hold the restrictions, nothing is copied", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    await start({
      accounts: [
        { hostId: studio, name: "studio", routes: [] },
        { hostId: buildBox, name: "build-box", routes: [] },
      ],
    });
    const real = accountConnection(studio)!;
    const restricted = accountConnection(buildBox)!;
    fake.answers.set(
      "access/get",
      listsBy((c) => (c === restricted ? { approvedClients: ["attacker"] } : {})),
    );
    fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
      result: { hostId: c === real ? studio : buildBox },
    }));
    const merged: unknown[] = [];
    fake.answers.set("access/merge", (params: unknown) => (merged.push(params), { result: {} }));
    real.set(connected({ accountAccess: {} }));
    restricted.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(merged).toEqual([]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a computer added with Allow gives no lists even if it lies about its id, and older clients never see it", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const local = await start({
      accounts: [
        { hostId: studio, name: "studio", routes: [] },
        { hostId: buildBox, name: "build-box", routes: [] },
      ],
    });
    const real = accountConnection(studio)!;
    const fakeHost = accountConnection(buildBox)!;
    fake.answers.set(
      "access/get",
      listsBy((c) =>
        c === local
          ? { allowedHosts: [buildBox] }
          : c === fakeHost
            ? {
                approvedClients: ["attacker"],
                removedClients: ["my-laptop"],
                approvedHosts: ["attacker-host"],
              }
            : { approvedClients: ["k1"] },
      ),
    );
    // The inner TLS proves this is the computer pinned as build-box, not what its JSON says.
    fake.answers.set("relay/id", (_p: unknown, c: unknown) => ({
      result: { hostId: c === local ? "self" : studio },
    }));
    const merged: {
      approvedClients: string[];
      removedClients: string[];
      approvedHosts: string[];
    }[] = [];
    fake.answers.set("access/merge", (params: never) => (merged.push(params), { result: {} }));
    local.set(connected({ accountAccess: {} }));
    real.set(connected({ accountAccess: {} }));
    fakeHost.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);

    expect(merged.length).toBeGreaterThan(0);
    for (const params of merged) {
      expect(params.approvedClients).not.toContain("attacker");
      expect(params.removedClients).not.toContain("my-laptop");
      expect(params.approvedHosts).not.toContain("attacker-host");
      // An older client reads only this list, so a restricted computer stays out of it.
      expect(params.approvedHosts).not.toContain(buildBox);
    }
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
    const registered: [string, unknown, unknown][] = [];
    for (const method of ["relay/sign", "relay/register"])
      fake.answers.set(method, (params: unknown, c: unknown) => {
        registered.push([method, c, params]);
        return { result: method === "relay/sign" ? { signature: "s" } : {} };
      });
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    tailnet()!.set(connected());
    await vi.advanceTimersByTimeAsync(0);

    // The tailnet device is registered under the account with the token's user id, which its plxd
    // records as its account, so the account sign-in below isn't refused for want of one (0091).
    expect(registered.filter(([, c]) => c === tailnet())).toEqual([
      ["relay/sign", tailnet(), { tokenHash: hashOf(relayToken), userId: "user_1" }],
    ]);
    // This computer posts it, beside its own registration.
    expect(registered.filter(([method]) => method === "relay/register")).toEqual([
      ["relay/register", local, { token: relayToken }],
      ["relay/register", local, { token: relayToken, signed: { signature: "s" } }],
    ]);

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

test("Reach from anywhere on a tailnet device registers it under the account and turns on relay and remote there", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const device = { id: "n1", hostName: "thinkpad", ip: "100.64.0.2", os: "linux" };
    const local = await start({ devices: [device] }, signedIn().account);
    fake.answers.set("host/settings/get", { result: { connect: true } });
    fake.answers.set("connect/devices", { result: { devices: [] } });
    local.set(connected());
    await vi.advanceTimersByTimeAsync(0);
    const tailnet = fake.made.find((c) => c.options.device === "thinkpad")!;
    tailnet.set(connected());
    await vi.advanceTimersByTimeAsync(0);

    const calls: [string, unknown, unknown][] = [];
    for (const method of ["relay/sign", "relay/register", "host/settings/set"])
      fake.answers.set(method, (params: unknown, c: unknown) => {
        calls.push([method, c, params]);
        return { result: method === "relay/sign" ? { signature: "s" } : {} };
      });
    const turn = (id: string) => fake.handlers.get("parallax:turnOnReach")!({}, id);
    expect(await turn("local")).toMatch(/can't reach/);
    expect(await turn(`tailnet:${device.id}`)).toBeUndefined();
    expect(calls.map(([method, c]) => [method, c === tailnet ? "thinkpad" : "local"])).toEqual([
      ["relay/sign", "thinkpad"],
      ["relay/register", "local"],
      ["host/settings/set", "thinkpad"],
    ]);
    expect(calls[0]?.[2]).toEqual({ tokenHash: hashOf(relayToken), userId: "user_1" });
    expect(calls.at(-1)?.[2]).toEqual({ relay: true, remote: true });
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("an account computer's routes are read again from relay/id once it connects and on a network change", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    await start({ accounts: [{ hostId: studio, name: "studio", routes: ["192.168.1.20:7341"] }] });
    const connection = accountConnection(studio)!;
    let reported: { hostId: string; routes?: string[] } = {
      hostId: studio,
      routes: ["10.0.0.9", "100.70.1.2", `relay:${studio}`],
    };
    fake.answers.set("relay/id", () => ({ result: reported }));
    const dialed = () => connection.options.command()?.slice(4);

    connection.set(connected());
    await vi.advanceTimersByTimeAsync(0);
    expect(dialed()).toEqual(["10.0.0.9", "100.70.1.2", `relay:${studio}`]);

    reported = { hostId: studio, routes: ["10.0.0.12:7400", `relay:${studio}`] };
    fake.handlers.get("parallax:network")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(dialed()).toEqual(["10.0.0.12:7400", `relay:${studio}`]);

    // An older plxd reports no routes, and another key's answer is never taken: both keep them.
    for (const answer of [{ hostId: studio }, { hostId: buildBox, routes: ["10.9.9.9"] }]) {
      reported = answer;
      fake.handlers.get("parallax:network")!();
      await vi.advanceTimersByTimeAsync(0);
      expect(dialed()).toEqual(["10.0.0.12:7400", `relay:${studio}`]);
    }
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a new account computer that's offline or doesn't answer waits in Settings, and is asked for its code once it answers", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    let online = false;
    fake.answers.set("relay/hosts", () => ({
      result: { hosts: [{ hostId: buildBox, name: "mac-mini", online, thisComputer: false }] },
    }));
    fake.answers.set("access/get", accessState([]));
    const local = await start({}, signedIn().account);
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    const box = accountConnection(buildBox)!;
    // An old install's leftover entry: the relay lists it offline, so nothing is dialed for it.
    box.set(refused);
    await vi.advanceTimersByTimeAsync(1);
    expect(listed(buildBox)?.access).toEqual({ step: "needsCode", offline: true });
    expect(fake.dials).toHaveLength(0);

    // Listed online, but none of its routes answers with its key: still offline.
    online = true;
    fake.dialOutput = { lines: [], code: 4 };
    fake.appEvents.get("browser-window-focus")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.dials.map((d) => d.args[1])).toEqual(["--probe"]);
    expect(listed(buildBox)?.access).toEqual({ step: "needsCode", offline: true });

    // Once it answers, the dialog may ask. Its listener starting changes nothing in the list, so
    // the timer probes it again, with no focus change, and the prompt appears on its own.
    fake.dialOutput = { lines: [`{"route":"relay:${buildBox}"}`], code: 0 };
    fake.visible = true;
    await vi.advanceTimersByTimeAsync(15_021);
    fake.visible = false;
    expect(listed(buildBox)?.access).toEqual({ step: "needsCode" });
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a new account computer's code is compared once, and one added by Allow is marked so no lists come from it", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const merged: unknown[] = [];
    fake.answers.set("access/merge", (params: object) => (merged.push(params), { result: params }));
    fake.answers.set("access/get", accessState([]));
    const local = await start(
      { localName: "macbook", accounts: [{ hostId: buildBox, name: "build-box", routes: [] }] },
      signedIn().account,
    );
    local.set(connected({ accountAccess: {} }));
    const box = accountConnection(buildBox)!;
    const pending = '{"status":"pending","request":"r1","code":"482913"}';
    const approved = `{"status":"approved","name":"build-box","routes":["10.0.0.5:7341"]}`;

    // A request that ends with no Allow leaves the typed code, and doesn't start another. The
    // probe answers first, then the compare, each with its own output.
    const runs = [
      { lines: [`{"route":"relay:${buildBox}"}`], code: 0 },
      { lines: [pending], code: 5 },
    ];
    fake.dialOutput = {
      get lines() {
        return (runs[0] ?? { lines: [] }).lines;
      },
      get code() {
        return (runs.length > 1 ? runs.shift()! : (runs[0] ?? { code: 0 })).code;
      },
    };
    box.set(refused);
    await vi.advanceTimersByTimeAsync(5);
    expect(listed(buildBox)?.access).toEqual({ step: "compare", code: "482913" });
    await vi.advanceTimersByTimeAsync(10);
    expect(listed(buildBox)?.access).toMatchObject({
      step: "needsCode",
      error: expect.stringContaining("Type the code"),
    });
    expect(merged).toEqual([]);
    const dials = fake.dials.length;
    box.set(refused);
    await vi.advanceTimersByTimeAsync(20);
    expect(fake.dials.filter((d) => d.args.includes("--compare"))).toHaveLength(1);
    expect(fake.dials.length).toBeLessThanOrEqual(dials + 1);

    // The user asks again: Allow marks the computer, then gets a session.
    fake.dialOutput = { lines: [pending], afterAllow: [approved], code: 0 };
    void fake.handlers.get("parallax:askAgain")!({}, `account:${buildBox}`);
    await vi.advanceTimersByTimeAsync(5);
    const allowed = fake.handlers.get("parallax:answerCompare")!({}, `account:${buildBox}`, true);
    await vi.advanceTimersByTimeAsync(30);
    await expect(allowed).resolves.toBeUndefined();
    expect(merged).toContainEqual({
      approvedClients: [],
      removedClients: [],
      approvedHosts: [],
      allowedHosts: [buildBox],
    });
    expect(box.retry).toHaveBeenCalled();
    expect(listed(buildBox)?.access).toBeUndefined();
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("Remove takes a computer off the account and forgets it everywhere, unless the relay refuses", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    let hosts = [{ hostId: buildBox, name: "box", online: true, thisComputer: false }];
    const calls: string[] = [];
    fake.answers.set("relay/hosts", () => ({ result: { hosts } }));
    fake.answers.set("access/get", accessState([]));
    fake.answers.set("host/settings/set", (params: unknown) => {
      calls.push(`set ${JSON.stringify(params)}`);
      return { result: {} };
    });
    fake.answers.set("access/forgetHost", (params: unknown) => {
      calls.push(`forget ${(params as { hostId: string }).hostId}`);
      return { result: {} };
    });
    let refuse = true;
    fake.answers.set("relay/remove", (params: unknown) => {
      if (refuse) return { error: { code: -32603, message: "the relay refused" } };
      calls.push(`remove ${(params as { hostId: string }).hostId}`);
      hosts = [];
      return { result: { hosts } };
    });
    const local = await start({}, signedIn().account);
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    const box = accountConnection(buildBox)!;
    box.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(0);
    const remove = () => fake.handlers.get("parallax:removeDevice")!({}, `account:${buildBox}`);

    // If the relay refuses, the user hears why, and nothing is forgotten.
    expect(await remove()).toBe("the relay refused");
    expect(box.disposed).toBe(false);
    expect(listed(buildBox)).toBeDefined();
    expect(calls).toEqual([]);

    refuse = false;
    calls.length = 0;
    expect(await remove()).toBeUndefined();
    expect(calls).toEqual([
      `remove ${buildBox}`,
      'set {"relay":false}',
      // The local plxd is the one left: the removed computer's connection is gone by now.
      `forget ${buildBox}`,
    ]);
    expect(box.disposed).toBe(true);
    expect(listed(buildBox)).toBeUndefined();
    const saved = JSON.parse(readFileSync(path.join(fake.userData, "settings.json"), "utf8"));
    expect(saved.accounts).toEqual([]);

    // Set up again, it's a new computer here.
    hosts = [{ hostId: buildBox, name: "box", online: true, thisComputer: false }];
    fake.handlers.get("parallax:discoverAccount")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(listed(buildBox)).toBeDefined();
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("this computer can't remove itself", async () => {
  fake.answers.clear();
  try {
    let removed = false;
    fake.answers.set("relay/id", { result: { hostId: buildBox } });
    fake.answers.set("relay/remove", () => ((removed = true), { result: { hosts: [] } }));
    const local = await start({}, signedIn().account);
    local.set(connected({ accountAccess: {} }));
    const answer = await fake.handlers.get("parallax:removeRelayHost")!({}, buildBox);
    expect(answer).toMatch(/computer you're on/);
    expect(removed).toBe(false);
  } finally {
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a computer the relay marks removed stays off at its next start; nothing else turns it off", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const calls: string[] = [];
    const list = (result: object | { error: object }) =>
      fake.answers.set("relay/hosts", "error" in result ? result : { result });
    fake.answers.set("relay/id", { result: { hostId: buildBox } });
    fake.answers.set("access/get", accessState([]));
    fake.answers.set("host/settings/get", { result: { connect: false } });
    fake.answers.set("host/settings/set", (params: unknown) => {
      calls.push(`set ${JSON.stringify(params)}`);
      return { result: {} };
    });
    fake.answers.set("relay/register", () => (calls.push("register"), { result: {} }));
    const startWith = async (joinedRelay: object) => {
      calls.length = 0;
      const { account, signIn } = signedIn();
      const local = await start({ joinedRelay }, account);
      local.set(connected({ accountAccess: {} }));
      await vi.advanceTimersByTimeAsync(1);
      return signIn;
    };

    const joined = { hostId: buildBox, user: "user_1" };

    // Marked removed: it stays off until a sign-in.
    list({ hosts: [], removed: [buildBox] });
    const signIn = await startWith(joined);
    expect(calls).toEqual(['set {"relay":false}']);
    signIn();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.at(-1)).toBe("register");
    rmSync(fake.userData, { recursive: true, force: true });

    // A failed list, a list with no mark for it, and an older relay's list prove nothing either
    // way: no setting changes, and it doesn't put itself back on the account.
    list({ hosts: [], removed: [studio] });
    await startWith(joined);
    expect(calls).toEqual([]);
    rmSync(fake.userData, { recursive: true, force: true });
    list({ error: { code: -32000, message: "down", data: { kind: "relayUnreachable" } } });
    await startWith(joined);
    expect(calls).toEqual([]);
    rmSync(fake.userData, { recursive: true, force: true });
    list({ hosts: [] });
    await startWith(joined);
    expect(calls).toEqual([]);
    rmSync(fake.userData, { recursive: true, force: true });

    // On an older relay, a key or account that never joined registers.
    await startWith({ hostId: buildBox, user: "user_2" });
    expect(calls).toEqual(["register"]);
    rmSync(fake.userData, { recursive: true, force: true });
    await startWith({ hostId: studio, user: "user_1" });
    expect(calls).toEqual(["register"]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a joined key that isn't listed or marked waits for one click, with no setting changed", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const calls: string[] = [];
    let hosts: object[] = [];
    fake.answers.set("relay/id", { result: { hostId: buildBox } });
    fake.answers.set("relay/hosts", () => ({ result: { hosts, removed: [] } }));
    fake.answers.set("access/get", accessState([]));
    fake.answers.set("host/settings/get", { result: { connect: false } });
    fake.answers.set("host/settings/set", () => (calls.push("set"), { result: {} }));
    fake.answers.set("relay/register", () => {
      calls.push("register");
      hosts = [{ hostId: buildBox, name: "me", online: true, thisComputer: true }];
      return { result: {} };
    });
    const { account } = signedIn();
    const joinedRelay = { hostId: buildBox, user: "user_1" };
    const local = await start({ joinedRelay }, account);
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    const discover = fake.handlers.get("parallax:discoverAccount")!;
    await discover();
    await discover();
    expect(calls).toEqual([]);
    expect(fake.sent.get("parallax:connectNotice")).toBe("notListed");

    expect(await fake.handlers.get("parallax:registerRelay")!()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["register"]);
    expect(fake.sent.get("parallax:connectNotice")).toBeNull();
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("each read's relay usage reaches the windows when it changes, and an older relay's is nothing", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const { account } = signedIn();
    fake.answers.set("access/get", accessState([]));
    const local = await start({}, account);
    local.set(connected({ accountAccess: {} }));
    const host = { hostId: buildBox, name: "box", online: true, thisComputer: false };
    const used = { ...host, usage: { bytes: 2, limit: 10, resetsAt: 1_000 } };
    fake.answers.set("relay/hosts", { result: { hosts: [host], removed: [] } });
    const discover = fake.handlers.get("parallax:discoverAccount")!;

    await discover();
    expect(fake.sent.get("parallax:relayUsage")).toBeUndefined();
    expect(await fake.handlers.get("parallax:relayUsage")!()).toEqual([]);

    fake.answers.set("relay/hosts", { result: { hosts: [used], removed: [] } });
    await discover();
    expect(fake.sent.get("parallax:relayUsage")).toEqual([used]);
    expect(await fake.handlers.get("parallax:relayUsage")!()).toEqual([used]);

    // An older read's answer that lands after a newer one's changes nothing.
    const spent = { ...host, usage: { bytes: 11, limit: 10, resetsAt: 1_000 } };
    let answerSlowly: (answer: object) => void = () => {};
    fake.answers.set("relay/hosts", () => new Promise((resolve) => (answerSlowly = resolve)));
    const slow = discover();
    await vi.advanceTimersByTimeAsync(1);
    const slowAnswer = answerSlowly;
    fake.answers.set("relay/hosts", { result: { hosts: [spent], removed: [] } });
    fake.visible = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.sent.get("parallax:relayUsage")).toEqual([spent]);
    slowAnswer({ result: { hosts: [used], removed: [] } });
    await slow;
    expect(fake.sent.get("parallax:relayUsage")).toEqual([spent]);
    expect(await fake.handlers.get("parallax:relayUsage")!()).toEqual([spent]);

    // Signed out, nothing stays.
    account.accessToken = async () => undefined as unknown as string;
    await discover();
    expect(fake.sent.get("parallax:relayUsage")).toEqual([]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("an outage says what's down and changes no setting; a list naming nothing keeps every computer", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const saved = { hostId: buildBox, name: "box", routes: ["192.168.1.20:7341"] };
    const { account } = signedIn();
    fake.answers.set("access/get", accessState([]));
    const local = await start({ accounts: [saved] }, account);
    fake.answers.set("relay/hosts", { result: { hosts: [], removed: [] } });
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    fake.answers.set("relay/hosts", {
      error: { code: -32000, message: "down", data: { kind: "relayUnreachable" } },
    });
    const box = fake.made.find((c) => c.options.account === "box")!;
    const file = path.join(fake.userData, "settings.json");
    const before = readFileSync(file, "utf8");
    const discover = fake.handlers.get("parallax:discoverAccount")!;

    // The relay is down, and two reads in a row say so.
    await discover();
    expect(fake.sent.get("parallax:connectNotice")).toBeUndefined();
    await discover();
    expect(fake.sent.get("parallax:connectNotice")).toBe("relay");
    expect(await fake.handlers.get("parallax:connectNotice")!()).toBe("relay");

    // Answering ends it, and an empty list, as from a relay that lost its data, drops nothing.
    fake.answers.set("relay/hosts", { result: { hosts: [], removed: [] } });
    await discover();
    expect(fake.sent.get("parallax:connectNotice")).toBeNull();
    expect(box.disposed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);

    // With no network, a failed read is no outage.
    fake.online = false;
    fake.answers.set("relay/hosts", {
      error: { code: -32000, message: "down", data: { kind: "relayUnreachable" } },
    });
    await discover();
    await discover();
    expect(fake.sent.get("parallax:connectNotice")).toBeNull();
    fake.online = true;

    // Clerk is down: no token, and what's asked of it says so instead of asking to sign in.
    fake.clerkDown = true;
    account.accessToken = async () => undefined as unknown as string;
    await discover();
    await discover();
    expect(fake.sent.get("parallax:connectNotice")).toBe("clerk");
    expect(await fake.handlers.get("parallax:relayHosts")!()).toMatch(/can't reach Clerk/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(box.disposed).toBe(false);
    fake.clerkDown = false;

    // Marked removed by the relay is the one thing that drops a computer. The timer's read notices
    // the mark alone, with `hosts` the same as before.
    account.accessToken = async () => relayToken;
    fake.answers.set("relay/hosts", { result: { hosts: [], removed: [] } });
    await discover();
    fake.visible = true;
    fake.answers.set("relay/hosts", { result: { hosts: [], removed: [buildBox] } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(box.disposed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).accounts).toEqual([]);
  } finally {
    fake.visible = false;
    vi.useRealTimers();
    fake.online = true;
    fake.clerkDown = false;
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("signing in as another account forgets the last one's computers, and the same account's stay", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    const saved = { hostId: buildBox, name: "box", routes: ["192.168.1.20:7341"] };
    fake.answers.set("access/get", accessState([]));
    fake.answers.set("relay/hosts", { result: { hosts: [] } });
    const startAs = async (user: string) => {
      const { account, signIn } = signedIn();
      await start({ accounts: [saved], joinedRelay: { hostId: studio, user } }, account);
      return signIn;
    };
    const accounts = () =>
      JSON.parse(readFileSync(path.join(fake.userData, "settings.json"), "utf8")).accounts;

    (await startAs("user_1"))();
    await vi.advanceTimersByTimeAsync(1);
    expect(accounts()).toEqual([saved]);
    rmSync(fake.userData, { recursive: true, force: true });

    (await startAs("user_2"))();
    await vi.advanceTimersByTimeAsync(1);
    expect(accounts()).toEqual([]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});

test("a computer saved as removed by an older app finishes leaving the account", async () => {
  vi.useFakeTimers();
  fake.answers.clear();
  try {
    let hosts = [{ hostId: buildBox, name: "box", online: false, thisComputer: false }];
    fake.answers.set("relay/hosts", () => ({ result: { hosts } }));
    fake.answers.set("access/get", accessState([]));
    fake.answers.set("access/forgetHost", { result: {} });
    fake.answers.set("relay/remove", () => ((hosts = []), { result: { hosts } }));
    const local = await start(
      { accounts: [{ hostId: buildBox, name: "box", routes: [], removed: true }] },
      signedIn().account,
    );
    local.set(connected({ accountAccess: {} }));
    await vi.advanceTimersByTimeAsync(1);
    expect(hosts).toEqual([]);
    expect(listed(buildBox)).toBeUndefined();
    const saved = JSON.parse(readFileSync(path.join(fake.userData, "settings.json"), "utf8"));
    expect(saved.accounts).toEqual([]);
  } finally {
    vi.useRealTimers();
    rmSync(fake.userData, { recursive: true, force: true });
  }
});
