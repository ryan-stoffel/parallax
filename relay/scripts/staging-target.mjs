// What keeps deploy-staging.mjs on the staging Worker (PLX-1495), apart from it so its test never
// loads a script that deploys.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The only variables wrangler and the checks get from the caller: what finds programs, the home
 * folder with wrangler's login, and a Cloudflare token in place of that login. Every other
 * variable stays out, since wrangler reads some as where to deploy: WRANGLER_CI_OVERRIDE_NAME
 * renames the Worker a deploy uploads to, and CLOUDFLARE_ENV picks an environment.
 */
const PASSED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

/** `parent` with only the variables in `PASSED`. @param {NodeJS.ProcessEnv} parent */
export function childEnv(parent) {
  return Object.fromEntries(PASSED.filter((name) => parent[name] !== undefined).map((name) => [name, parent[name]]));
}

/**
 * Throws unless `wrangler deploy <target>` would upload to the Worker `expected`. It asks wrangler
 * itself, with a dry run that sends nothing, so the answer is the name after everything wrangler
 * applies to it: the config, the environment, and any override, whichever variable or file set it.
 * @param {string} expected
 * @param {{ wrangler: string, target: string[], cwd: string, env: NodeJS.ProcessEnv }} run
 */
export function requireTarget(expected, { wrangler, target, cwd, env }) {
  const scratch = mkdtempSync(join(tmpdir(), "staging-target-"));
  try {
    const output = join(scratch, "wrangler.ndjson");
    const result = spawnSync(wrangler, ["deploy", ...target, "--dry-run"], {
      cwd,
      env: { ...env, WRANGLER_OUTPUT_FILE_PATH: output },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0)
      throw new Error(`wrangler's dry run failed, so nothing says where a deploy would go: ${result.error?.message ?? result.stderr.trim()}`);
    const name = deployed(output)?.worker_name;
    if (name !== expected) throw new Error(`a deploy would go to the Worker "${name}", not "${expected}"`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What wrangler reported deploying, or dry-running, in its output file `path`. */
export function deployed(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === "deploy");
}

/** An empty file in `folder`, for `--env-file`: with it wrangler reads no `.env` file at all. */
export function emptyEnvFile(folder) {
  const path = join(folder, "empty.env");
  writeFileSync(path, "");
  return path;
}
