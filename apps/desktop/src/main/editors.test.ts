import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { detectEditors, editorCommand, isDirectory, isFolderPath } from "./editors";

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

test("finds editors' app bundles on macOS, with Remote SSH only where the bundle has its CLI", () => {
  const here = new Set([
    "/Applications/Visual Studio Code.app",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/Applications/Zed.app",
    "/Users/me/Applications/PyCharm CE.app",
  ]);
  const found = detectEditors("darwin", { HOME: "/Users/me", PATH: "/usr/bin" }, (f) =>
    here.has(f),
  );
  expect(found).toEqual({
    vscode: {
      program: "/Applications/Visual Studio Code.app",
      remote: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    },
    zed: { program: "/Applications/Zed.app", remote: undefined },
    pycharm: { program: "/Users/me/Applications/PyCharm CE.app", remote: undefined },
  });
});

test("finds editors' CLIs on PATH on Linux", () => {
  const here = new Set(["/usr/bin/zeditor", "/home/me/.local/bin/code"]);
  const found = detectEditors("linux", { PATH: "/usr/bin:/home/me/.local/bin" }, (f) =>
    here.has(f),
  );
  expect(found).toEqual({
    vscode: { program: "/home/me/.local/bin/code", remote: "/home/me/.local/bin/code" },
    zed: { program: "/usr/bin/zeditor", remote: undefined },
  });
});

test("opens a local folder with open -a on macOS and an SSH host's over Remote SSH", () => {
  const code = { program: "/Applications/Visual Studio Code.app", remote: "/x/bin/code" };
  expect(editorCommand("darwin", code, "/repo")).toEqual({
    file: "/usr/bin/open",
    args: ["-a", "/Applications/Visual Studio Code.app", "/repo"],
  });
  expect(editorCommand("darwin", code, "/repo", "me@box")).toEqual({
    file: "/x/bin/code",
    args: ["--remote", "ssh-remote+me@box", "/repo"],
  });
  expect(editorCommand("linux", { program: "/usr/bin/zed" }, "/repo")).toEqual({
    file: "/usr/bin/zed",
    args: ["/repo"],
  });
});
