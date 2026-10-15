// @ts-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sshArgs } from "../src/run.mjs";
import { linuxScript, macScript, psQuote, shQuote, windowsScript } from "../src/scripts.mjs";

const SHA256 = "5f".repeat(32);
const installer = (/** @type {string} */ name, sha256 = SHA256) => ({
  version: "2610.10522.11930-nightly",
  name,
  url: `https://github.com/ryan-stoffel/parallax/releases/download/v2610.10522.11930-nightly/${name}`,
  sha256,
});
const mac = macScript(installer("parallax-2610.10522.11930-nightly-mac-arm64.dmg"), "nightly");
const macPlxd = macScript(installer("parallax-plxd-2610.10522.11930-nightly-mac-arm64"), "nightly", true);
const linux = linuxScript(installer("parallax-plxd-2610.10522.11930-nightly-linux-x64"));
const windows = windowsScript(installer("parallax-2610.10522.11930-nightly-win-x64.exe"), "nightly");
const windowsPlxd = windowsScript(installer("parallax-plxd-2610.10522.11930-nightly-win-x64.exe"), "nightly", true);

const hasSh = process.platform !== "win32";
const hasPwsh = spawnSync("pwsh", ["-v"]).status === 0;

test("quotes values for sh and PowerShell", { skip: !hasSh }, () => {
  const value = `it's "Parallax (Nightly).app" $HOME`;
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shQuote(value)}`], { encoding: "utf8" }), value);
  assert.equal(psQuote(value), `'it''s "Parallax (Nightly).app" $HOME'`);
});

test("macOS copies the app out of the dmg, replacing only another version, then its plxd", () => {
  assert.match(mac, /^bundle='Parallax \(Nightly\)\.app'$/m);
  assert.match(macScript(installer("x.dmg"), "stable"), /^bundle='Parallax\.app'$/m);
  assert.match(mac, /hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "\$tmp\/mnt"/);
  assert.match(mac, /defaults read "\$app\/Contents\/Info\.plist" CFBundleShortVersionString/);
  assert.match(mac, /\[ "\$current" = "\$version" \]/);
  assert.match(mac, /ditto "\$tmp\/mnt\/\$bundle" "\$app"/);
  assert.match(mac, /app="\$HOME\/Applications\/\$bundle"/);
  assert.match(mac, /^ {2}download "\$tmp\/parallax\.dmg"$/m);
  assert.match(mac, /^cp "\$app\/Contents\/Resources\/plxd" "\$dir\/\.plxd\.new"$/m);
});

test("headless macOS downloads plxd alone, and no app", () => {
  assert.match(macPlxd, /^download "\$dir\/\.plxd\.new"$/m);
  assert.doesNotMatch(macPlxd, /hdiutil|\.app/);
});

test("Linux downloads the static plxd, links ~/.local/bin/plxd to it, and turns on lingering", () => {
  assert.match(linux, /^download "\$dir\/\.plxd\.new"$/m);
  assert.match(linux, /^ln -sf "\$plxd" "\$HOME\/\.local\/bin\/plxd"$/m);
  assert.match(linux, /^rm -f "\$HOME\/\.local\/bin\/plxd\.version"$/m);
  assert.doesNotMatch(linux, /AppImage/);
  assert.match(linux, /loginctl enable-linger/);
});

test("every POSIX install puts plxd and its version in ~/.parallax-plxd", () => {
  for (const script of [mac, macPlxd, linux]) {
    assert.match(script, /^dir="\$HOME\/\.parallax-plxd"$/m);
    assert.match(script, /^sha256='(5f){32}'$/m);
    assert.match(script, /^version='2610\.10522\.11930-nightly'$/m);
    assert.match(script, /printf '%s\\n' "\$version" > "\$dir\/plxd\.version"/);
    assert.match(script, /^mv -f "\$dir\/\.plxd\.new" "\$plxd"$/m);
  }
});

/**
 * Runs `script` with `sh -s` in a temporary home, whose `bin` comes first on PATH: a `curl` that
 * saves `served` wherever it's told, and the tools in `fakes`, each a sh body that may log to
 * `$HOME/log`. Returns the run, what's in `~/.parallax-plxd`, and the log, then removes the home.
 * @param {string} script
 * @param {string} served
 * @param {Record<string, string>} [fakes]
 */
function runInstall(script, served, fakes = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "plx-install-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(home, "served"), served);
  const tools = { curl: `while [ "$1" != -o ]; do shift; done; cp "$HOME/served" "$2"`, ...fakes };
  for (const [name, body] of Object.entries(tools)) writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = spawnSync("/bin/sh", ["-s"], { input: script, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
  const dir = path.join(home, ".parallax-plxd");
  const files = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
  const log = existsSync(path.join(home, "log")) ? readFileSync(path.join(home, "log"), "utf8") : "";
  rmSync(home, { recursive: true, force: true });
  return { run, files, log, home };
}

test("a download whose SHA-256 isn't the release's is removed, and nothing is installed", { skip: !hasSh }, () => {
  for (const script of [linux, macPlxd]) {
    const { run, files } = runInstall(script, "#!/bin/sh\necho not the release's plxd\n");
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^error: the download's SHA-256 is [0-9a-f]{64}, not (5f){32} as the release says, so it wasn't installed\.$/m);
    assert.deepEqual(files, {});
    assert.doesNotMatch(run.stdout, /Installed|Turning on/);
  }
});

test("a checked plxd goes in ~/.parallax-plxd, and the service is installed from there", { skip: !hasSh }, () => {
  /** The headless macOS script for a release whose plxd is a sh script running `body`. @param {string} body */
  const release = (body) => {
    const plxd = `#!/bin/sh\necho "$0 $*" >> "$HOME/log"\n${body}`;
    const sha256 = createHash("sha256").update(plxd).digest("hex");
    return { plxd, script: macScript(installer("parallax-plxd-1-mac-arm64", sha256), "nightly", true) };
  };
  const npm = 'echo "npm $*" >> "$HOME/log"';
  const { plxd, script } = release("");
  const done = runInstall(script, plxd, { npm });
  assert.equal(done.run.status, 0, done.run.stderr);
  assert.deepEqual(done.files, { plxd, "plxd.version": "2610.10522.11930-nightly\n" });
  assert.equal(
    done.log.replaceAll(done.home, "~"),
    "~/.parallax-plxd/plxd connect on\n~/.parallax-plxd/plxd service install --replace\nnpm install -g --prefix ~/.local plx-connect\n",
  );

  // On a Mac nobody is logged in to, launchd won't start the LaunchAgent, but its file is written.
  const noGui = release(
    `case "$*" in "service install --replace") echo "Bootstrap failed: 125" >&2; exit 1 ;; "service status") echo "installed: true" ;; esac`,
  );
  const noLogin = runInstall(noGui.script, noGui.plxd, { npm, uname: "echo Darwin" });
  assert.equal(noLogin.run.status, 0, noLogin.run.stderr);
  assert.match(noLogin.run.stdout, /^plxd's login service starts the next time you log in to this Mac\. Starting plxd now\.$/m);
  assert.doesNotMatch(noLogin.run.stdout, /Bootstrap failed|warning/);
  assert.match(noLogin.log, /plxd attach\n/);
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
  for (const script of [mac, macPlxd, linux]) {
    assert.match(script, /^"\$plxd" connect on$/m);
    assert.match(script, /^if ! out=\$\("\$plxd" service install --replace <\/dev\/null 2>&1\); then$/m);
    assert.match(script, /^ {2}"\$plxd" attach <\/dev\/null >\/dev\/null$/m);
    assert.match(script, /install -g --prefix "\$HOME\/\.local" plx-connect/);
  }
});

