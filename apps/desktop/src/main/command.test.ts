import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  appleScriptString,
  commandSource,
  commandState,
  installCommand,
  layout,
  offerAtLaunch,
  onPath,
  readRecord,
  removeCommand,
  shellQuote,
  windowsLauncher,
  writeRecord,
  type Layout,
} from "./command";

const folder = () => mkdtempSync(path.join(tmpdir(), "command-"));

test("the command goes where each OS's PATH already looks", () => {
  const plxd = "/Applications/Parallax.app/Contents/Resources/plxd";
  expect(layout("darwin", {}, "/Users/me", plxd).file).toBe("/usr/local/bin/parallax");
  expect(layout("linux", {}, "/home/me", "/tmp/.mount_x/resources/plxd")).toMatchObject({
    file: "/home/me/.local/bin/parallax",
    copy: "/home/me/.local/share/parallax/app",
  });
  expect(layout("linux", { XDG_DATA_HOME: "/data" }, "/home/me", plxd).copy).toBe(
    "/data/parallax/app",
  );
  const local = "C:\\Users\\me\\AppData\\Local";
  expect(layout("win32", { LOCALAPPDATA: local }, "C:\\Users\\me", "x.exe").file).toBe(
    `${local}\\Parallax\\bin\\parallax.cmd`,
  );
});

test("only a packaged app's own plxd is offered, and not from a disk image", () => {
  const lookup = {
    packaged: true,
    env: {},
    platform: "darwin" as const,
    resourcesPath: "/Applications/Parallax.app/Contents/Resources",
    exists: () => true,
  };
  expect(commandSource(lookup)).toBe("/Applications/Parallax.app/Contents/Resources/plxd");
  expect(commandSource({ ...lookup, packaged: false })).toBeUndefined();
  expect(commandSource({ ...lookup, env: { PLXD_PATH: "/x/plxd" } })).toBeUndefined();
  expect(
    commandSource({
      ...lookup,
      resourcesPath: "/private/var/folders/x/AppTranslocation/y/d/Parallax.app/Contents/Resources",
    }),
  ).toBeUndefined();
  expect(
    commandSource({ ...lookup, platform: "win32", resourcesPath: "C:\\Parallax\\resources" }),
  ).toBe("C:\\Parallax\\resources\\plxd.exe");
});

// Windows rewrites a POSIX symlink's target with backslashes, and macOS's command is never there.
test.skipIf(process.platform === "win32")(
  "macOS: this app's link, another Parallax's, and anything else",
  async () => {
    const dir = folder();
    const plxd = "/Applications/Parallax.app/Contents/Resources/plxd";
    const at = (file: string, bundled = plxd): Layout => ({
      platform: "darwin",
      file,
      plxd: bundled,
    });
    const file = path.join(dir, "parallax");
    expect(await commandState(at(file))).toBe("missing");
    symlinkSync(plxd, file);
    expect(await commandState(at(file))).toBe("installed");
    const nightly = "/Applications/Parallax (Nightly).app/Contents/Resources/plxd";
    expect(await commandState(at(file, nightly))).toBe("stale");
    const other = path.join(dir, "other");
    symlinkSync("/opt/somewhere/parallax", other);
    expect(await commandState(at(other))).toBe("other");
    const script = path.join(dir, "script");
    writeFileSync(script, "#!/bin/sh\n");
    expect(await commandState(at(script))).toBe("other");
  },
);

test.skipIf(process.platform === "win32")(
  "macOS installs a link where the folder is the user's, and removes it",
  async () => {
    const dir = folder();
    const plxd = path.join(dir, "plxd");
    writeFileSync(plxd, "");
    const at: Layout = { platform: "darwin", file: path.join(dir, "parallax"), plxd };
    await installCommand(at);
    expect(readlinkSync(at.file)).toBe(plxd);
    await removeCommand(at);
    expect(await commandState(at)).toBe("missing");
  },
);

