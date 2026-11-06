// @ts-check
// scripts/bench/relay-probe-enroll.mjs against a fake Clerk and a stub `gh` (PLX-1407, PLX-1452).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/bench/relay-probe-enroll.mjs", import.meta.url));
const USER = "user_test_account";
const REFRESH_TOKEN = "refresh-token-1";

/** A fake Clerk that, like the real one, gives a refresh token only for `offline_access`. */
async function fakeClerk(sub = USER) {
  /** @type {string | null} */
  let scope = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://clerk");
    if (url.pathname === "/oauth/authorize") {
      scope = url.searchParams.get("scope");
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "good-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return void res.writeHead(302, { location: back.href }).end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/oauth/userinfo") return void res.end(JSON.stringify({ sub }));
    const offline = scope?.split(" ").includes("offline_access");
    res.end(JSON.stringify({ access_token: "access-token-1", ...(offline && { refresh_token: REFRESH_TOKEN }) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { api: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/**
 * Runs the script with a stub `gh` that names USER and keeps a set secret in `dir/stored-secret`,
 * signing in as `sub` by following the link it prints.
 * @param {import("node:test").TestContext} t
 * @param {string[]} args
 */
async function enroll(t, args, sub = USER) {
  const dir = mkdtempSync(join(tmpdir(), "relay-probe-enroll-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stored = join(dir, "stored-secret");
  writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$1 $2 $3" in
  "variable get PROBE_CLERK_USER_ID") echo ${USER} ;;
  "secret set PROBE_CLERK_REFRESH_TOKEN") cat > '${stored}' ;;
  *) exit 9 ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  const clerk = await fakeClerk(sub);
  t.after(() => clerk.close());

  const child = spawn(process.execPath, [SCRIPT, ...args.map((arg) => arg.replace("$DIR", dir))], {
    env: { PATH: [dir, "/usr/bin", "/bin"].join(delimiter), PROBE_CLERK_API: clerk.api },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  let opened = false;
  const read = (/** @type {Buffer} */ chunk) => {
    printed += chunk;
    const link = printed.match(/https?:\S+\/oauth\/authorize\S+/)?.[0];
    if (link && !opened) {
      opened = true;
      fetch(link).catch(() => {});
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, printed, dir, stored };
}

// The stub `gh` is a shell script, so these skip Windows.
const posix = { skip: process.platform === "win32" };

test("stores the refresh token of a sign-in that asked for one", posix, async (t) => {
  const { code, printed, stored } = await enroll(t, []);
  assert.equal(code, 0, printed);
  assert.equal(existsSync(stored) && readFileSync(stored, "utf8"), REFRESH_TOKEN);
  assert.ok(!printed.includes(REFRESH_TOKEN));
});

test("--file writes the token to a new 0600 file and leaves GitHub alone", posix, async (t) => {
  const { code, printed, dir, stored } = await enroll(t, ["--file", "$DIR/new/probe-token"]);
  assert.equal(code, 0, printed);
  const file = join(dir, "new", "probe-token");
  assert.equal(readFileSync(file, "utf8"), REFRESH_TOKEN);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!existsSync(stored));
  assert.ok(!printed.includes(REFRESH_TOKEN));
});

test("--file writes nothing for a sign-in to another account", posix, async (t) => {
  const { code, printed, dir } = await enroll(t, ["--file", "$DIR/probe-token"], "user_someone_else");
  assert.equal(code, 1, printed);
  assert.ok(!existsSync(join(dir, "probe-token")));
  assert.ok(!printed.includes(REFRESH_TOKEN));
});