test("Windows installs silently, copies its plxd, opens the firewall for that one, and starts it", () => {
  assert.match(windows, /^\$name = 'Parallax \(Nightly\)'$/m);
  assert.match(windows, /^Save-Checked \$installer$/m);
  assert.match(windows, /Start-Process -FilePath \$installer -ArgumentList '\/S' -Wait -PassThru/);
  assert.match(windows, /Join-Path \$_\.FullName "\$name\.exe"/);
  assert.match(windows, /Copy-Item -Force -LiteralPath \(Join-Path \$app\.FullName 'resources\\plxd\.exe'\) -Destination "\$plxd\.new"/);
  assert.match(windows, /New-NetFirewallRule .*-Protocol TCP -LocalPort 7340 -Program \$plxd/);
  assert.match(windows, /^& \$plxd connect on$/m);
  assert.match(windows, /\$attach = Start-Process -FilePath \$plxd -ArgumentList 'attach' .*-PassThru$/m);
  assert.doesNotMatch(windows, /'attach' .*-Wait/);
  assert.match(windows, /^ {2}\$attach\.WaitForExit\(\)$/m);
  assert.match(windows, /if \(\$attach\.ExitCode -ne 0\)/);
  assert.match(windows, /Opening Parallax starts it again\./);
  assert.match(windows, /npm\.cmd/);
});

test("Windows checks the download and keeps plxd in ~/.parallax-plxd, with the app or without", () => {
  for (const script of [windows, windowsPlxd]) {
    assert.match(script, /^\$sha256 = '(5f){32}'$/m);
    assert.match(script, /\(Get-FileHash -Algorithm SHA256 -LiteralPath \$file\)\.Hash\.ToLower\(\)/);
    assert.match(script, /^ {2}if \(\$actual -ne \$sha256\) \{$/m);
    assert.match(script, /^\$dir = Join-Path \$env:USERPROFILE '\.parallax-plxd'$/m);
    assert.match(script, /^\$plxd = Join-Path \$dir 'plxd\.exe'$/m);
    assert.match(script, /WriteAllText\(\(Join-Path \$dir 'plxd\.version'\), "\$version`n"\)/);
  }
  assert.match(windowsPlxd, /^Save-Checked "\$plxd\.new"$/m);
  assert.doesNotMatch(windowsPlxd, /'\/S'|Programs|Opening Parallax/);
});

test("Windows installs the logon task, and starts plxd with attach only when that fails", () => {
  assert.match(windows, /^\$ErrorActionPreference = 'Continue'\n& \$plxd service install --replace \*> \$null\n\$service = \$LASTEXITCODE\n/m);
  const fallback = windows.indexOf("if ($service -ne 0) {");
  assert.ok(fallback > 0 && fallback < windows.indexOf("'attach'"));
});

test("the sh scripts parse", { skip: !hasSh }, () => {
  for (const script of [mac, macPlxd, linux]) execFileSync("sh", ["-n"], { input: script });
});

test("the PowerShell scripts parse", { skip: !hasPwsh && "no pwsh" }, () => {
  const parse =
    "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }";
  for (const script of [windows, windowsPlxd])
    assert.equal(execFileSync("pwsh", ["-NoProfile", "-Command", parse], { input: script, encoding: "utf8" }).trim(), "");
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
