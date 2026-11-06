// @ts-check
// plx's argument handling: what each command line runs, or the usage error it gets.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lineReader, main } from "../src/cli.mjs";

/**
 * Runs `argv` with deps that only record what `connect` would reach, and resolves to the exit
 * code, the usage error printed, and whether `--no-browser` arrived.
 * @param {string[]} argv
 */
async function run(argv) {
  /** @type {boolean | undefined} */
  let noBrowser;
  const errors = /** @type {string[]} */ ([]);
  const error = console.error;
  console.error = (/** @type {unknown} */ message) => void errors.push(String(message).split("\n")[0] ?? "");
  try {
    const code = await main(argv, (flag) => {
      noBrowser = flag;
      throw new Error("deps reached");
    }).catch((/** @type {Error} */ e) => (e.message === "deps reached" ? "dispatched" : Promise.reject(e)));
    return { code, error: errors[0], noBrowser };
  } finally {
    console.error = error;
  }
}

test("connect's subcommands dispatch, with --no-browser passed through", async () => {
  for (const argv of [["connect"], ["connect", "approve"], ["connect", "status"], ["connect", "status", "--json"], ["connect", "unlink"], ["connect", "remove"], ["connect", "add", "ryan@box.local"]])
    assert.equal((await run(argv)).code, "dispatched", argv.join(" "));
  assert.equal((await run(["connect", "--no-browser"])).noBrowser, true);
  assert.equal((await run(["connect"])).noBrowser, false);
});

test("the channel is nightly unless --channel says otherwise", async () => {
  /** @type {string[]} */
  const channels = [];
  const release = async (/** @type {string} */ channel) => {
    channels.push(channel);
    throw new Error("stop");
  };
  const deps = () => /** @type {import("../src/connect.mjs").Deps} */ (/** @type {unknown} */ ({ release }));
  const log = console.log;
  console.log = () => {};
  try {
    await main(["connect"], deps);
    await main(["connect", "--channel", "stable"], deps);
    // As the setup scripts pass it, followed by the user's own.
    await main(["connect", "--channel", "nightly", "--channel", "stable"], deps);
  } finally {
    console.log = log;
  }
  assert.deepEqual(channels, ["nightly", "stable", "stable"]);
});

test("bad command lines get a usage error and exit 2", async () => {
  /** @type {[string[], string][]} */
  const cases = [
    [["connect", "pair"], "Unknown connect command: pair"],
    [["connect", "status", "now"], "connect status takes no arguments."],
    [["connect", "extra"], "Unknown connect command: extra"],
    [["connect", "add"], "connect add takes one ssh destination."],
    [["connect", "add", "a", "b"], "connect add takes one ssh destination."],
    [["connect", "add", "--", "-oProxyCommand=sh"], "-oProxyCommand=sh isn't an ssh destination."],
    [["connect", "--channel", "beta"], "--channel is stable or nightly, not beta."],
    [["connect", "add", "box", "--port", "ssh"], "--port is a number, not ssh."],
    [["connect", "--json"], "--json goes with connect status only."],
    [["frobnicate"], "Unknown command: frobnicate"],
  ];
  for (const [argv, message] of cases) assert.deepEqual(await run(argv), { code: 2, error: message, noBrowser: undefined }, argv.join(" "));
  const unknownFlag = await run(["connect", "--browser"]);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.error ?? "", /Unknown option '--browser'/);
});

test("a terminal's withdrawn question rejects, and the next question still gets its line", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const ask = lineReader(input, new PassThrough());
  const asking = new AbortController();
  const withdrawn = ask("first?", asking.signal);
  asking.abort();
  await assert.rejects(withdrawn, /withdrawn/);
  const next = ask("second?");
  input.write("yes\n");
  assert.equal(await next, "yes");
});

test("piped questions get a line each, keep lines read ahead, and reject once input ends", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const ask = lineReader(input, output);
  input.write("one\ntwo\n");
  assert.equal(await ask("first?"), "one");
  assert.equal(await ask("second?"), "two");
  const third = ask("third?");
  input.end("three");
  assert.equal(await third, "three");
  await assert.rejects(ask("fourth?"), /Input ended/);
  await assert.rejects(ask("fifth?"), /Input ended/);
  assert.equal(output.read().toString(), "first?\nsecond?\nthird?\nfourth?\n");
});

/**
 * Runs `script` in a new Node with no terminal, its HOME a throwaway folder, and resolves to its
 * exit code, stdout, and stderr. `stdin` is a pipe left open, or "ignore" for an input that's already ended.
 * @param {string} script
 * @param {"pipe" | "ignore"} stdin
 */
