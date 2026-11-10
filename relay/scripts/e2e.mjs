#!/usr/bin/env node
// Runs plxd's relay test (daemon/tests/server/relay.rs) against this Worker under `wrangler dev`,
// with a local Clerk: a fresh RSA key whose JWKS the relay trusts, and session tokens it signed.
// Arguments replace the cargo command, such as `node scripts/e2e.mjs cargo test --release ...`.
import { spawn, spawnSync } from "node:child_process";
import { createSign, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { delayDuplex } from "./delay-duplex.mjs";

const proof = process.env.PLX_HOST_PROOF === "1";
// The proof, or `PLX_E2E_DELAY_MS` alone, puts a TLS front and a fixed per-direction delay before
// the production Worker.
const fronted = proof || process.env.PLX_E2E_DELAY_MS !== undefined;
const relayDir = dirname(dirname(fileURLToPath(import.meta.url)));
const issuer = "https://clerk.e2e";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256" }] };

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const sessionToken = (sub) => {
  const input = `${encode({ alg: "RS256", kid: "e2e", typ: "JWT" })}.${encode({
    sub,
    sid: "sess_e2e",
    iss: issuer,
    iat: now,
    nbf: now,
    exp: now + 3600,
  })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;
};

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
  ["dev", "--local", ...(proof ? ["--config", "proof.toml"] : []), "--ip", "127.0.0.1", "--port", String(port), "--env-file", envFile,
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

let url = `http://127.0.0.1:${port}`;
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

let front;
let delayed;
let ca;
if (fronted) {
  ca = join(scratch, "ca.pem");
  const caKey = join(scratch, "ca-key.pem");
  const key = join(scratch, "server-key.pem");
  const leaf = join(scratch, "server.pem");
  const csr = join(scratch, "server.csr");
  const extensions = join(scratch, "server.ext");
  writeFileSync(extensions, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid,issuer",
  ].join("\n"));
  const openssl = args => {
    if (spawnSync("openssl", args, {stdio:"ignore"}).status !== 0)
      throw new Error("fixture certificate generation/verification failed");
  };
  try {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-sha256",
      "-subj", "/CN=Parallax proof CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash",
      "-keyout", caKey, "-out", ca]);
    openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
      "-keyout", key, "-out", csr]);
    openssl(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial",
      "-days", "1", "-sha256", "-extfile", extensions, "-out", leaf]);
    if (!new X509Certificate(readFileSync(ca)).ca || new X509Certificate(readFileSync(leaf)).ca)
      throw new Error("fixture requires separate CA and end-entity certificates");
    // Verify the actual served leaf against only the generated CA before native registration.
    const verify = ["verify", "-x509_strict", "-purpose", "sslserver", "-CAfile", ca,
      "-no-CApath", "-no-CAstore"];
    openssl([...verify, "-verify_hostname", "localhost", leaf]);
    openssl([...verify, "-verify_ip", "127.0.0.1", leaf]);
    console.log("host-proof fixture PKI: CA/leaf constraints, server purpose, localhost/IP chain verified");
  } catch (error) {
    stop();
    throw error;
  }
  front = createHttpsServer({key:readFileSync(key), cert:readFileSync(leaf)}, (req,res) => {
    const upstream = httpRequest({hostname:"127.0.0.1",port,method:req.method,path:req.url,headers:req.headers}, answer => {
      res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  front.on("upgrade", (req, socket, head) => {
    const upstream = connect(port, "127.0.0.1", () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise(resolve => front.listen(0, "127.0.0.1", resolve));
  const delay = Number(process.env.PLX_HOST_PROOF_DELAY_MS ?? process.env.PLX_E2E_DELAY_MS ?? 0);
  delayed = createServer({allowHalfOpen:true}, socket => {
    const upstream = connect({port:front.address().port,host:"127.0.0.1",allowHalfOpen:true});
    delayDuplex(socket, upstream, delay);
  });
  await new Promise(resolve => delayed.listen(0, "127.0.0.1", resolve));
  url = `https://127.0.0.1:${delayed.address().port}`;
}
const [command, ...args] = process.argv.length > 2
  ? process.argv.slice(2)
  : ["cargo", "test", "-p", "plxd", "--test", "server", "relay::"];
const test = spawn(command, args, {
  cwd: dirname(relayDir),
  stdio: "inherit",
  // Three accounts, since the tests together register more computers than one account holds.
  env: {
    ...process.env,
    ...(ca ? {SSL_CERT_FILE:ca} : {}),
    PLXD_TEST_RELAY_URL: url,
    PLXD_TEST_RELAY_TOKEN: sessionToken("user_e2e"),
    PLXD_TEST_RELAY_CHECK_TOKEN: sessionToken("user_e2e_check"),
    PLXD_TEST_RELAY_PEERS_TOKEN: sessionToken("user_e2e_peers"),
    PLXD_TEST_RELAY_SYNC_TOKEN: sessionToken("user_e2e_sync"),
  },
});
test.on("exit", (code) => {
  front?.close(); delayed?.close();
  stop();
  process.exit(code ?? 1);
});
