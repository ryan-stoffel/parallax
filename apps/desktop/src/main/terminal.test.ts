import { expect, test } from "vite-plus/test";

import type { CliKind } from "../protocol/generated/protocol";
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
  // From a Mac: Windows runs ssh.exe, which the next test covers.
  const remote = (cli: CliKind, path: string) => loginCommand(cli, path, mini, "darwin");
  const ssh = (...args: string[]) => ({
    file: "ssh",
    args: ["-t", "-e", "none", "-o", "ControlPath=none", ...args],
  });
  expect(remote("claude", "/Users/me/.local/bin/claude")).toEqual(
    ssh("--", "me@mini", "/Users/me/.local/bin/claude auth login"),
  );
  // Codex's browser callback comes back to this computer's localhost.
  expect(remote("codex", "/usr/local/bin/codex")).toEqual(
    ssh(
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "1455:localhost:1455",
      "--",
      "me@mini",
      "/usr/local/bin/codex login",
    ),
  );
  expect(remote("cursor", "/home/it's me/bin/agent").args.at(-1)).toBe(
    `NO_OPEN_BROWSER=1 '/home/it'\\''s me/bin/agent' login`,
  );
  expect(remote("claude", "C:\\Users\\A B\\.local\\bin\\claude.exe").args.at(-1)).toBe(
    '"C:\\Users\\A B\\.local\\bin\\claude.exe" auth login',
  );
});

test("runs ssh.exe on Windows, where node-pty won't add the extension", () => {
  const path = "/usr/local/bin/codex";
  expect(loginCommand("codex", path, mini, "win32").file).toBe("ssh.exe");
  const custom = { ...mini, ssh: "C:\\Tools\\ssh.exe" };
  expect(loginCommand("codex", path, custom, "win32").file).toBe("C:\\Tools\\ssh.exe");
  expect(loginCommand("codex", path, mini, "linux").file).toBe("ssh");
});
