// @ts-check
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findOnPath, parseServiceStatus, plxdCandidates, resolveDataDir } from "../src/doctor.mjs";

test("the data folder is ~/.parallax unless only the legacy folder exists", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "plx-doctor-test-"));
  const legacy = path.join(home, "Library", "Application Support", "parallax");
  assert.equal(resolveDataDir("darwin", home, {}), path.join(home, ".parallax"));
  mkdirSync(legacy, { recursive: true });
  assert.equal(resolveDataDir("darwin", home, {}), legacy);
  mkdirSync(path.join(home, ".parallax"));
  assert.equal(resolveDataDir("darwin", home, {}), path.join(home, ".parallax"));
  assert.equal(resolveDataDir("darwin", home, { PLXD_DATA_DIR: "/data" }), path.resolve("/data"));
});

test("plxd is looked for in both apps on macOS and in ~/.local/bin on Linux", () => {
  assert.deepEqual(plxdCandidates("darwin", "/Users/me", {}), [
    "/Applications/Parallax.app/Contents/Resources/plxd",
    "/Applications/Parallax (Nightly).app/Contents/Resources/plxd",
    "/Users/me/Applications/Parallax.app/Contents/Resources/plxd",
    "/Users/me/Applications/Parallax (Nightly).app/Contents/Resources/plxd",
  ]);
  assert.deepEqual(plxdCandidates("linux", "/home/me", {}), ["/home/me/.local/bin/plxd"]);
});

test("a command is found on PATH, and a folder of its name isn't", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plx-doctor-test-"));
  mkdirSync(path.join(dir, "a", "claude"), { recursive: true });
  mkdirSync(path.join(dir, "b"));
  writeFileSync(path.join(dir, "b", "claude"), "");
  chmodSync(path.join(dir, "b", "claude"), 0o755);
  const env = { PATH: [path.join(dir, "a"), path.join(dir, "b")].join(path.delimiter) };
  assert.equal(findOnPath("claude", env, "darwin"), path.join(dir, "b", "claude"));
  assert.equal(findOnPath("codex", env, "darwin"), undefined);
});

test("plxd service status reads as a map", () => {
  const status = parseServiceStatus("label: x\ninstalled: true\nrunning: false\npid: -\nanswers initialize: true\n");
  assert.equal(status["answers initialize"], "true");
  assert.equal(status["running"], "false");
});
