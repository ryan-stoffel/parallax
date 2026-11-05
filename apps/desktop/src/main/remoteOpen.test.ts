import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  deriveDestination,
  folderUser,
  selfDeletingScript,
  shellInFolder,
  sshShellCommand,
} from "./remoteOpen";

test("reads the user from a home folder on any OS", () => {
  expect(folderUser("/Users/ryan-stoffel/Developer/x")).toBe("ryan-stoffel");
  expect(folderUser("/home/me/x")).toBe("me");
  expect(folderUser("C:\\Users\\me\\x")).toBe("me");
  expect(folderUser("/srv/app")).toBeUndefined();
  expect(folderUser("/Users/bad name/x")).toBeUndefined();
});

test("prefers the user's ssh config, then the computer's address as the folder's owner", () => {
  const folder = "/Users/me/repo";
  const device = { names: ["Mac-Mini", undefined], address: "100.64.0.1", folder };
  expect(deriveDestination({ ...device, aliases: ["mac-mini"] })).toBe("mac-mini");
  expect(deriveDestination({ ...device, aliases: [] })).toBe("me@100.64.0.1");
  expect(deriveDestination({ ...device, folder: "/srv/app", aliases: [] })).toBe("100.64.0.1");
  expect(deriveDestination({ names: ["mac-mini"], aliases: [], folder })).toBeUndefined();
  expect(deriveDestination({ ...device, address: "-oProxyCommand=x", aliases: [] })).toBe(
    undefined,
  );
});

test("a Windows host's folder opens in PowerShell", () => {
  expect(shellInFolder("C:\\Users\\me\\it's")).toBe(
    `powershell -NoExit -Command "Set-Location -LiteralPath 'C:\\Users\\me\\it''s'"`,
  );
});

test("the script reaches the host's shell in a folder with any name, and removes itself", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "parallax-remote-open-")));
  const folder = path.join(dir, `it's a $HOME; folder`);
  mkdirSync(folder);
  // Runs on "the host" what ssh would hand its login shell: the last argument.
  const ssh = path.join(dir, "fake ssh");
  writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n`, { mode: 0o700 });
  const script = path.join(dir, "open.command");
  writeFileSync(script, selfDeletingScript(sshShellCommand(ssh, "me@host", folder)), {
    mode: 0o700,
  });
  // The "shell" prints where it started.
  const shell = path.join(dir, "shell");
  writeFileSync(shell, "#!/bin/sh\npwd\n", { mode: 0o700 });
  const out = execFileSync(script, { env: { ...process.env, SHELL: shell }, encoding: "utf8" });
  expect(out.trim()).toBe(folder);
  expect(() => execFileSync("test", ["!", "-e", script])).not.toThrow();
});
