// @ts-check
// plx's argument handling: what each command line runs, or the usage error it gets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.mjs";

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
  for (const argv of [["connect"], ["connect", "approve"], ["connect", "status"], ["connect", "unlink"], ["connect", "remove"], ["connect", "add", "ryan@box.local"]])
    assert.equal((await run(argv)).code, "dispatched", argv.join(" "));
  assert.equal((await run(["connect", "--no-browser"])).noBrowser, true);
  assert.equal((await run(["connect"])).noBrowser, false);
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
    [["frobnicate"], "Unknown command: frobnicate"],
  ];
  for (const [argv, message] of cases) assert.deepEqual(await run(argv), { code: 2, error: message, noBrowser: undefined }, argv.join(" "));
  const unknownFlag = await run(["connect", "--browser"]);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.error ?? "", /Unknown option '--browser'/);
});

test("the bin runs main, and --version prints plx-cli's version", () => {
  const bin = fileURLToPath(new URL("../bin/plx.mjs", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const run = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  assert.equal(pkg.name, "plx-cli");
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), pkg.version);
});
