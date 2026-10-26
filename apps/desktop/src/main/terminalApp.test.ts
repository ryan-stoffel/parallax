import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { readTerminalApp, writeTerminalApp } from "./terminalApp";

test("the chosen terminal is saved and read back, and a bad file reads as none", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "terminal-")), "terminal.json");
  expect(readTerminalApp(file)).toBeUndefined();
  writeTerminalApp(file, "/Applications/Ghostty.app");
  expect(readTerminalApp(file)).toBe("/Applications/Ghostty.app");
  writeFileSync(file, '{"app":"relative/Ghostty.app"}');
  expect(readTerminalApp(file)).toBeUndefined();
});
