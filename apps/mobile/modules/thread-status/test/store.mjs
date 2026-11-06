#!/usr/bin/env node
// The native test of which threads the widget keeps (0100), on a Mac: compiles ThreadStatus.swift
// with store.swift as its main file and runs it.
//
//   node modules/thread-status/test/store.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "thread-status-"));
try {
  const main = join(scratch, "main.swift");
  cpSync(join(here, "store.swift"), main);
  const binary = join(scratch, "store");
  execFileSync("swiftc", [join(here, "..", "ios", "ThreadStatus.swift"), main, "-o", binary], {
    stdio: "inherit",
  });
  execFileSync(binary, { stdio: "inherit" });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
