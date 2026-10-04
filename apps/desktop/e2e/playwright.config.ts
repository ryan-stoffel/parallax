import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

// `pnpm e2e`: the built app against a fake-backend plxd (PLX-16). See app.spec.ts.
export default defineConfig({
  testDir: ".",
  // Outside the repo, so nothing needs ignoring.
  outputDir: path.join(tmpdir(), "parallax-e2e-results"),
  // One app and one plxd, shared by the flows in order.
  workers: 1,
  timeout: 60_000,
  // Starting plxd and a thread's worktree can take a few seconds on a cold runner.
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? [["list"], ["github"]] : "list",
});