function noTerminal(script, stdin) {
  const home = mkdtempSync(path.join(tmpdir(), "plx-cli-"));
  assert.ok(home.startsWith(tmpdir()));
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: [stdin, "pipe", "pipe"],
    // Clerk at an address nothing answers, so no real sign-in can start from here.
    env: { ...process.env, HOME: home, USERPROFILE: home, PLX_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("127.0.0.1:1$").toString("base64")}` },
  });
  child.stdin?.write("the answer\n");
  let stdout = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => {
    child.once("close", (code) => {
      child.stdin?.destroy();
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("plx exits on its own with stdin still open, once nothing is asking", { timeout: 30_000 }, async () => {
  const cli = new URL("../src/cli.mjs", import.meta.url).href;
  const script = `import { lineReader } from ${JSON.stringify(cli)}; console.log("got", await lineReader(process.stdin, process.stdout)("q?"));`;
  const { code, stdout } = /** @type {{ code: number, stdout: string }} */ (await noTerminal(script, "pipe"));
  assert.deepEqual({ code, stdout }, { code: 0, stdout: "q?\ngot the answer\n" });
});

/**
 * A script running real `plx connect` sign-in with stdin already ended. Clerk answers through
 * `clerk`, a function of the URL. The rest fails, so it can't install anything or reach a real plxd.
 * @param {string} clerk
 */
function connectScript(clerk) {
  const cli = new URL("../src/cli.mjs", import.meta.url).href;
  return `import { main, realDeps } from ${JSON.stringify(cli)};
    const clerk = ${clerk};
    globalThis.fetch = async (url) => Response.json(clerk(String(url)));
    const never = async () => { throw new Error("got past sign-in"); };
    const deps = (noBrowser) => ({ ...realDeps(noBrowser), release: async () => ({ tag_name: "v1", prerelease: true, assets: [] }), details: never, install: never, plxd: never });
    main(["connect"], deps).then((code) => { process.exitCode = code; });`;
}

test("plx connect with no terminal and no device grant prints the link, skips the browser, and exits 1 at end of input, saying why on stderr", { timeout: 30_000 }, async () => {
  const script = connectScript(`() => ({ token_endpoint: "unused" })`);
  const { code, stdout, stderr } = /** @type {{ code: number, stdout: string, stderr: string }} */ (await noTerminal(script, "ignore"));
  assert.equal(code, 1, stdout);
  assert.match(stdout, /^ {2}https:\/\/127\.0\.0\.1:1\/oauth\/authorize\S+$/m);
  assert.match(stdout, /^Paste the code it shows: $/m);
  assert.match(stderr, /^✗ No code was entered before input ended\./m);
  assert.doesNotMatch(stdout, /Opened your browser|got past sign-in|No code was entered/);
});

/** A Clerk with the device grant, whose token endpoint answers `token`, a JSON object. @param {string} token */
const deviceClerk = (token) => `(url) => {
  if (url.endsWith("/.well-known/oauth-authorization-server")) return { device_authorization_endpoint: "https://clerk.example/device", token_endpoint: "https://clerk.example/token", grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"] };
  if (url.endsWith("/device")) return { device_code: "secret", user_code: "ABCD-EFGH", verification_uri: "https://clerk.example/activate", expires_in: 60, interval: 1 };
  return ${token};
}`;

test("a denied device grant exits 1 and says why on stderr", { timeout: 30_000 }, async () => {
  const script = connectScript(deviceClerk(`{ error: "access_denied" }`));
  const { code, stdout, stderr } = /** @type {{ code: number, stdout: string, stderr: string }} */ (await noTerminal(script, "ignore"));
  assert.equal(code, 1, stdout);
  assert.match(stderr, /^✗ The sign-in was denied\./m);
  assert.doesNotMatch(stdout, /denied|got past sign-in/);
});

test("plx connect with no terminal and the device grant signs in with nothing on stdin", { timeout: 30_000 }, async () => {
  const script = connectScript(deviceClerk(`{ access_token: "token" }`));
  const { code, stdout } = /** @type {{ code: number, stdout: string }} */ (await noTerminal(script, "ignore"));
  // The stub fails right after sign-in, which is how far this run goes.
  assert.equal(code, 1, stdout);
  assert.match(stdout, /^ {2}https:\/\/clerk\.example\/activate$/m);
  assert.match(stdout, /^ {2}Code: ABCD-EFGH$/m);
  assert.match(stdout, /got past sign-in/);
  assert.doesNotMatch(stdout, /Opened your browser|Paste the code|No code was entered/);
});

test("the bin runs main, and --version prints plx-cli's version", () => {
  const bin = fileURLToPath(new URL("../bin/plx.mjs", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const run = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  assert.equal(pkg.name, "plx-cli");
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), pkg.version);
});
