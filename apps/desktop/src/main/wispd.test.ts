import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { dataDir, findWispd, replaceServe, type ServeSystem, type WispdLookup } from "./wispd";

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

test("the data folder is WISPD_DATA_DIR, else the OS's, as wispd finds it", () => {
  expect(dataDir({ WISPD_DATA_DIR: "/d" }, "darwin", "/h")).toBe("/d");
  expect(dataDir({}, "darwin", "/h")).toBe(path.join("/h", "Library/Application Support/wisp"));
  expect(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/h")).toBe(path.join("/x", "wisp"));
  // A relative XDG_DATA_HOME is ignored, as the XDG spec says.
  expect(dataDir({ XDG_DATA_HOME: "x" }, "linux", "/h")).toBe(path.join("/h", ".local/share/wisp"));
});

/** A serve with pid 42 running `args`, which exits after `lives` liveness checks. */
function fakeServe(args: string | undefined, lives = 2) {
  const system: ServeSystem = {
    lockPid: () => {
      if (args === undefined) throw new Error("ENOENT");
      return 42;
    },
    args: async () => args ?? "",
    kill: vi.fn((_pid: number, signal?: 0) => {
      if (signal === 0 && lives-- <= 0) throw new Error("ESRCH");
    }),
    sleep: async () => {},
  };
  return system;
}

test("only a packaged wisp's serve of another version is replaced", async () => {
  const replace = (args: string | undefined, running = "1.0.0", bundled?: string) => {
    const system = fakeServe(args);
    return replaceServe("/d", running, bundled, system).then(({ stopped }) => ({
      stopped,
      killed: vi.mocked(system.kill).mock.calls.filter(([, signal]) => signal === undefined),
    }));
  };
  const macApp = "/Applications/Wisp.app/Contents/Resources/wispd serve";
  const appImage = "/tmp/.mount_WispAb1/resources/wispd serve";
  expect(await replace(macApp, "1.0.0", "1.1.0")).toEqual({ stopped: true, killed: [[42]] });
  expect(await replace(appImage, "1.1.0", "1.0.0")).toEqual({ stopped: true, killed: [[42]] });
  // The same or an unknown version, or no serve running, stops nothing.
  expect(await replace(macApp, "1.0.0", "1.0.0")).toEqual({ stopped: false, killed: [] });
  expect(await replace(macApp, "1.0.0", undefined)).toEqual({ stopped: false, killed: [] });
  expect(await replace(undefined, "1.0.0", "1.1.0")).toEqual({ stopped: false, killed: [] });
  // A dev checkout's Cargo build, a wispd on PATH (such as a service's), or a reused pid.
  for (const args of [
    "/Users/me/wisp/target/debug/wispd serve",
    "/usr/local/bin/wispd serve",
    "/Applications/Wisp.app/Contents/MacOS/Wisp",
  ]) {
    expect(await replace(args, "0.1.0", "1.1.0")).toEqual({ stopped: false, killed: [] });
  }
});

test("a replaced serve is waited for until it exits", async () => {
  const system = fakeServe("/Applications/Wisp.app/Contents/Resources/wispd serve", 3);
  await replaceServe("/d", "1.0.0", "1.1.0", system);
  // SIGTERM, then liveness checks until the fourth finds it gone.
  expect(vi.mocked(system.kill).mock.calls).toEqual([[42], [42, 0], [42, 0], [42, 0], [42, 0]]);
});
