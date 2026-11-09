#!/usr/bin/env node
// Deploys the relay to staging (PLX-1495): the Worker `parallax-relay-staging`, and nothing else.
//
//     corepack pnpm deploy:staging
//
// It takes no arguments and passes none to wrangler, so it can't be pointed at production. Before
// it deploys it checks that wrangler.toml's `staging` is still that Worker on `workers.dev` with no
// route, that staging's `ALLOWED_USERS` secret is set, so a deploy never opens staging to other
// accounts, and that the type-check and tests pass. Then it prints the URL and version id.
// Production is Ryan's to deploy, by hand (README.md).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

const ENVIRONMENT = "staging";
const WORKER = "parallax-relay-staging";
const SECRET = "ALLOWED_USERS";
const relay = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(relay, "wrangler.toml");
// Every wrangler command here names the config and the environment itself.
const TARGET = ["--config", config, "--env", ENVIRONMENT];
// Without CLOUDFLARE_ENV, which also picks an environment.
const { CLOUDFLARE_ENV: _, ...env } = process.env;

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
if (resolved.name !== WORKER || resolved.workers_dev !== true || routes.length)
  fail(`wrangler.toml's [env.${ENVIRONMENT}] must be the Worker ${WORKER} on workers.dev with no routes.`);

const unset = `Staging must have its ${SECRET} secret before a deploy, or it would serve every account (README.md, Staging).`;
const secrets = JSON.parse(run("wrangler", ["secret", "list", ...TARGET, "--format", "json"], { capture: true, hint: unset }));
if (!secrets.some((secret) => secret.name === SECRET)) fail(unset);

run("tsc", ["--noEmit"]);
run("vitest", ["run"]);

const scratch = mkdtempSync(join(tmpdir(), "deploy-staging-"));
try {
  const output = join(scratch, "wrangler.ndjson");
  run("wrangler", ["deploy", ...TARGET], { extra: { WRANGLER_OUTPUT_FILE_PATH: output } });
  const deployed = readFileSync(output, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === "deploy");
  if (!deployed) fail("wrangler didn't report a deploy.");
  console.log(`\nWorker:  ${deployed.worker_name}`);
  console.log(`URL:     ${(deployed.targets ?? []).join(" ")}`);
  console.log(`Version: ${deployed.version_id}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
