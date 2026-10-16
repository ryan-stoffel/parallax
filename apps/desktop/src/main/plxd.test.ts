import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import {
  appDataDir,
  dataDir,
  findPlxd,
  refreshCopy,
  replaceServe,
  serviceRuns,
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
  // The copy the Linux `parallax` command runs (PLX-750).
  const copy = "/home/me/.local/share/parallax/app/plxd serve";
  expect(await replace(copy, "1.0.0", "1.1.0")).toEqual({ stopped: true, killed: [[42]] });
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

test("an installed login service is restarted on the copy instead of sending SIGTERM", async () => {
  // The app's bundled serve, or the copy the service already runs.
  for (const args of [
    "/Applications/Parallax.app/Contents/Resources/plxd serve",
    "/Users/r/.parallax-plxd/plxd serve",
  ]) {
    const system = fakeServe(args);
    let restarted = false;
    system.lockPid = () => (restarted ? 43 : 42);
    const replace = vi.fn(async () => {
      restarted = true;
    });
    const service = { status: async () => ({ pid: restarted ? 43 : 42, ready: true }), replace };
    expect(await replaceServe("/d", "1.0.0", "1.1.0", system, service)).toMatchObject({
      stopped: true,
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(system.kill).not.toHaveBeenCalled();
  }
});

test("a login service with agents running is restarted only once they finish", async () => {
  const system = fakeServe("/Users/r/.parallax-plxd/plxd serve");
  const replace = vi.fn(async () => {});
  const service = { status: async () => ({ pid: 42, ready: true }), replace };
  expect(await replaceServe("/d", "1.0.0", "1.1.0", system, service, async () => 2)).toEqual({
    stopped: false,
    why: "kept plxd serve 1.0.0: 2 agents are running, so it's replaced once they finish",
  });
  expect(replace).not.toHaveBeenCalled();
  expect(system.kill).not.toHaveBeenCalled();
});

test("a failed service upgrade never falls back to SIGTERM", async () => {
  const system = fakeServe("/Applications/Parallax.app/Contents/Resources/plxd serve");
  await expect(
    replaceServe("/d", "1.0.0", "1.1.0", system, {
      status: async () => ({ pid: 42, ready: true }),
      replace: async () => {
        throw new Error("bootout failed");
      },
    }),
  ).rejects.toThrow("bootout failed");
  expect(system.kill).not.toHaveBeenCalled();
});

test("another data folder's service, or the copy's serve without a service, is left alone", async () => {
  const service = { status: async () => ({ pid: 99, ready: true }), replace: vi.fn() };
  for (const [args, withService] of [
    ["/Applications/Parallax.app/Contents/Resources/plxd serve", true],
    ["/Users/r/.parallax-plxd/plxd serve", false],
  ] as const) {
    const system = fakeServe(args);
    expect(
      await replaceServe("/d", "1.0.0", "1.1.0", system, withService ? service : undefined),
    ).toMatchObject({ stopped: false });
    expect(system.kill).not.toHaveBeenCalled();
  }
  expect(service.replace).not.toHaveBeenCalled();
});

test("replacement fails when the bundled serve does not exit", async () => {
  const system = fakeServe("/Applications/Parallax.app/Contents/Resources/plxd serve", 200);
  await expect(replaceServe("/d", "1.0.0", "1.1.0", system)).rejects.toThrow("did not exit");
});

test("a service restart that never owns the data folder fails without SIGTERM", async () => {
  const system = fakeServe("/Applications/Parallax.app/Contents/Resources/plxd serve");
  await expect(
    replaceServe("/d", "1.0.0", "1.1.0", system, {
      status: async () => ({ pid: 42, ready: true }),
      replace: async () => {},
    }),
  ).rejects.toThrow("did not start the updated daemon");
  expect(system.kill).not.toHaveBeenCalled();
});

test("a denied SIGTERM reports a failed upgrade", async () => {
  const system = fakeServe("/Applications/Parallax.app/Contents/Resources/plxd serve");
  system.kill = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  await expect(replaceServe("/d", "1.0.0", "1.1.0", system)).rejects.toThrow(
    "operation not permitted",
  );
});

test("keepServing's next step: done once the service runs the copy, installing only with no agents running", () => {
  const status = (installed: boolean, loaded: boolean, running: boolean) =>
    `label: io.github.ryan-stoffel.parallax.plxd\nfile: /Users/r/Library/LaunchAgents/x.plist\ninstalled: ${installed}\nloaded: ${loaded}\nrunning: ${running}\npid: -\nanswers initialize: true\n`;
  expect(serviceStep(status(true, true, true), true, 3, false)).toBe("done");
  // Running something else, such as the app bundle's plxd or an older copy.
  expect(serviceStep(status(true, true, true), false, 0, false)).toBe("install");
  expect(serviceStep(status(true, true, true), false, 1, false)).toBe("wait");
  // Loaded but not running: the app's own serve may still hold the data folder.
  expect(serviceStep(status(true, true, false), true, 0, false)).toBe("install");
  expect(serviceStep(status(false, false, false), false, 0, false)).toBe("install");
  expect(serviceStep(status(false, false, false), false, undefined, false)).toBe("wait");
  // The last check installed it, and it still isn't there: a failure, tried again after a backoff.
  expect(serviceStep(status(true, true, false), true, 0, true)).toBe("failed");
  expect(serviceStep(status(true, true, true), false, 0, true)).toBe("failed");
});

test("the service runs the copy when status's program line names it, or an older plxd's file does", async () => {
  const copy = String.raw`C:\Users\r\.parallax-plxd\plxd.exe`;
  const status = (program?: string) =>
    `file: C:\\x.xml\n${program === undefined ? "" : `program: ${program}\n`}installed: true\n`;
  // A UTF-16 task file can't be searched as UTF-8 text, so the program line decides.
  const unreadable = () => Promise.resolve("\uFFFD");
  expect(await serviceRuns(status(copy), copy, unreadable)).toBe(true);
  const bundled = String.raw`C:\Program Files\Parallax\resources\plxd.exe`;
  expect(await serviceRuns(status(bundled), copy, unreadable)).toBe(false);
  expect(await serviceRuns(status("-"), copy, unreadable)).toBe(false);
  // A plxd from before PLX-576 prints no program line, so the file it names decides.
  const plist = () => Promise.resolve(`<string>${copy}</string>`);
  expect(await serviceRuns(status(), copy, plist)).toBe(true);
  expect(await serviceRuns(status(), copy, () => Promise.reject(new Error("ENOENT")))).toBe(false);
});

test("the copy and its web client are written when missing or older, never over a newer one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "plx823-"));
  try {
    const bundle = path.join(root, "Resources");
    const web = path.join("app.asar.unpacked", "dist", "renderer");
    mkdirSync(path.join(bundle, web), { recursive: true });
    writeFileSync(path.join(bundle, "plxd"), "bundled", { mode: 0o755 });
    writeFileSync(path.join(bundle, "plxd.version"), "1.1.0\n");
    writeFileSync(path.join(bundle, web, "index.html"), "bundled web");
    // As plxd reports itself: the version file beside it.
    const version = async (plxd: string) =>
      existsSync(plxd)
        ? readFileSync(path.join(path.dirname(plxd), "plxd.version"), "utf8").trim()
        : undefined;
    const dir = path.join(root, ".parallax-plxd");
    const copy = (platform: NodeJS.Platform) =>
      refreshCopy(path.join(bundle, "plxd"), root, platform, version);
    const plxd = path.join(dir, "plxd");
    const index = path.join(dir, web, "index.html");
    const files = () =>
      [plxd, path.join(dir, "plxd.version"), index].map((f) => readFileSync(f, "utf8"));

    expect(await copy("linux")).toEqual({ plxd, version: "1.1.0" });
    expect(files()).toEqual(["bundled", "1.1.0\n", "bundled web"]);
    if (process.platform !== "win32") expect(statSync(plxd).mode & 0o111).toBeTruthy();
    // Nothing is left behind in the folder.
    expect(readdirSync(dir).sort()).toEqual(["app.asar.unpacked", "plxd", "plxd.version"]);

    for (const [theirs, kept] of [
      ["1.0.0", false],
      // A nightly comes before its release (0030).
      ["1.1.0-nightly", false],
      ["1.1.0", true],
      ["1.2.0", true],
    ] as const) {
      writeFileSync(plxd, "theirs");
      writeFileSync(path.join(dir, "plxd.version"), `${theirs}\n`);
      writeFileSync(index, "theirs web");
      writeFileSync(`${path.join(dir, web)}.version`, `${theirs}\n`);
      writeFileSync(path.join(dir, web, "old.js"), "");
      expect(await copy("linux"), theirs).toEqual({ plxd, version: kept ? theirs : "1.1.0" });
      expect(files(), theirs).toEqual(
        kept ? ["theirs", `${theirs}\n`, "theirs web"] : ["bundled", "1.1.0\n", "bundled web"],
      );
      // A refresh replaces the whole web client, so no older file stays in it.
      expect(existsSync(path.join(dir, web, "old.js")), theirs).toBe(kept);
    }

    // A newer plxd from `host/update`, with no web client beside it, gets this app's.
    rmSync(path.join(dir, "app.asar.unpacked"), { recursive: true });
    expect(await copy("linux")).toEqual({ plxd, version: "1.2.0" });
    expect(files()).toEqual(["theirs", "1.2.0\n", "bundled web"]);
    expect(readFileSync(`${path.join(dir, web)}.version`, "utf8")).toBe("1.1.0\n");

    // Windows renames the old plxd.exe aside, since it can't replace one that's running.
    writeFileSync(path.join(bundle, "plxd.exe"), "bundled");
    writeFileSync(path.join(dir, "plxd.exe"), "running");
    writeFileSync(path.join(dir, "plxd.version"), "1.0.0\n");
    const exe = (await refreshCopy(path.join(bundle, "plxd.exe"), root, "win32", version)).plxd;
    expect(exe).toBe(path.join(dir, "plxd.exe"));
    expect(readFileSync(exe, "utf8")).toBe("bundled");
    expect(readFileSync(path.join(dir, "plxd.old.exe"), "utf8")).toBe("running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
