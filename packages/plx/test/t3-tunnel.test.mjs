// @ts-check
// scripts/bench/t3-tunnel.mjs against fake relay clients on loopback (PLX-1452). Their answers copy
// cloudflared 2026.10.4's metrics server, which before its first config has only a catch-all rule.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listenersUnder, loopbackListeners, tunnelHost } from "../../../scripts/bench/t3-tunnel.mjs";

const CATCH_ALL = { hostname: "", service: "http_status:503" };

/**
 * A loopback HTTP server answering `routes` by path, and 404 to anything else.
 * @param {Record<string, () => unknown>} routes
 * @param {import("node:test").TestContext} t
 */
async function serve(routes, t) {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (!route) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  return /** @type {import("node:net").AddressInfo} */ (server.address()).port;
}

/** A fake relay client whose ingress sends `hostname` to `port`, once `configured()` says so. */
function client(/** @type {string} */ hostname, /** @type {number} */ port, configured = () => true) {
  return {
    "/config": () => ({
      config: { ingress: configured() ? [{ hostname, service: `http://127.0.0.1:${port}` }, CATCH_ALL] : [CATCH_ALL] },
    }),
    "/ready": () => ({ readyConnections: configured() ? 4 : 0 }),
  };
}

// Only this process's listeners, so the test never asks another program on this computer anything.
const own = () => loopbackListeners().filter(({ pid }) => pid === String(process.pid));
const lsof = { skip: spawnSync("lsof", ["-v"]).error ? "needs lsof" : false };

test("finds the client whose ingress serves this port, once it's configured", lsof, async (t) => {
  const serverPort = 40_001;
  let configured = false;
  setTimeout(() => (configured = true), 1500);
  await serve({}, t);
  await serve(client("real-t3.example", 40_002), t);
  await serve(client("ours.example", serverPort, () => configured), t);
  /** @type {string[]} */
  const asked = [];
  const host = await tunnelHost(serverPort, "unused", {
    limit: 15_000,
    listeners: own,
    answers: async (hostname) => (asked.push(hostname), 200),
  });
  assert.equal(host, "ours.example");
  assert.deepEqual(asked, ["ours.example"]);
});

test("names the furthest step on timeout, never the hostname", lsof, async (t) => {
  await serve(client("real-t3.example", 40_002), t);
  await serve(client("ours.example", 40_001), t);
  await assert.rejects(
    tunnelHost(40_001, "unused", { limit: 2500, listeners: own, answers: async () => 530 }),
    (error) => {
      const { message } = /** @type {Error} */ (error);
      assert.match(message, /its public address last answered 530/);
      assert.doesNotMatch(message, /example/);
      return true;
    },
  );
  await assert.rejects(tunnelHost(40_003, "unused", { limit: 1500, listeners: own }), /no relay client had a hostname for this server's port/);
});

test("looks only at listeners of processes started from T3CODE_HOME", lsof, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "t3-tunnel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "tools"));
  // A node started through a link inside the home stands in for T3's relay client.
  const inside = join(home, "tools", "relay-client");
  symlinkSync(process.execPath, inside);
  const child = spawn(inside, ["-e", 'require("http").createServer().listen(0, "127.0.0.1", () => console.log("up"))'], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.once("data", resolve));
  // A listener of this process, which isn't inside the home.
  await serve({}, t);

  const found = listenersUnder(home);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.pid, String(child.pid));
});
