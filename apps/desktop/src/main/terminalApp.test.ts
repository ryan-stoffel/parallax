import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { readTerminalApp, terminalRunCommand, writeTerminalApp } from "./terminalApp";

test("the chosen terminal is saved and read back, and a bad file reads as none", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "terminal-")), "terminal.json");
  expect(readTerminalApp(file)).toBeUndefined();
  writeTerminalApp(file, "/Applications/Ghostty.app");
  expect(readTerminalApp(file)).toBe("/Applications/Ghostty.app");
  writeFileSync(file, '{"app":"relative/Ghostty.app"}');
  expect(readTerminalApp(file)).toBeUndefined();
});

test("hands macOS terminals a script, with -e where open alone wouldn't run it", () => {
  const run = (app: string) => terminalRunCommand("darwin", app, ["ssh", "host"], "/tmp/s.command");
  expect(run("/Applications/Ghostty.app")).toEqual({
    file: "/usr/bin/open",
    args: ["-na", "/Applications/Ghostty.app", "--args", "-e", "/tmp/s.command"],
  });
  expect(run("/System/Applications/Utilities/Terminal.app")).toEqual({
    file: "/usr/bin/open",
    args: ["-a", "/System/Applications/Utilities/Terminal.app", "/tmp/s.command"],
  });
});

test("hands other platforms' terminals the command with their own flag", () => {
  const args = (platform: NodeJS.Platform, app: string) =>
    terminalRunCommand(platform, app, ["ssh", "host"], "unused").args;
  expect(args("win32", "C:\\Windows\\wt.exe")).toEqual(["ssh", "host"]);
  // Windows Terminal would read a bare `;` as its next command.
  expect(terminalRunCommand("win32", "C:\\wt.exe", ["ssh", "a;calc"], "unused").args).toEqual([
    "ssh",
    "a\\;calc",
  ]);
  expect(args("linux", "/usr/bin/gnome-terminal")).toEqual(["--", "ssh", "host"]);
  expect(args("linux", "/usr/bin/wezterm")).toEqual(["start", "--", "ssh", "host"]);
  expect(args("linux", "/usr/bin/xterm")).toEqual(["-e", "ssh", "host"]);
});
