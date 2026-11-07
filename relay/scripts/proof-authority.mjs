#!/usr/bin/env node
// PLX-1475: disposable authority gate only. No daemon, transport timing or remote Worker.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const relay = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(process.env.PLX_PROOF_OUTPUT ?? join(relay, "..", "proof", "plx-1475", "local"));
const scratch = mkdtempSync(join(tmpdir(), "plx-1475-authority-"));
mkdirSync(output, { recursive: true });
mkdirSync(join(scratch, "bin"));
writeFileSync(join(scratch, "bin", "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
for (const dir of ["home", "tmp", "cache", "config", "data"]) mkdirSync(join(scratch, dir));
// Allowlist instead of inheriting account credentials, proxy authorization, .env configuration,
// CLI sessions or host test tokens. vitest.config.ts generates the only accepted identity.
const env = {
  PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
  HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"),
  XDG_CACHE_HOME: join(scratch, "cache"), XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_DATA_HOME: join(scratch, "data"), WRANGLER_SEND_METRICS: "false", CI: "true",
};
try {
  const result = spawnSync(join(relay, "node_modules", ".bin", "vitest"), [
    "run", "test/host-proof.test.ts", "--reporter=default", "--reporter=json",
    `--outputFile=${join(output, "authority-results.json")}`,
  ], { cwd: relay, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(join(output, "authority.log"), (result.stdout ?? "") + (result.stderr ?? ""));
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
