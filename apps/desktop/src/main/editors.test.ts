import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { isDirectory, isFolderPath } from "./editors";

test("takes only an absolute folder path", () => {
  expect(isFolderPath("/home/me/repo")).toBe(true);
  expect(isFolderPath("C:\\Users\\me\\repo")).toBe(true);
  expect(isFolderPath("--new-window")).toBe(false);
  expect(isFolderPath("repo")).toBe(false);
  expect(isFolderPath("/home/me/repo\n--x")).toBe(false);
  expect(isFolderPath(42)).toBe(false);
});

test("opens only a directory on this computer, never a file it would run", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "parallax-editors-"));
  const file = path.join(folder, "run.sh");
  writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  expect(isDirectory(folder)).toBe(true);
  expect(isDirectory(file)).toBe(false);
  expect(isDirectory(path.join(folder, "gone"))).toBe(false);
});
