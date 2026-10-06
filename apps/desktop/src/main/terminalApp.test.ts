import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { readTerminalApp, terminalCommand, terminalName, writeTerminalApp } from "./terminalApp";

test("the chosen terminal is saved and read back, and a bad file reads as none", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "terminal-")), "terminal.json");
  expect(readTerminalApp(file)).toBeUndefined();
  writeTerminalApp(file, "/Applications/Ghostty.app");
  expect(readTerminalApp(file)).toBe("/Applications/Ghostty.app");
  writeFileSync(file, '{"app":"relative/Ghostty.app"}');
  expect(readTerminalApp(file)).toBeUndefined();
});

test("macOS opens the folder with open -a, elsewhere the app starts in it", () => {
  expect(terminalName("/Applications/iTerm.app")).toBe("iTerm");
  expect(terminalName("C:\\Program Files\\WezTerm\\wezterm-gui.exe")).toBe("wezterm-gui");
  expect(terminalCommand("darwin", "/Applications/iTerm.app", "/Users/me/repo")).toEqual({
    file: "/usr/bin/open",
    args: ["-a", "/Applications/iTerm.app", "/Users/me/repo"],
  });
  expect(terminalCommand("linux", "/usr/bin/kitty", "/home/me/repo")).toEqual({
    file: "/usr/bin/kitty",
    args: [],
    cwd: "/home/me/repo",
  });
});
