#!/usr/bin/env node
// Deploys the site to staging (PLX-1648): the Worker `parallax-site-staging`, and nothing else.
//
//     corepack pnpm deploy:staging
//
// It takes no arguments and passes none to wrangler, and wrangler gets only a short list of the
// caller's variables and no `.env` file, so nothing can point it at production. Before it deploys
// it checks that wrangler.toml's `staging` is still that Worker on `workers.dev` with no route,
// that wrangler's own dry run names that Worker, and that the pages' test passes. Then it prints
// the URL and version id. Production is Ryan's to deploy, by hand (README.md).
//
// The guards are the relay's (`relay/scripts/staging-target.mjs`), which use only Node's own
// modules, so the two staging deploys can't drift apart.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

import { childEnv, deployed, emptyEnvFile, requireTarget } from "../../relay/scripts/staging-target.mjs";

const ENVIRONMENT = "staging";
const WORKER = "parallax-site-staging";
const site = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(site, "wrangler.toml");
const wrangler = join(site, "node_modules", ".bin", "wrangler");
const env = childEnv(process.env);

function fail(message) {
  console.error(`deploy-staging: ${message}`);
  process.exit(1);
}

if (process.argv.length > 2) fail("it takes no arguments. It deploys only to staging.");

const resolved = unstable_readConfig({ config, env: ENVIRONMENT });
const routes = [resolved.route, ...(resolved.routes ?? [])].filter(Boolean);
if (resolved.name !== WORKER || resolved.workers_dev !== true || routes.length)
  fail(`wrangler.toml's [env.${ENVIRONMENT}] must be the Worker ${WORKER} on workers.dev with no routes.`);

const scratch = mkdtempSync(join(tmpdir(), "deploy-staging-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// Every wrangler command here names the config and the environment itself, and reads no `.env`.
const target = ["--config", config, "--env", ENVIRONMENT, "--env-file", emptyEnvFile(scratch)];

try {
  requireTarget(WORKER, { wrangler, target, cwd: site, env });
} catch (error) {
  fail(`${error.message}. Nothing was deployed.`);
}

const test = spawnSync(process.execPath, ["--test", join(site, "test", "pages.test.mjs")], { cwd: site, env, stdio: "inherit" });
if (test.status !== 0) fail("the pages' test failed. Nothing was deployed.");

const output = join(scratch, "wrangler.ndjson");
const deploy = spawnSync(wrangler, ["deploy", ...target], {
  cwd: site,
  env: { ...env, WRANGLER_OUTPUT_FILE_PATH: output },
  stdio: "inherit",
});
if (deploy.error) fail(`wrangler didn't run: ${deploy.error.message}. Run corepack pnpm install --frozen-lockfile first.`);
if (deploy.status !== 0) fail("wrangler deploy failed.");
const done = deployed(output);
if (!done) fail("wrangler didn't report a deploy.");
console.log(`\nWorker:  ${done.worker_name}`);
console.log(`URL:     ${(done.targets ?? []).join(" ")}`);
console.log(`Version: ${done.version_id}`);
if (done.worker_name !== WORKER) fail(`wrangler deployed to ${done.worker_name}, not ${WORKER}. Tell Ryan now.`);
