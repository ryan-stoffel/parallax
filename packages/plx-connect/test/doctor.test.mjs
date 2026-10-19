// @ts-check
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildContext, buildLaunchPrompt, buildSeedPrompt } from "../src/doctor-prompt.mjs";
import { duration, evaluate, findOnPath, parseLogProblems, plxdCandidates, resolveDataDir } from "../src/doctor.mjs";

test("the data folder is ~/.parallax unless only the legacy folder exists", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "plx-doctor-test-"));
  const legacy = path.join(home, "Library", "Application Support", "parallax");
  assert.equal(resolveDataDir("darwin", home, {}), path.join(home, ".parallax"));
  mkdirSync(legacy, { recursive: true });
  assert.equal(resolveDataDir("darwin", home, {}), legacy);
  mkdirSync(path.join(home, ".parallax"));
  assert.equal(resolveDataDir("darwin", home, {}), path.join(home, ".parallax"));
  assert.equal(resolveDataDir("darwin", home, { PLXD_DATA_DIR: "/data" }), path.resolve("/data"));
});

test("plxd is looked for where the app and plx-connect put it", () => {
  // path.join, so the expected paths use the separator of the OS the test runs on.
  const app = (/** @type {string} */ dir, /** @type {string} */ name) => path.join(dir, `${name}.app`, "Contents", "Resources", "plxd");
  assert.deepEqual(plxdCandidates("darwin", "/Users/me", {}), [
    path.join("/Users/me", ".parallax-plxd", "plxd"),
    app("/Applications", "Parallax"),
    app("/Applications", "Parallax (Nightly)"),
    app(path.join("/Users/me", "Applications"), "Parallax"),
    app(path.join("/Users/me", "Applications"), "Parallax (Nightly)"),
  ]);
  assert.deepEqual(plxdCandidates("linux", "/home/me", {}), [
    path.join("/home/me", ".parallax-plxd", "plxd"),
    path.join("/home/me", ".local", "bin", "plxd"),
    path.join("/home/me", ".local", "share", "parallax", "app", "plxd"),
  ]);
  assert.deepEqual(plxdCandidates("win32", "/Users/me", {}), [path.join("/Users/me", ".parallax-plxd", "plxd.exe")]);
  assert.equal(plxdCandidates("linux", "/home/me", { XDG_DATA_HOME: "/data" })[2], path.join("/data", "parallax", "app", "plxd"));
});

test("a command is found on PATH, and a folder of its name isn't", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plx-doctor-test-"));
  mkdirSync(path.join(dir, "a", "claude"), { recursive: true });
  mkdirSync(path.join(dir, "b"));
  writeFileSync(path.join(dir, "b", "claude"), "");
  chmodSync(path.join(dir, "b", "claude"), 0o755);
  const env = { PATH: [path.join(dir, "a"), path.join(dir, "b")].join(path.delimiter) };
  assert.equal(findOnPath("claude", env, "darwin"), path.join(dir, "b", "claude"));
  assert.equal(findOnPath("codex", env, "darwin"), undefined);
});

/** Facts for a healthy computer, which each test changes. @returns {import("../src/doctor.mjs").Facts} */
const healthy = () => ({
  platform: "darwin",
  dataDir: "/Users/me/.parallax",
  dataDirExists: true,
  plxd: "/Users/me/.parallax-plxd/plxd",
  plxdVersion: "2610.11822.14456-nightly",
  pid: 42,
  running: true,
  runningExe: "/Users/me/.parallax-plxd/plxd",
  runningExeVersion: "2610.11822.14456-nightly",
  answers: {
    initialize: { plxd: "2610.11822.14456-nightly", protocol: 1 },
    hostVersion: { os: "macOS 27.0", arch: "aarch64", plxd: "2610.11822.14456-nightly" },
    health: { uptimeSeconds: 3700, store: "ok", runningAgents: 1 },
    settings: { connect: true },
    connect: { tailscale: "running", port: 7340, listening: true, devices: [{ parallax: true }, { parallax: false }] },
    providers: {
      providers: [
        {
          instance: { id: "claude", kind: "claude", name: "Claude Code", enabled: true },
          installed: true,
          signedIn: true,
          version: "2.1.303",
          account: "max",
          login: ["claude", "auth", "login"],
        },
      ],
    },
  },
  newest: { stable: "2610.1.1", nightly: "2610.11822.14456-nightly" },
  git: { path: "/usr/bin/git", version: "2.50.1" },
  freeBytes: 100 * 1024 ** 3,
  worktrees: 3,
  log: { errors: 0, warnings: 0, recent: [] },
  sandboxMissing: undefined,
  agentClis: { claude: "/opt/homebrew/bin/claude", codex: undefined },
});

/** @param {import("../src/doctor.mjs").Facts} facts @param {string} name */
const check = (facts, name) => evaluate(facts).find((checked) => checked.name === name)?.result;

test("a healthy computer passes every check", () => {
  const results = evaluate(healthy());
  assert.deepEqual(results.filter(({ result }) => result.state !== "ok"), []);
  assert.equal(check(healthy(), "Running")?.detail, "pid 42, 2610.11822.14456-nightly, up 1 h 1 m, 1 agent running");
  assert.equal(check(healthy(), "Claude Code")?.detail, "2.1.303, signed in (max)");
});

