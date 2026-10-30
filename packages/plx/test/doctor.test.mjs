// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { buildContext, buildLaunchPrompt } from "../src/doctor-prompt.mjs";
import { evaluate, signInFix } from "../src/doctor.mjs";

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
  agentClis: { claude: "/opt/homebrew/bin/claude", codex: undefined },
});

test("a second instance signs in to its own home, with its login env, from plxd's CLI", () => {
  const fix = signInFix({
    instance: { id: "work-codex", kind: "codex", name: "Work Codex", home: "/Users/me/.parallax/codex/work" },
    login: ["codex", "login"],
    loginEnv: [{ name: "OPENAI_BASE_URL", value: "https://example.test" }],
    path: "/opt/homebrew/bin/codex",
  });
  assert.equal(fix?.file, "/opt/homebrew/bin/codex");
  assert.deepEqual(fix?.args, ["login"]);
  assert.deepEqual(fix?.env, { OPENAI_BASE_URL: "https://example.test", CODEX_HOME: "/Users/me/.parallax/codex/work" });
});

test("the launch prompt is one line naming the prompt file", () => {
  // It goes through cmd.exe for a Windows `.cmd` shim, which can't carry a newline or a `"`.
  const file = String.raw`C:\Users\a b\.parallax\doctor\x\prompt.md`;
  const launch = buildLaunchPrompt(file);
  assert.ok(launch.includes(file));
  assert.ok(!/[\n"]/.test(launch));
});

test("the context file names the paths and never a provider's env", () => {
  const facts = healthy();
  const claude = /** @type {any} */ (facts.answers?.providers?.providers[0]);
  claude.instance.env = [{ name: "ANTHROPIC_API_KEY", value: "sk-secret" }];
  claude.loginEnv = [{ name: "OLLAMA_API_KEY", value: "ollama-secret" }];
  const context = buildContext({ generatedAt: "now", version: "0.4.0", launchedAs: "npx plx-cli doctor", facts, results: evaluate(facts), sourceCache: "/src" });
  for (const part of ["/Users/me/.parallax", "plxd.log", "plxd.sqlite3", "Claude Code (claude): installed 2.1.303, signed in (max)", "/src"]) {
    assert.ok(context.includes(part), part);
  }
  assert.ok(!context.includes("secret"));
});
