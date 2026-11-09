#!/usr/bin/env node
// Deploys the relay to staging (PLX-1495): the Worker `parallax-relay-staging`, and nothing else.
//
//     corepack pnpm deploy:staging
//
// It takes no arguments and passes none to wrangler, and wrangler gets only a short list of the
// caller's variables and no `.env` file (staging-target.mjs), so nothing can point it at
// production. Before it deploys it checks that wrangler.toml's `staging` is still that Worker on
// `workers.dev`, with no route and with the marker that makes its allowlist required, that
// wrangler's own dry run names that Worker, that staging's `ALLOWED_USERS` secret is set, and that
// the type-check and the Worker's tests pass. Then it prints the URL and version id. Production is
// Ryan's to deploy, by hand (README.md).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

import { childEnv, deployed, emptyEnvFile, requireTarget } from "./staging-target.mjs";

const ENVIRONMENT = "staging";
const WORKER = "parallax-relay-staging";
const SECRET = "ALLOWED_USERS";
const MARKER = "REQUIRE_ALLOWED_USERS";
const relay = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(relay, "wrangler.toml");
const env = childEnv(process.env);

function fail(message) {
  console.error(`deploy-staging: ${message}`);
  process.exit(1);
}

/** Runs one of the relay's own tools, and stops when it fails, saying `hint`. `capture` answers its output. */
function run(tool, args, { capture = false, extra = {}, hint = "" } = {}) {
  const result = spawnSync(join(relay, "node_modules", ".bin", tool), args, {
    cwd: relay,
    env: { ...env, ...extra },
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) fail(`${tool} didn't run: ${result.error.message}. Run corepack pnpm install --frozen-lockfile first.`);
  if (result.status !== 0) fail(`${tool} ${args[0]} failed. ${hint}`.trim());
  return result.stdout;
}

if (process.argv.length > 2) fail("it takes no arguments. It deploys only to staging.");

const resolved = unstable_readConfig({ config, env: ENVIRONMENT });
const routes = [resolved.route, ...(resolved.routes ?? [])].filter(Boolean);
if (resolved.name !== WORKER || resolved.workers_dev !== true || routes.length || !resolved.vars[MARKER])
  fail(`wrangler.toml's [env.${ENVIRONMENT}] must be the Worker ${WORKER} on workers.dev with no routes and ${MARKER} set.`);

const scratch = mkdtempSync(join(tmpdir(), "deploy-staging-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// Every wrangler command here names the config and the environment itself, and reads no `.env`.
const target = ["--config", config, "--env", ENVIRONMENT, "--env-file", emptyEnvFile(scratch)];

try {
  requireTarget(WORKER, { wrangler: join(relay, "node_modules", ".bin", "wrangler"), target, cwd: relay, env });
} catch (error) {
  fail(`${error.message}. Nothing was deployed.`);
}

const unset = `Staging needs its ${SECRET} secret before a deploy, or it refuses every account (README.md, Staging).`;
const secrets = JSON.parse(run("wrangler", ["secret", "list", ...target, "--format", "json"], { capture: true, hint: unset }));
if (!secrets.some((secret) => secret.name === SECRET)) fail(unset);

// As `pnpm check`, and the Worker's tests.
run("tsc", ["--noEmit"]);
run("vitest", ["run"]);

const output = join(scratch, "wrangler.ndjson");
run("wrangler", ["deploy", ...target], { extra: { WRANGLER_OUTPUT_FILE_PATH: output } });
const done = deployed(output);
if (!done) fail("wrangler didn't report a deploy.");
console.log(`\nWorker:  ${done.worker_name}`);
console.log(`URL:     ${(done.targets ?? []).join(" ")}`);
console.log(`Version: ${done.version_id}`);
if (done.worker_name !== WORKER) fail(`wrangler deployed to ${done.worker_name}, not ${WORKER}. Tell Ryan now.`);
