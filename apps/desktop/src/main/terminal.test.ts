import { expect, test } from "vite-plus/test";

import type { CliKind } from "../protocol/generated/protocol";
import { loginCommand, hostLogin, masterCommand } from "./terminal";

const mini = { destination: "me@mini", ssh: "ssh" };

test("runs a CLI's sign-in here, through cmd.exe for a Windows batch shim", () => {
  expect(loginCommand("claude", "/opt/homebrew/bin/claude", undefined, "darwin")).toEqual({
    file: "/opt/homebrew/bin/claude",
    args: ["auth", "login"],
  });
  expect(loginCommand("codex", "C:\\Tools\\codex.exe", undefined, "win32").args).toEqual(["login"]);
  expect(loginCommand("codex", "C:\\Users\\A B\\npm\\codex.CMD", undefined, "win32")).toEqual({
    file: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/c", "C:\\Users\\A B\\npm\\codex.CMD", "login"],
  });
});

test("runs it over ssh -t, quoting the path for the host's shell", () => {
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
  // A provider instance's login, with its home: here as a variable, there before the command.
  const home = { CODEX_HOME: "/Users/me/.codex-work" };
  expect(loginCommand("codex", "codex", undefined, "darwin", ["login"], home)).toEqual({
    file: "codex",
    args: ["login"],
    env: home,
  });
  expect(loginCommand("codex", "codex", mini, "darwin", ["login"], home).args.at(-1)).toBe(
    "CODEX_HOME=/Users/me/.codex-work codex login",
  );
});

test("only a saved SSH host has a login, and not on Windows", () => {
  const saved = [{ id: "h-mini", destination: "me@mini" }];
  expect(hostLogin("h-mini", saved, "ssh", "darwin")).toEqual(
    masterCommand({ destination: "me@mini", ssh: "ssh" }),
  );
  for (const id of ["h-gone", "local", "tailnet:abc"]) {
    expect(hostLogin(id, saved, "ssh", "darwin")).toBeUndefined();
  }
  expect(hostLogin("h-mini", saved, "ssh", "win32")).toBeUndefined();
});
