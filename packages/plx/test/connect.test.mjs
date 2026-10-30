// @ts-check
// `plx connect` and its subcommands against a fake plxd, with the relay behind it faked too.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as connect from "../src/connect.mjs";
import { attach } from "../src/plxd.mjs";

const FAKE = fileURLToPath(new URL("../fixtures/fake-plxd.mjs", import.meta.url));

/**
 * Fakes for `connect`'s deps, around one fake plxd per open, with `state` as its start, logging
 * its requests. `answers` are the prompt's answers in order.
 * @param {object} state
 * @param {string[]} [answers]
 */
function fakes(state = {}, answers = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "plx-connect-"));
  const log = path.join(dir, "log");
  writeFileSync(log, "");
  const env = { ...process.env, FAKE_PLXD: JSON.stringify(state), FAKE_PLXD_LOG: log };
  /** @type {string[]} */
  const asked = [];
  /** @type {string[]} */
  const installed = [];
  let signIns = 0;
  /** @type {import("../src/connect.mjs").Deps} */
  const deps = {
    signIn: async () => (signIns++, "good-token"),
    // Never runs this computer's real shell: Windows PowerShell can stall on its first start.
    details: async (_runner, os) => ({ os, arch: "arm64", label: "Test", version: "1" }),
    install: async (_runner, target, name, channel) => void installed.push(`${name} ${target.os} ${channel}`),
    plxd: async () => attach(spawn(process.execPath, [FAKE], { stdio: ["pipe", "pipe", "inherit"], env })),
    prompt: async (question) => (asked.push(question), answers.shift() ?? ""),
    routes: async () => ["192.168.1.20", "relay:tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE"],
    // Polls go at once; a setup code lapses on its own clock, unref'd like the real one.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms === 1000 ? 1 : ms).unref()),
  };
  return {
    deps,
    env,
    asked,
    installed,
    signIns: () => signIns,
    /** The requests plxd got, as `method params`, without `initialize`. */
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(({ method }) => method !== "initialize")
        .map(({ method, params }) => `${method} ${JSON.stringify(params)}`),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs `body` and resolves to its result and what it printed. @param {() => Promise<number>} body */
async function printed(body) {
  const lines = /** @type {string[]} */ ([]);
  const log = console.log;
  console.log = (/** @type {unknown[]} */ ...args) => void lines.push(args.join(" "));
  try {
    return { code: await body(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

const options = { channel: /** @type {const} */ ("nightly") };

test("connect signs in, installs, registers, turns relay and remote on, and ends when a device types the code", async () => {
  const fake = fakes();
  const { code, out } = await printed(() => connect.connect(options, fake.deps));
  assert.equal(code, 0, out);
  assert.equal(fake.signIns(), 1);
  assert.match(fake.installed[0] ?? "", /^this computer \w+ nightly$/);
  assert.deepEqual(fake.calls().slice(0, 3), [
    'relay/register {"token":"good-token"}',
    'host/settings/set {"relay":true,"remote":true}',
    "remote/sessions {}",
  ]);
  assert.match(out, /✓ studio is online on Parallax Connect/);
  assert.match(out, /^ {2}482911$/m);
  assert.match(out, /✓ Approved MacBook Air\./);
  fake.done();
});

test("a setup code that lapses is replaced, and the next one is shown", async () => {
  const fake = fakes({ expiresInMs: 0, pairAfterCodes: 2 });
  const { code, out } = await printed(() => connect.connect(options, fake.deps));
  assert.equal(code, 0, out);
  assert.match(out, /^ {2}482911$[\s\S]*The code lapsed\. Here's a new one\.[\s\S]*^ {2}482912$/m);
  assert.match(out, /✓ Approved MacBook Air\./);
  fake.done();
});

test("connect fails with plxd's reason when the relay never answers", async () => {
  const fake = fakes({ connects: false });
  const { code, out } = await printed(() => connect.connect(options, fake.deps));
  assert.equal(code, 1);
  assert.match(out, /✗ It isn't online: Couldn't reach Parallax Relay\./);
  assert.doesNotMatch(out, /access\/setupCode|482911/);
  fake.done();
});

test("connect stops at a token the relay refuses", async () => {
  const fake = fakes();
  fake.deps.signIn = async () => "stale-token";
  const { code, out } = await printed(() => connect.connect(options, fake.deps));
  assert.equal(code, 1);
  assert.match(out, /✗ The relay refused the sign-in\. Sign in again\./);
  assert.deepEqual(fake.calls(), ['relay/register {"token":"stale-token"}']);
  fake.done();
});

const pending = { id: "5bD1qJ2nV8rT0wX3yZ6aCg", name: "iPhone", thumbprint: "Qm9v", code: "071344", expiresAt: "2026-10-30T16:12:00Z" };

test("approve approves a waiting device's request with Enter, after showing its code", async () => {
  const fake = fakes({ relay: true, remote: true, registered: true, pending }, [""]);
  const { code, out } = await printed(() => connect.approve(fake.deps));
  assert.equal(code, 0, out);
  assert.match(out, /iPhone asks to sign in to this computer, with the code 071344\./);
  assert.match(fake.asked[0] ?? "", /Enter approves, n denies/);
  assert.deepEqual(fake.calls(), ["access/get {}", `access/approve {"request":"${pending.id}"}`]);
  assert.match(out, /✓ Approved iPhone\./);
  fake.done();
});

test("approve denies with n", async () => {
  const fake = fakes({ relay: true, remote: true, registered: true, pending }, ["n"]);
  const { code, out } = await printed(() => connect.approve(fake.deps));
  assert.equal(code, 0, out);
  assert.deepEqual(fake.calls(), ["access/get {}", `access/deny {"request":"${pending.id}"}`]);
  assert.match(out, /✓ Denied iPhone\./);
  fake.done();
});

test("approve with nothing waiting shows a new setup code and waits for a device", async () => {
  const fake = fakes({ relay: true, remote: true, registered: true });
  const { code, out } = await printed(() => connect.approve(fake.deps));
  assert.equal(code, 0, out);
  assert.match(out, /^ {2}482911$/m);
  assert.match(out, /✓ Approved MacBook Air\./);
  assert.equal(fake.asked.length, 0);
  fake.done();
});

test("unlink turns relay off and nothing else", async () => {
  const fake = fakes({ relay: true, remote: true, registered: true });
  const { code, out } = await printed(() => connect.unlink(fake.deps));
  assert.equal(code, 0, out);
  assert.deepEqual(fake.calls(), ['host/settings/set {"relay":false}']);
  assert.match(out, /stays registered/);
  fake.done();
});

test("remove signs in again, deregisters this host, and turns relay off", async () => {
  const fake = fakes({ relay: true, remote: true, registered: true });
  const { code, out } = await printed(() => connect.remove(fake.deps));
  assert.equal(code, 0, out);
  assert.equal(fake.signIns(), 1);
  assert.deepEqual(fake.calls(), [
    "relay/id {}",
    'relay/remove {"token":"good-token","hostId":"tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE"}',
    'host/settings/set {"relay":false}',
  ]);
  fake.done();
});

test("status prints the account, host id, relay state, and routes", async () => {
  const fake = fakes({ relay: true, remote: true, registered: true });
  const { code, out } = await printed(() => connect.status(fake.deps));
  assert.equal(code, 0, out);
  assert.match(out, /^Account +user_2abc$/m);
  assert.match(out, /^Host id +tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE$/m);
  assert.match(out, /^Relay +on, connected$/m);
  assert.match(out, /^Routes +192\.168\.1\.20, relay:tX7O/m);

  const off = fakes({});
  const offline = await printed(() => connect.status(off.deps));
  assert.match(offline.out, /^Account +not signed in/m);
  assert.match(offline.out, /^Relay +off$/m);
  assert.match(offline.out, /^Routes +none$/m);
  fake.done();
  off.done();
});

test("add signs in here, then installs and links over ssh", { skip: process.platform === "win32" }, async () => {
  const fake = fakes();
  const home = mkdtempSync(path.join(tmpdir(), "plx-home-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(home, ".parallax-plxd"));
  // ssh runs the remote command here, in the fake home; `-O exit` ends nothing.
  writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\necho "$*" >> "$HOME/ssh.log"\ncase " $* " in *" -O "*) exit 0 ;; esac\nfor last; do :; done\nexec /bin/sh -c "$last"\n`);
  writeFileSync(path.join(home, ".parallax-plxd", "plxd"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)}\n`);
  chmodSync(path.join(bin, "ssh"), 0o755);
  chmodSync(path.join(home, ".parallax-plxd", "plxd"), 0o755);
  const saved = { PATH: process.env["PATH"], HOME: process.env["HOME"], FAKE_PLXD: process.env["FAKE_PLXD"], FAKE_PLXD_LOG: process.env["FAKE_PLXD_LOG"] };
  Object.assign(process.env, { PATH: `${bin}:${process.env["PATH"]}`, HOME: home, FAKE_PLXD: fake.env.FAKE_PLXD, FAKE_PLXD_LOG: fake.env.FAKE_PLXD_LOG });
  fake.deps.plxd = (runner, os) => attach(runner.attach(os));
  try {
    const { code, out } = await printed(() => connect.add("box.local", { ...options, user: "ryan", port: "2222" }, fake.deps));
    assert.equal(code, 0, out);
    assert.match(out, /✓ Connected to box\.local/);
    assert.match(fake.installed[0] ?? "", /^box\.local (macos|linux) nightly$/);
    assert.match(out, /✓ Approved MacBook Air\./);
    const ssh = readFileSync(path.join(home, "ssh.log"), "utf8");
    assert.match(ssh, /-p 2222 -- ryan@box\.local "\$HOME\/\.parallax-plxd\/plxd" attach/);
    assert.equal(fake.calls()[0], 'relay/register {"token":"good-token"}');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    fake.done();
  }
});
