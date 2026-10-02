import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { dataDir, findPlxd, replaceServe, type ServeSystem, type PlxdLookup } from "./plxd";

// Built with `path.join`, so the expectations hold on Windows too.
const cargo = path.join("/repo/apps/desktop", "../../target/debug/plxd");
const bundled = path.join("/App/Resources", "plxd");
const onPath = path.join("/opt/bin", "plxd");

const find = (files: string[], overrides: Partial<PlxdLookup> = {}) =>
  findPlxd({
    env: { PATH: ["/usr/bin", "/opt/bin"].join(path.delimiter) },
    platform: "darwin",
    packaged: false,
    resourcesPath: "/App/Resources",
    appPath: "/repo/apps/desktop",
    exists: (file) => files.includes(file),
    ...overrides,
  });

test("PLXD_PATH wins, and a missing one is not found rather than skipped", () => {
  const env = { PLXD_PATH: "/custom/plxd", PATH: "/opt/bin" };
  expect(find(["/custom/plxd", onPath], { env })).toBe("/custom/plxd");
  expect(find([onPath], { env })).toBeUndefined();
});

test("the bundled or Cargo-built plxd comes before PATH", () => {
  expect(find([cargo, onPath])).toBe(cargo);
  expect(find([bundled, onPath], { packaged: true })).toBe(bundled);
  expect(find([onPath])).toBe(onPath);
  expect(find([])).toBeUndefined();
});

test("the data folder is PLXD_DATA_DIR, else the OS's, as plxd finds it", () => {
  expect(dataDir({ PLXD_DATA_DIR: "/d" }, "darwin", "/h")).toBe("/d");
  expect(dataDir({}, "darwin", "/h")).toBe(path.join("/h", "Library/Application Support/parallax"));
  expect(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/h")).toBe(path.join("/x", "parallax"));
  // A relative XDG_DATA_HOME is ignored, as the XDG spec says.
  expect(dataDir({ XDG_DATA_HOME: "x" }, "linux", "/h")).toBe(
    path.join("/h", ".local/share/parallax"),
  );
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

test("only a packaged Parallax's serve of another version is replaced", async () => {
  const replace = (args: string | undefined, running = "1.0.0", bundled?: string) => {
    const system = fakeServe(args);
    return replaceServe("/d", running, bundled, system).then(({ stopped }) => ({
      stopped,
      killed: vi.mocked(system.kill).mock.calls.filter(([, signal]) => signal === undefined),
    }));
  };
  const macApp = "/Applications/Parallax.app/Contents/Resources/plxd serve";
  const appImage = "/tmp/.mount_ParallaxAb1/resources/plxd serve";
  expect(await replace(macApp, "1.0.0", "1.1.0")).toEqual({ stopped: true, killed: [[42]] });
  expect(await replace(appImage, "1.1.0", "1.0.0")).toEqual({ stopped: true, killed: [[42]] });
  // The same or an unknown version, or no serve running, stops nothing.
  expect(await replace(macApp, "1.0.0", "1.0.0")).toEqual({ stopped: false, killed: [] });
  expect(await replace(macApp, "1.0.0", undefined)).toEqual({ stopped: false, killed: [] });
  expect(await replace(undefined, "1.0.0", "1.1.0")).toEqual({ stopped: false, killed: [] });
  // A dev checkout's Cargo build, a plxd on PATH (such as a service's), or a reused pid.
  for (const args of [
    "/Users/me/parallax/target/debug/plxd serve",
    "/usr/local/bin/plxd serve",
    "/Applications/Parallax.app/Contents/MacOS/Parallax",
  ]) {
    expect(await replace(args, "0.1.0", "1.1.0")).toEqual({ stopped: false, killed: [] });
  }
});

test("a replaced serve is waited for until it exits", async () => {
  const system = fakeServe("/Applications/Parallax.app/Contents/Resources/plxd serve", 3);
  await replaceServe("/d", "1.0.0", "1.1.0", system);
  // SIGTERM, then liveness checks until the fourth finds it gone.
  expect(vi.mocked(system.kill).mock.calls).toEqual([[42], [42, 0], [42, 0], [42, 0], [42, 0]]);
});
