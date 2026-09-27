import path from "node:path";

import { expect, test } from "vite-plus/test";

import { findWispd, type WispdLookup } from "./wispd";

// Built with `path.join`, so the expectations hold on Windows too.
const cargo = path.join("/repo/apps/desktop", "../../target/debug/wispd");
const bundled = path.join("/App/Resources", "wispd");
const onPath = path.join("/opt/bin", "wispd");

const find = (files: string[], overrides: Partial<WispdLookup> = {}) =>
  findWispd({
    env: { PATH: ["/usr/bin", "/opt/bin"].join(path.delimiter) },
    platform: "darwin",
    packaged: false,
    resourcesPath: "/App/Resources",
    appPath: "/repo/apps/desktop",
    exists: (file) => files.includes(file),
    ...overrides,
  });

test("WISPD_PATH wins, and a missing one is not found rather than skipped", () => {
  const env = { WISPD_PATH: "/custom/wispd", PATH: "/opt/bin" };
  expect(find(["/custom/wispd", onPath], { env })).toBe("/custom/wispd");
  expect(find([onPath], { env })).toBeUndefined();
});

test("the bundled or Cargo-built wispd comes before PATH", () => {
  expect(find([cargo, onPath])).toBe(cargo);
  expect(find([bundled, onPath], { packaged: true })).toBe(bundled);
  expect(find([onPath])).toBe(onPath);
  expect(find([])).toBeUndefined();
});
