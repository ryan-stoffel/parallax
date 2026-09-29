import { expect, test } from "vite-plus/test";

import { loginCommand } from "./terminal";

const mini = { destination: "me@mini", ssh: "ssh" };

test("runs a CLI's sign-in here, through cmd.exe for a Windows batch shim", () => {
  expect(loginCommand("claude", "/opt/homebrew/bin/claude", undefined, "darwin")).toEqual({
    file: "/opt/homebrew/bin/claude",
    args: ["auth", "login"],
  });
  expect(loginCommand("codex", "C:\\Tools\\codex.exe", undefined, "win32").args).toEqual(["login"]);
  expect(loginCommand("codex", "C:\\Users\\A B\\npm\\codex.CMD", undefined, "win32")).toEqual({
    file: process.env["ComSpec"] ?? "cmd.exe",
    args: '/d /s /c ""C:\\Users\\A B\\npm\\codex.CMD" login"',
  });
});

test("runs it over ssh -t, quoting the path for the host's shell", () => {
  const ssh = (...args: string[]) => ({
    file: "ssh",
    args: ["-t", "-e", "none", "-o", "ControlPath=none", ...args],
  });
  expect(loginCommand("claude", "/Users/me/.local/bin/claude", mini)).toEqual(
    ssh("--", "me@mini", "/Users/me/.local/bin/claude auth login"),
  );
  // Codex's browser callback comes back to this computer's localhost.
  expect(loginCommand("codex", "/usr/local/bin/codex", mini)).toEqual(
    ssh("-L", "1455:localhost:1455", "--", "me@mini", "/usr/local/bin/codex login"),
  );
  expect(loginCommand("cursor", "/home/it's me/bin/agent", mini).args.at(-1)).toBe(
    `NO_OPEN_BROWSER=1 '/home/it'\\''s me/bin/agent' login`,
  );
  expect(loginCommand("claude", "C:\\Users\\A B\\.local\\bin\\claude.exe", mini).args.at(-1)).toBe(
    '"C:\\Users\\A B\\.local\\bin\\claude.exe" auth login',
  );
});
