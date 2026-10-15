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

test("plxd is looked for where the app and plx-connect put it", () => {
  // path.join, so the expected paths use the separator of the OS the test runs on.
  const app = (/** @type {string} */ dir, /** @type {string} */ name) => path.join(dir, `${name}.app`, "Contents", "Resources", "plxd");
  assert.deepEqual(plxdCandidates("darwin", "/Users/me", {}), [
    path.join("/Users/me", ".parallax-plxd", "plxd"),
    app("/Applications", "Parallax"),
    app("/Applications", "Parallax (Nightly)"),
    app(path.join("/Users/me", "Applications"), "Parallax"),
    app(path.join("/Users/me", "Applications"), "Parallax (Nightly)"),
  ]);
  assert.deepEqual(plxdCandidates("linux", "/home/me", {}), [
    path.join("/home/me", ".parallax-plxd", "plxd"),
    path.join("/home/me", ".local", "bin", "plxd"),
    path.join("/home/me", ".local", "share", "parallax", "app", "plxd"),
  ]);
  assert.equal(plxdCandidates("linux", "/home/me", { XDG_DATA_HOME: "/data" })[2], path.join("/data", "parallax", "app", "plxd"));
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
