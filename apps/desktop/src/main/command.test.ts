import { mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  appleScriptString,
  commandPath,
  commandSource,
  commandState,
  installCommand,
  offerAtLaunch,
  readRecord,
  removeCommand,
  shellQuote,
  windowsLauncher,
  writeRecord,
} from "./command";

const folder = () => mkdtempSync(path.join(tmpdir(), "command-"));

test("the command goes where each OS's PATH already looks", () => {
  expect(commandPath("darwin", {}, "/Users/me")).toBe("/usr/local/bin/parallax");
  expect(commandPath("linux", {}, "/home/me")).toBe("/home/me/.local/bin/parallax");
  expect(
    commandPath("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me"),
  ).toBe("C:\\Users\\me\\AppData\\Local\\Parallax\\bin\\parallax.cmd");
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

test("macOS: this app's link, another Parallax's, and anything else", async () => {
  const dir = folder();
  const file = path.join(dir, "parallax");
  const plxd = "/Applications/Parallax.app/Contents/Resources/plxd";
  expect(await commandState("darwin", file, plxd, {})).toBe("missing");
  symlinkSync(plxd, file);
  expect(await commandState("darwin", file, plxd, {})).toBe("installed");
  const nightly = "/Applications/Parallax (Nightly).app/Contents/Resources/plxd";
  expect(await commandState("darwin", file, nightly, {})).toBe("stale");
  const other = path.join(dir, "other");
  symlinkSync("/opt/somewhere/parallax", other);
  expect(await commandState("darwin", other, plxd, {})).toBe("other");
  const script = path.join(dir, "script");
  writeFileSync(script, "#!/bin/sh\n");
  expect(await commandState("darwin", script, plxd, {})).toBe("other");
});

test("macOS installs a link where the folder is the user's, and removes it", async () => {
  const dir = folder();
  const file = path.join(dir, "parallax");
  const plxd = path.join(dir, "plxd");
  writeFileSync(plxd, "");
  await installCommand("darwin", file, plxd);
  expect(readlinkSync(file)).toBe(plxd);
  await removeCommand("darwin", file);
  expect(await commandState("darwin", file, plxd, {})).toBe("missing");
});

test("Linux copies plxd, and another file of the same name isn't its own", async () => {
  const dir = folder();
  const plxd = path.join(dir, "plxd");
  writeFileSync(plxd, "plxd 1");
  const file = path.join(dir, "bin", "parallax");
  await installCommand("linux", file, plxd);
  expect(await commandState("linux", file, plxd, { copied: true })).toBe("installed");
  expect(await commandState("linux", file, plxd, {})).toBe("other");
  writeFileSync(plxd, "plxd 2, a newer one");
  expect(await commandState("linux", file, plxd, { copied: true })).toBe("stale");
});

test("Windows: the launcher runs plxd's TUI, and another one is someone else's", async () => {
  const dir = folder();
  const file = path.join(dir, "parallax.cmd");
  const plxd = "C:\\Users\\me\\AppData\\Local\\Programs\\Parallax\\resources\\plxd.exe";
  expect(windowsLauncher(plxd)).toBe(`@"${plxd}" tui %*\r\n`);
  writeFileSync(file, windowsLauncher(plxd));
  expect(await commandState("win32", file, plxd, {})).toBe("installed");
  expect(await commandState("win32", file, "D:\\Parallax\\resources\\plxd.exe", {})).toBe("stale");
  writeFileSync(file, "@echo off\r\nsomething else\r\n");
  expect(await commandState("win32", file, plxd, {})).toBe("other");
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
  await writeRecord(file, { asked: true, copied: true });
  expect(await readRecord(file)).toEqual({ asked: true, copied: true });
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
