import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import {
  appDataDir,
  dataDir,
  findPlxd,
  movesServiceBack,
  replaceServe,
  plistProgram,
  serviceStep,
  type ServeSystem,
  type PlxdLookup,
} from "./plxd";

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

test("the data folder is PLXD_DATA_DIR, else ~/.parallax, else an older folder that exists", () => {
  const only =
    (...dirs: string[]) =>
    (dir: string) =>
      dirs.includes(dir);
  const old = path.join("/h", "Library/Application Support/parallax");
  const home = path.join("/h", ".parallax");
  expect(dataDir({ PLXD_DATA_DIR: "/d" }, "darwin", "/h", only())).toBe("/d");
  expect(dataDir({}, "darwin", "/h", only())).toBe(home);
  expect(dataDir({}, "darwin", "/h", only(old))).toBe(old);
  expect(dataDir({}, "darwin", "/h", only(old, home))).toBe(home);
  expect(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/h", only(path.join("/x", "parallax")))).toBe(
    path.join("/x", "parallax"),
  );
  // A relative XDG_DATA_HOME is ignored, as the XDG spec says.
  expect(
    dataDir({ XDG_DATA_HOME: "x" }, "linux", "/h", only(path.join("/h", ".local/share/parallax"))),
  ).toBe(path.join("/h", ".local/share/parallax"));
});

test("the app's data is ~/.parallax/desktop, else its old folder if that exists", () => {
  const only =
    (...dirs: string[]) =>
    (dir: string) =>
      dirs.includes(dir);
  const current = path.join("/h", ".parallax", "desktop");
  expect(appDataDir("/h", "/old", only())).toBe(current);
  expect(appDataDir("/h", "/old", only("/old"))).toBe("/old");
  expect(appDataDir("/h", "/old", only("/old", current))).toBe(current);
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

test("keepServing's next step: done once the service runs plxd, installing only with no agents running", () => {
  const status = (installed: boolean, loaded: boolean, running: boolean) =>
    `label: io.github.ryan-stoffel.parallax.plxd\nfile: /Users/r/Library/LaunchAgents/x.plist\ninstalled: ${installed}\nloaded: ${loaded}\nrunning: ${running}\npid: -\nanswers initialize: true\n`;
  expect(serviceStep(status(true, true, true), 3, false)).toBe("done");
  // Loaded but not running: the app's own serve may still hold the data folder.
  expect(serviceStep(status(true, true, false), 0, false)).toBe("install");
  expect(serviceStep(status(false, false, false), 0, false)).toBe("install");
  expect(serviceStep(status(false, false, false), 2, false)).toBe("wait");
  expect(serviceStep(status(false, false, false), undefined, false)).toBe("wait");
  // This launch installed it, and it still isn't running: no second try until the next launch.
  expect(serviceStep(status(true, true, false), 0, true)).toBe("failed");
});

test("a LaunchAgent moves back from an SSH-installed plxd only to a newer one, with no agents running", () => {
  const ssh = "/Users/r/.parallax-plxd/plxd";
  const cases: [string, string | undefined, string | undefined, number | undefined, boolean][] = [
    [ssh, "1.2.0", "1.3.0", 0, true],
    [ssh, "1.3.0-nightly", "1.3.0", 0, true],
    [ssh, "1.3.0", "1.3.0", 0, false],
    [ssh, "1.4.0", "1.3.0", 0, false],
    [ssh, "1.2.0", "1.3.0", 1, false],
    [ssh, "1.2.0", "1.3.0", undefined, false],
    [ssh, undefined, "1.3.0", 0, false],
    [ssh, "1.2.0", undefined, 0, false],
    // Another install's plxd stays.
    ["/Applications/Parallax.app/Contents/Resources/plxd", "1.2.0", "1.3.0", 0, false],
  ];
  for (const [program, theirs, ours, agents, moves] of cases)
    expect(
      movesServiceBack(program, "/Users/r", theirs, ours, agents),
      `${program} ${theirs} ${ours} ${agents}`,
    ).toBe(moves);
});

test("a LaunchAgent's program is the first ProgramArguments string, unescaped", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>io.github.ryan-stoffel.parallax.plxd</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Applications/R&amp;D/Parallax (Nightly).app/Contents/Resources/plxd</string>
\t\t<string>serve</string>
\t</array>
</dict>
</plist>`;
  expect(plistProgram(plist)).toBe(
    "/Applications/R&D/Parallax (Nightly).app/Contents/Resources/plxd",
  );
  expect(plistProgram("<plist></plist>")).toBeUndefined();
});
