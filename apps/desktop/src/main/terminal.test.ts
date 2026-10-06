import { expect, test } from "vite-plus/test";

import type { CliKind } from "../protocol/generated/protocol";
import {
  installCommand,
  loginCommand,
  hostLogin,
  masterCommand,
  runInstall,
  shellCommand,
  terminalEnv,
  type Command,
} from "./terminal";

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

test("runs ssh.exe on Windows, where node-pty won't add the extension", () => {
  const path = "/usr/local/bin/codex";
  expect(loginCommand("codex", path, mini, "win32").file).toBe("ssh.exe");
  const custom = { ...mini, ssh: "C:\\Tools\\ssh.exe" };
  expect(loginCommand("codex", path, custom, "win32").file).toBe("C:\\Tools\\ssh.exe");
  expect(loginCommand("codex", path, mini, "linux").file).toBe("ssh");
});

test("opens the login shell in a folder here: $SHELL -l, or PowerShell on Windows", () => {
  const env = { SHELL: "/bin/zsh" };
  expect(shellCommand("/repo/wt", undefined, "darwin", env)).toEqual({
    file: "/bin/zsh",
    args: ["-l"],
    cwd: "/repo/wt",
  });
  expect(shellCommand("/repo/wt", undefined, "linux", {}).file).toBe("/bin/sh");
  expect(shellCommand("C:\\repo\\wt", undefined, "win32", env)).toEqual({
    file: "powershell.exe",
    args: ["-NoLogo"],
    cwd: "C:\\repo\\wt",
  });
});

test("opens it on an SSH host after a cd, quoted for the host's shell", () => {
  const ssh = (remote: string) => ({
    file: "ssh",
    args: ["-t", "-e", "none", "-o", "ControlPath=none", "--", "me@mini", remote],
  });
  expect(shellCommand("/home/me/wt", mini, "darwin")).toEqual(
    ssh(`cd /home/me/wt && exec "$SHELL" -l`),
  );
  expect(shellCommand("~", mini, "darwin")).toEqual(ssh(`cd ~ && exec "$SHELL" -l`));
  expect(shellCommand("/home/it's me/wt", mini, "linux")).toEqual(
    ssh(`cd '/home/it'\\''s me/wt' && exec "$SHELL" -l`),
  );
  expect(shellCommand("C:\\Users\\A B\\wt", mini, "darwin")).toEqual(
    ssh('cd /d "C:\\Users\\A B\\wt" && cmd'),
  );
  expect(shellCommand("/home/me/wt", mini, "win32").file).toBe("ssh.exe");
});

test("gives the terminal a UTF-8 LANG only when no locale is set", () => {
  expect(terminalEnv({ HOME: "/Users/me" })).toEqual({ HOME: "/Users/me", LANG: "en_US.UTF-8" });
  expect(terminalEnv({ LANG: "" })).toEqual({ LANG: "en_US.UTF-8" });
  expect(terminalEnv({ LANG: "fr_FR.UTF-8" })).toEqual({ LANG: "fr_FR.UTF-8" });
  expect(terminalEnv({ LC_CTYPE: "UTF-8" })).toEqual({ LC_CTYPE: "UTF-8" });
  expect(terminalEnv({ LC_ALL: "C" })).toEqual({ LC_ALL: "C" });
});

test("installs a CLI with its own script in the login shell, here or over ssh", () => {
  expect(installCommand("claude", undefined, "darwin", { SHELL: "/bin/zsh" })).toEqual({
    file: "/bin/zsh",
    args: ["-lc", "curl -fsSL https://claude.ai/install.sh | bash"],
  });
  expect((installCommand("claude", undefined, "win32") as Command).args).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "irm https://claude.ai/install.ps1 | iex",
  ]);
  // Pi installs with npm into ~/.local, which a Nix store's read-only prefix can't stop.
  expect((installCommand("pi", undefined, "linux", {}) as Command).args).toEqual([
    "-lc",
    'npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent',
  ]);
  expect((installCommand("opencode", undefined, "win32") as Command).args.at(-1)).toBe(
    "npm install -g opencode-ai",
  );
  // A Windows SSH host gets PowerShell's, by the OS its plxd reports.
  expect((installCommand("claude", mini, "darwin", {}, "windows") as Command).args.at(-1)).toBe(
    'powershell -NoLogo -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"',
  );
  expect(installCommand("antigravity", mini, "darwin", {}, "windows")).toMatch(/can't install/);
  // Antigravity has no Windows install, so it says so instead.
  expect(installCommand("antigravity", undefined, "win32")).toMatch(/can't install/);
  expect(installCommand("codex", mini, "darwin")).toMatchObject({ file: "ssh" });
  expect((installCommand("codex", mini, "darwin") as Command).args.at(-1)).toBe(
    `exec "$SHELL" -lc 'npm install -g @openai/codex'`,
  );
});

test.skipIf(process.platform === "win32")(
  "runs an install with no terminal and says how it failed",
  async () => {
    expect(await runInstall({ file: "/bin/sh", args: ["-c", "echo ok"] })).toBeUndefined();
    expect(
      await runInstall({
        file: "/bin/sh",
        args: ["-c", "echo one; echo 'npm ERR! EACCES' >&2; exit 1"],
      }),
    ).toBe("The install failed: npm ERR! EACCES");
    // npm's real output: its error code first, then advice and its log's path.
    const npm = [
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/nope",
      "npm error 404",
      "npm error 404  'nope@*' is not in this registry.",
      "npm error A complete log of this run can be found in: /tmp/x.log",
    ];
    expect(
      await runInstall({
        file: "/bin/sh",
        args: ["-c", `printf '%s\\n' ${npm.map((l) => `"${l}"`).join(" ")} >&2; exit 1`],
      }),
    ).toBe(`The install failed: ${npm.slice(0, 3).join("\n")}`);
    expect(await runInstall("Parallax can't install this agent on Windows.")).toMatch(/can't/);
  },
);

test("an SSH host's sign-in is ssh as the control master its connections share", () => {
  const { file, args } = masterCommand({ destination: "me@mini", ssh: "/usr/bin/ssh" });
  expect(file).toBe("/usr/bin/ssh");
  expect([args].flat().join(" ")).toBe(
    "-o ControlMaster=auto -o ControlPersist=yes -o ControlPath=~/.ssh/parallax-%C " +
      "-o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -f -- me@mini",
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
