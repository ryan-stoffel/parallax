// What keeps deploy-staging.mjs off production (PLX-1495), against a throwaway project and
// wrangler's dry run, which sends nothing. Run by `pnpm test`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { childEnv, emptyEnvFile, requireTarget } from "./staging-target.mjs";

const wrangler = join(dirname(dirname(fileURLToPath(import.meta.url))), "node_modules", ".bin", "wrangler");
const OVERRIDE = "WRANGLER_CI_OVERRIDE_NAME";

// A project shaped like the relay's: production at the top level, and a staging environment.
const project = mkdtempSync(join(tmpdir(), "staging-target-test-"));
after(() => rmSync(project, { recursive: true, force: true }));
writeFileSync(join(project, "worker.js"), "export default { fetch: () => new Response() };\n");
writeFileSync(
  join(project, "wrangler.toml"),
  'name = "fixture"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\n\n[env.staging]\nname = "fixture-staging"\n',
);
const config = ["--config", join(project, "wrangler.toml"), "--env", "staging"];
const target = [...config, "--env-file", emptyEnvFile(project)];
// A dry run calls nothing, and these make sure of it.
const env = { ...childEnv(process.env), CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:1", WRANGLER_SEND_METRICS: "false" };
const check = (run) => requireTarget("fixture-staging", { wrangler, cwd: project, target, env, ...run });

test("the child's environment leaves out what renames a deploy's Worker", () => {
  const passed = childEnv({ PATH: "/bin", HOME: "/home/me", [OVERRIDE]: "fixture", CLOUDFLARE_ENV: "production" });
  assert.deepEqual(passed, { PATH: "/bin", HOME: "/home/me" });
});

test("a deploy that would go to staging passes", () => {
  check({});
});

test("a deploy that anything renames to another Worker is refused", () => {
  assert.throws(() => check({ env: { ...env, [OVERRIDE]: "fixture" } }), /would go to the Worker "fixture", not "fixture-staging"/);
});

test("a rename in the project's .env files isn't read", () => {
  writeFileSync(join(project, ".env.staging"), `${OVERRIDE}=fixture\n`);
  // Without the empty --env-file wrangler reads it, which is what the wrapper's flag prevents.
  assert.throws(() => check({ target: config }), /would go to the Worker "fixture"/);
  check({});
});
