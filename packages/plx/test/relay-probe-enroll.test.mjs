// @ts-check
// scripts/bench/relay-probe-enroll.mjs against a fake Clerk and a stub `gh` (PLX-1407).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/bench/relay-probe-enroll.mjs", import.meta.url));
const USER = "user_test_account";
const REFRESH_TOKEN = "refresh-token-1";

/** A fake Clerk that, like the real one, gives a refresh token only for `offline_access`. */
async function fakeClerk() {
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
    if (url.pathname === "/oauth/userinfo") return void res.end(JSON.stringify({ sub: USER }));
    const offline = scope?.split(" ").includes("offline_access");
    res.end(JSON.stringify({ access_token: "access-token-1", ...(offline && { refresh_token: REFRESH_TOKEN }) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { api: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// The stub `gh` is a shell script, so this skips Windows.
test("stores the refresh token of a sign-in that asked for one", { skip: process.platform === "win32" }, async (t) => {
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
  const clerk = await fakeClerk();
  t.after(() => clerk.close());

  const child = spawn(process.execPath, [SCRIPT], {
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

  assert.equal(code, 0, printed);
  assert.equal(existsSync(stored) && readFileSync(stored, "utf8"), REFRESH_TOKEN);
  assert.ok(!printed.includes(REFRESH_TOKEN));
});