test("a stopped plxd fails, with starting it as the fix", () => {
  const facts = { ...healthy(), running: false, pid: undefined, answers: undefined };
  const running = check(facts, "Running");
  assert.equal(running?.state, "fail");
  assert.deepEqual(running?.fix && [running.fix.file, ...running.fix.args], ["/Users/me/.parallax-plxd/plxd", "attach"]);
  // Without plxd's answers, agents are looked for on PATH.
  assert.equal(check(facts, "Agent CLIs")?.state, "ok");
});

test("a plxd running an older binary than the one on disk needs a restart", () => {
  const facts = { ...healthy(), runningExeVersion: "2610.11900.1-nightly" };
  assert.equal(check(facts, "Restart")?.state, "fail");
  const deleted = { ...healthy(), runningExe: "/home/me/.parallax-plxd/plxd (deleted)", runningExeVersion: undefined };
  assert.equal(check(deleted, "Restart")?.state, "fail");
  assert.equal(check(healthy(), "Restart"), undefined);
});

test("an agent that isn't signed in offers its own sign-in command", () => {
  const facts = healthy();
  const claude = facts.answers?.providers?.providers[0];
  if (claude) claude.signedIn = false;
  const result = check(facts, "Claude Code");
  assert.equal(result?.state, "fail");
  assert.deepEqual(result?.fix && [result.fix.file, ...result.fix.args], ["claude", "auth", "login"]);
  assert.equal(result?.fix?.input, undefined, "a sign-in gets the terminal");
});

test("Connect is checked only while it's on, and fails without Tailscale", () => {
  assert.equal(check(healthy(), "Connect")?.detail, "listening on port 7340; 1 other computer on Parallax");
  const off = healthy();
  if (off.answers?.settings) off.answers.settings.connect = false;
  assert.equal(check(off, "Connect"), undefined);
  const stopped = healthy();
  if (stopped.answers?.connect) stopped.answers.connect.tailscale = "stopped";
  assert.equal(check(stopped, "Connect")?.state, "fail");
});

test("an older plxd, a bad store, low disk, and log errors are reported", () => {
  const facts = {
    ...healthy(),
    newest: { nightly: "2610.11900.1-nightly" },
    freeBytes: 1024 ** 3,
    log: { errors: 2, warnings: 1, recent: ["2026-10-19T14:50:03Z ERROR plxd::store: disk I/O error"] },
  };
  if (facts.answers?.health) facts.answers.health.store = "readOnly";
  assert.equal(check(facts, "Up to date")?.state, "warn");
  assert.equal(check(facts, "Project store")?.state, "fail");
  assert.equal(check(facts, "Disk")?.state, "fail");
  assert.equal(check(facts, "plxd log")?.state, "warn");
  assert.match(check(facts, "plxd log")?.detail ?? "", /plxd::store: disk I\/O error/);
});

test("log problems are the warnings and errors of the last 24 hours", () => {
  const log = [
    "2026-10-17T10:00:00.000Z ERROR plxd: too old",
    "2026-10-19T10:00:00.000Z  INFO plxd: fine",
    "2026-10-19T11:00:00.000Z  WARN plxd: slow",
    "2026-10-19T12:00:00.000Z ERROR plxd: broke",
    "not a log line",
  ].join("\n");
  const problems = parseLogProblems(log, new Date("2026-10-19T13:00:00Z"));
  assert.equal(problems.errors, 1);
  assert.equal(problems.warnings, 1);
  assert.deepEqual(problems.recent, ["2026-10-19T11:00:00.000Z  WARN plxd: slow", "2026-10-19T12:00:00.000Z ERROR plxd: broke"]);
});

test("durations read in days, hours, or minutes", () => {
  assert.equal(duration(59), "0 m");
  assert.equal(duration(3700), "1 h 1 m");
  assert.equal(duration(90000), "1 d 1 h");
});

test("the launch prompt is one line naming the prompt file", () => {
  // It goes through cmd.exe for a Windows `.cmd` shim, which can't carry a newline or a `"`.
  const file = String.raw`C:\Users\a b\.parallax\doctor\x\prompt.md`;
  const launch = buildLaunchPrompt(file);
  assert.ok(launch.includes(file));
  assert.ok(!/[\n"]/.test(launch));
});

test("the seed prompt names the context file and holds the playbook", () => {
  const seed = buildSeedPrompt("/tmp/x/context.md", "# Playbook\n");
  assert.ok(seed.includes("/tmp/x/context.md"));
  assert.ok(seed.endsWith("# Playbook\n"));
});

test("the context file names the paths and never a provider's env", () => {
  const facts = healthy();
  const claude = /** @type {any} */ (facts.answers?.providers?.providers[0]);
  claude.instance.env = [{ name: "ANTHROPIC_API_KEY", value: "sk-secret" }];
  claude.loginEnv = [{ name: "OLLAMA_API_KEY", value: "ollama-secret" }];
  const context = buildContext({ generatedAt: "now", version: "0.4.0", launchedAs: "npx plx-connect doctor", facts, results: evaluate(facts), sourceCache: "/src" });
  for (const part of ["/Users/me/.parallax", "plxd.log", "plxd.sqlite3", "Claude Code (claude): installed 2.1.303, signed in (max)", "/src"]) {
    assert.ok(context.includes(part), part);
  }
  assert.ok(!context.includes("secret"));
});

test("the playbook names the fetch URL it refreshes from", async () => {
  const { readFileSync } = await import("node:fs");
  const { PLAYBOOK_URL } = await import("../src/doctor-prompt.mjs");
  const playbook = readFileSync(new URL("../src/doctor-playbook.md", import.meta.url), "utf8");
  assert.ok(playbook.includes(PLAYBOOK_URL));
});