test.skipIf(process.platform === "win32")(
  "Linux copies plxd with what it reads beside itself, and leaves another parallax alone",
  async () => {
    const dir = folder();
    const bundle = path.join(dir, "mount", "resources");
    mkdirSync(path.join(bundle, "claude-agent-sdk", "src"), { recursive: true });
    writeFileSync(path.join(bundle, "plxd"), "plxd");
    writeFileSync(path.join(bundle, "plxd.version"), "1\n");
    writeFileSync(path.join(bundle, "claude-agent-sdk", "src", "main.mjs"), "");
    mkdirSync(path.join(bundle, "app.asar.unpacked", "dist", "renderer"), { recursive: true });
    writeFileSync(path.join(bundle, "app.asar.unpacked", "dist", "renderer", "index.html"), "");
    const at = layout("linux", {}, path.join(dir, "home"), path.join(bundle, "plxd"));
    await installCommand(at);
    expect(readlinkSync(at.file)).toBe(path.join(at.copy!, "plxd"));
    expect(existsSync(path.join(at.copy!, "claude-agent-sdk", "src", "main.mjs"))).toBe(true);
    const web = path.join(at.copy!, "app.asar.unpacked", "dist", "renderer", "index.html");
    expect(existsSync(web), "the web client").toBe(true);
    expect(await commandState(at)).toBe("installed");
    writeFileSync(path.join(bundle, "plxd.version"), "2\n");
    expect(await commandState(at), "a new app version").toBe("stale");
    await installCommand(at);
    expect(await commandState(at)).toBe("installed");
    await removeCommand(at);
    // The copy stays, for a serve that may still run from it.
    expect([await commandState(at), existsSync(at.copy!)]).toEqual(["missing", true]);

    // A user's own parallax, a file or a link elsewhere, is never the app's.
    writeFileSync(at.file, "#!/bin/sh\necho mine\n");
    expect(await commandState(at)).toBe("other");
  },
);

test("Windows: the launcher goes by %LOCALAPPDATA% and names the command", async () => {
  const local = "C:\\Users\\José\\AppData\\Local";
  const plxd = `${local}\\Programs\\Parallax\\resources\\plxd.exe`;
  const at = layout("win32", { LOCALAPPDATA: local }, "C:\\Users\\José", plxd);
  expect(windowsLauncher(at)).toBe(
    '@setlocal\r\n@set PLXD_INVOKED_AS=parallax\r\n@"%LOCALAPPDATA%\\Programs\\Parallax\\resources\\plxd.exe" %*\r\n',
  );
  const elsewhere = { ...at, plxd: "C:\\Program Files\\Parallax\\resources\\plxd.exe" };
  expect(windowsLauncher(elsewhere)).toContain(
    '@"C:\\Program Files\\Parallax\\resources\\plxd.exe" %*',
  );

  const file = path.join(folder(), "parallax.cmd");
  writeFileSync(file, windowsLauncher(at));
  expect(await commandState({ ...at, file })).toBe("installed");
  expect(await commandState({ ...elsewhere, file })).toBe("stale");
  writeFileSync(file, "@echo off\r\nsomething else\r\n");
  expect(await commandState({ ...at, file })).toBe("other");
});

test("Linux checks its folder is on PATH; Windows reads PATH by its own separator", () => {
  const linux = layout("linux", {}, "/home/me", "/x/plxd");
  expect(onPath(linux, "/usr/bin:/home/me/.local/bin")).toBe(true);
  expect(onPath(linux, "/usr/bin:/bin")).toBe(false);
  const local = "C:\\Users\\me\\AppData\\Local";
  const windows = layout("win32", { LOCALAPPDATA: local }, "C:\\Users\\me", "x.exe");
  expect(onPath(windows, `C:\\Windows;${local}\\Parallax\\bin`)).toBe(true);
});

test("macOS offers once, only when nothing is named parallax", () => {
  expect(offerAtLaunch("darwin", "missing", false)).toBe(true);
  expect(offerAtLaunch("darwin", "missing", true)).toBe(false);
  expect(offerAtLaunch("darwin", "other", false)).toBe(false);
  expect(offerAtLaunch("darwin", "stale", false)).toBe(false);
  expect(offerAtLaunch("linux", "missing", false)).toBe(false);
});

test("the record reads back, and a missing or bad one is empty", async () => {
  const file = path.join(folder(), "command.json");
  expect(await readRecord(file)).toEqual({});
  await writeRecord(file, { asked: true, removed: true });
  expect(await readRecord(file)).toEqual({ asked: true, removed: true });
  writeFileSync(file, "not json");
  expect(await readRecord(file)).toEqual({});
});

test("paths are quoted for sh inside AppleScript", () => {
  const plxd = `/Applications/Ryan's "Parallax".app/Contents/Resources/plxd`;
  expect(shellQuote(plxd)).toBe(
    `'/Applications/Ryan'\\''s "Parallax".app/Contents/Resources/plxd'`,
  );
  expect(appleScriptString(`ln -s ${shellQuote(plxd)}`)).toBe(
    `"ln -s '/Applications/Ryan'\\\\''s \\"Parallax\\".app/Contents/Resources/plxd'"`,
  );
});
