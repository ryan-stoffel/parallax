// @ts-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sshArgs } from "../src/run.mjs";
import { linuxScript, macScript, psQuote, shQuote, windowsScript } from "../src/scripts.mjs";

const installer = (/** @type {string} */ name) => ({
  version: "2610.10522.11930-nightly",
  name,
  url: `https://github.com/ryan-stoffel/parallax/releases/download/v2610.10522.11930-nightly/${name}`,
});
const mac = macScript(installer("parallax-2610.10522.11930-nightly-mac-arm64.dmg"), "nightly");
const linux = linuxScript(installer("parallax-plxd-2610.10522.11930-nightly-linux-x64"));
const windows = windowsScript(installer("parallax-2610.10522.11930-nightly-win-x64.exe"), "nightly");

const hasSh = process.platform !== "win32";
const hasPwsh = spawnSync("pwsh", ["-v"]).status === 0;

test("quotes values for sh and PowerShell", { skip: !hasSh }, () => {
  const value = `it's "Parallax (Nightly).app" $HOME`;
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shQuote(value)}`], { encoding: "utf8" }), value);
  assert.equal(psQuote(value), `'it''s "Parallax (Nightly).app" $HOME'`);
});

test("macOS copies the app out of the dmg and replaces only another version", () => {
  assert.match(mac, /^bundle='Parallax \(Nightly\)\.app'$/m);
  assert.match(macScript(installer("x.dmg"), "stable"), /^bundle='Parallax\.app'$/m);
  assert.match(mac, /hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "\$tmp\/mnt"/);
  assert.match(mac, /defaults read "\$app\/Contents\/Info\.plist" CFBundleShortVersionString/);
  assert.match(mac, /\[ "\$current" = "\$version" \]/);
  assert.match(mac, /ditto "\$tmp\/mnt\/\$bundle" "\$app"/);
  assert.match(mac, /app="\$HOME\/Applications\/\$bundle"/);
  assert.match(mac, /^plxd="\$app\/Contents\/Resources\/plxd"$/m);
});

test("Linux downloads the static plxd into ~/.local/bin and turns on lingering", () => {
  assert.match(linux, /curl -fsSL --retry 3 -o "\$HOME\/\.local\/bin\/\.plxd\.new" "\$url"/);
  assert.match(linux, /mv -f "\$HOME\/\.local\/bin\/\.plxd\.new" "\$HOME\/\.local\/bin\/plxd"/);
  assert.doesNotMatch(linux, /AppImage/);
  assert.match(linux, /loginctl enable-linger/);
});

/**
 * Runs the Linux script's package step in a temporary folder: `bin` holds only the tools named in
 * `tools` (fakes that log their arguments to `log`), and `nixos` makes /etc/NIXOS count.
 * `nixEnv` gives the user a nix-env profile.
 * @param {{ tools: string[], uid?: string, nixos?: boolean, nixLd?: boolean, nixEnv?: boolean }} options
 */
function runPackages({ tools, uid = "1000", nixos = false, nixLd = false, nixEnv = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), "plx-packages-"));
  if (nixEnv) {
    mkdirSync(path.join(dir, ".nix-profile"));
    writeFileSync(path.join(dir, ".nix-profile", "manifest.nix"), "[ ]");
  }
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const fake = (/** @type {string} */ name, /** @type {string} */ body) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  for (const tool of tools) fake(tool, `echo "${tool} $*" >> "${dir}/log"`);
  // A package manager "installs" by creating bwrap and socat.
  for (const manager of ["apt-get", "nix"].filter((m) => tools.includes(m)))
    fake(manager, `echo "${manager} $*" >> "${dir}/log"; for t in bwrap socat; do printf '#!/bin/sh\\n' > "${bin}/$t"; chmod +x "${bin}/$t"; done`);
  fake("id", `[ "$1" = -u ] && echo ${uid} || echo me`);
  const section = linux.slice(linux.indexOf("has() {"), linux.indexOf("if ! loginctl"));
  // Only `bin` is on PATH, so a runner's own bwrap or apt-get can't answer.
  symlinkSync(execFileSync("/bin/sh", ["-c", "command -v chmod"], { encoding: "utf8" }).trim(), path.join(bin, "chmod"));
  const out = execFileSync("/bin/sh", ["-c", section.replaceAll("/etc/NIXOS", nixos ? "/" : "/nonexistent")], {
    encoding: "utf8",
    env: { PATH: bin, HOME: dir, ...(nixLd && { NIX_LD: "/x/ld.so" }) },
  });
  const log = existsSync(path.join(dir, "log")) ? readFileSync(path.join(dir, "log"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { out, log };
}

test("Linux installs missing sandbox packages without a password, or says how", { skip: !hasSh }, () => {
  // Root with apt: installed.
  const root = runPackages({ tools: ["apt-get"], uid: "0" });
  assert.match(root.log, /^apt-get install -y bubblewrap socat$/m);
  assert.match(root.out, /Installed Claude Code's sandbox packages/);
  // A user: sudo -n, so nothing waits for a password.
  const user = runPackages({ tools: ["apt-get", "sudo"] });
  assert.match(user.log, /^sudo -n apt-get install -y bubblewrap socat$/m);
  assert.match(user.out, /needs bubblewrap socat, which plx-connect couldn't install without a password/);
  // NixOS: a Nix profile, no sudo; and nix-ld is named when it's off.
  const nixos = runPackages({ tools: ["nix"], nixos: true });
  assert.match(nixos.log, /^nix --extra-experimental-features nix-command flakes profile install nixpkgs#bubblewrap nixpkgs#socat$/m);
  assert.match(nixos.out, /Installed Claude Code's sandbox packages/);
  assert.match(nixos.out, /programs\.nix-ld\.enable = true;/);
  assert.doesNotMatch(runPackages({ tools: ["nix"], nixos: true, nixLd: true }).out, /nix-ld/);
  // A nix-env profile is left alone: nix profile would convert it into one nix-env refuses.
  const nixEnv = runPackages({ tools: ["nix", "apt-get"], nixos: true, nixEnv: true });
  assert.equal(nixEnv.log, "");
  assert.match(nixEnv.out, /Add to environment\.systemPackages in configuration\.nix/);
  // Both already there: nothing to do.
  const ready = runPackages({ tools: ["bwrap", "socat"] });
  assert.equal(ready.out, "");
});

test("macOS and Linux turn Connect on, install the service, and install plx-connect", () => {
  for (const script of [mac, linux]) {
    assert.match(script, /^"\$plxd" connect on$/m);
    assert.match(script, /if ! "\$plxd" service install; then/);
    assert.match(script, /install -g --prefix "\$HOME\/\.local" plx-connect/);
  }
});

test("Windows installs silently, opens the firewall for plxd, and starts it", () => {
  assert.match(windows, /^\$name = 'Parallax \(Nightly\)'$/m);
  assert.match(windows, /Start-Process -FilePath \$installer -ArgumentList '\/S' -Wait -PassThru/);
  assert.match(windows, /Join-Path \$_\.FullName "\$name\.exe"/);
  assert.match(windows, /New-NetFirewallRule .*-Protocol TCP -LocalPort 7340 -Program \$plxd/);
  assert.match(windows, /^& \$plxd connect on$/m);
  assert.match(windows, /\$attach = Start-Process -FilePath \$plxd -ArgumentList 'attach' .*-PassThru$/m);
  assert.doesNotMatch(windows, /'attach' .*-Wait/);
  assert.match(windows, /^\$attach\.WaitForExit\(\)$/m);
  assert.match(windows, /if \(\$attach\.ExitCode -ne 0\)/);
  assert.match(windows, /npm\.cmd/);
});

test("the sh scripts parse", { skip: !hasSh }, () => {
  for (const script of [mac, linux]) execFileSync("sh", ["-n"], { input: script });
});

test("the PowerShell script parses", { skip: !hasPwsh && "no pwsh" }, () => {
  const parse =
    "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }";
  assert.equal(execFileSync("pwsh", ["-NoProfile", "-Command", parse], { input: windows, encoding: "utf8" }).trim(), "");
});

test("ssh shares one connection and accepts a new host key", () => {
  assert.deepEqual(sshArgs("ryan@100.87.92.42", { port: "2222", controlDir: "/tmp/plxc-1" }, ["uname -sm 2>&1"]), [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/tmp/plxc-1/%C",
    "-o", "ControlPersist=120",
    "-p", "2222",
    "--", "ryan@100.87.92.42", "uname -sm 2>&1",
  ]);
  assert.deepEqual(sshArgs("100.87.92.42", {}, ["sh -s"]).slice(-3), ["--", "100.87.92.42", "sh -s"]);
});
