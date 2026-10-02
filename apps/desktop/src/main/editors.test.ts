import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { detectEditors, editorCommand, isDirectory, isFolderPath } from "./editors";

const only =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

test("macOS finds an editor's app bundle before PATH, then PATH", () => {
  const env = { PATH: "/Users/me/.local/bin:/opt/homebrew/bin" };
  const cursorApp = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
  // `cursor` on PATH here is Cursor Agent's shim, so the bundle wins.
  expect(
    detectEditors(
      "darwin",
      env,
      only(cursorApp, "/Users/me/.local/bin/cursor", "/opt/homebrew/bin/code"),
    ),
  ).toEqual({ cursor: cursorApp, vscode: "/opt/homebrew/bin/code" });
  expect(detectEditors("darwin", env, only())).toEqual({});
});

test("Linux looks only on PATH", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin" };
  expect(detectEditors("linux", env, only("/usr/bin/code"))).toEqual({ vscode: "/usr/bin/code" });
  expect(
    detectEditors("linux", env, only("/Applications/Cursor.app/Contents/Resources/app/bin/cursor")),
  ).toEqual({});
});

test("Windows runs the editor's exe beside the .cmd on PATH", () => {
  const vscode = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code";
  const cursor = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor";
  const env = { Path: `C:\\Windows;${vscode}\\bin;${cursor}\\resources\\app\\bin` };
  const exists = only(
    `${vscode}\\bin\\code.cmd`,
    `${vscode}\\Code.exe`,
    `${cursor}\\resources\\app\\bin\\cursor.cmd`,
    `${cursor}\\Cursor.exe`,
  );
  expect(detectEditors("win32", env, exists)).toEqual({
    cursor: `${cursor}\\Cursor.exe`,
    vscode: `${vscode}\\Code.exe`,
  });
  // A .cmd with no exe where the editor keeps it isn't an editor this can run.
  expect(detectEditors("win32", env, only(`${vscode}\\bin\\code.cmd`))).toEqual({});
});

test("opens the folder here, or over Remote SSH on an SSH host", () => {
  expect(editorCommand("/usr/bin/code", "/Users/me/repo")).toEqual({
    file: "/usr/bin/code",
    args: ["/Users/me/repo"],
  });
  expect(editorCommand("/usr/bin/cursor", "/home/me/repo wt", "me@mini")).toEqual({
    file: "/usr/bin/cursor",
    args: ["--remote", "ssh-remote+me@mini", "/home/me/repo wt"],
  });
});

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
