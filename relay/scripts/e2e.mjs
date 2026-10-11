#!/usr/bin/env node
// Runs plxd's relay test (daemon/tests/server/relay.rs) against this Worker under `wrangler dev`,
// with a local Clerk: a fresh RSA key whose JWKS the relay trusts, and a session token it signed.
// Arguments replace the cargo command, such as `node scripts/e2e.mjs cargo test --release ...`.
import { spawn } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relayDir = dirname(dirname(fileURLToPath(import.meta.url)));
const issuer = "https://clerk.e2e";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256" }] };

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const input = `${encode({ alg: "RS256", kid: "e2e", typ: "JWT" })}.${encode({
  sub: "user_e2e",
  sid: "sess_e2e",
  iss: issuer,
  iat: now,
  nbf: now,
  exp: now + 3600,
})}`;
const token = `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const scratch = mkdtempSync(join(tmpdir(), "plx-relay-e2e-"));
const envFile = join(scratch, ".env");
writeFileSync(envFile, `CLERK_ISSUER=${issuer}\nCLERK_JWKS='${JSON.stringify(jwks)}'\n`);

const wrangler = spawn(
  join(relayDir, "node_modules", ".bin", "wrangler"),
  ["dev", "--ip", "127.0.0.1", "--port", String(port), "--env-file", envFile,
    "--persist-to", join(scratch, "state"), "--show-interactive-dev-session=false", "--log-level", "warn"],
  { cwd: relayDir, stdio: ["ignore", "inherit", "inherit"], detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
const stop = () => {
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
};

const url = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 60_000;
for (;;) {
  const answer = await fetch(`${url}/v1/hosts`).catch(() => null);
  if (answer?.status === 401) break;
  if (Date.now() > deadline || wrangler.exitCode !== null) {
    stop();
    console.error("wrangler dev didn't start");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const [command, ...args] = process.argv.length > 2
  ? process.argv.slice(2)
  : ["cargo", "test", "-p", "plxd", "--test", "server", "relay::"];
const test = spawn(command, args, {
  cwd: dirname(relayDir),
  stdio: "inherit",
  env: { ...process.env, PLXD_TEST_RELAY_URL: url, PLXD_TEST_RELAY_TOKEN: token },
});
test.on("exit", (code) => {
  stop();
  process.exit(code ?? 1);
});
