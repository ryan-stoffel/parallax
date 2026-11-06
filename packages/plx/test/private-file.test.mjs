// @ts-check
// scripts/bench/private-file.mjs, which relay-probe.mjs uses for a rotated token (PLX-1452).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replacePrivately } from "../../../scripts/bench/private-file.mjs";

test("replaces the file with a 0600 one and leaves nothing beside it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "private-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "probe-token");
  writeFileSync(file, "old-token", { mode: 0o644 });
  replacePrivately(file, "new-token");
  assert.equal(readFileSync(file, "utf8"), "new-token");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["probe-token"]);
});

test("a failed replace keeps the old file whole and removes its temporary", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "private-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A folder where the file should be makes the rename fail after the temporary is written.
  const file = join(dir, "probe-token");
  mkdirSync(file);
  writeFileSync(join(file, "inside"), "old-token");
  assert.throws(() => replacePrivately(file, "new-token"));
  assert.equal(readFileSync(join(file, "inside"), "utf8"), "old-token");
  assert.deepEqual(readdirSync(dir), ["probe-token"]);
});
