// @ts-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * `$HOME/log`, with `env` besides PATH and HOME. Returns the run, what's in `~/.parallax-plxd`,
 * and the log, then removes the home.
 * @param {string} script
 * @param {string} served
 * @param {Record<string, string>} [fakes]
 * @param {Record<string, string>} [env]
 */
function runInstall(script, served, fakes = {}, env = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "plx-install-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(home, "served"), served);
  const tools = { curl: `while [ "$1" != -o ]; do shift; done; cp "$HOME/served" "$2"`, ...fakes };
  for (const [name, body] of Object.entries(tools)) writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = spawnSync("/bin/sh", ["-s"], { input: script, encoding: "utf8", env: { ...env, PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
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

  // On a Mac whose service didn't start, the LaunchAgent's file is written either way, and
  // `launchctl print gui/<uid>` fails only when nobody is logged in to its desktop.
  const failed = release(
    `case "$*" in "service install --replace") echo "plxd: the old plxd (pid 42) didn't stop" >&2; exit 1 ;; "service status") echo "installed: true" ;; attach) exit "\${ATTACH_EXIT:-0}" ;; esac`,
  );
  const mac = (/** @type {string} */ launchctl) => ({ npm, uname: "echo Darwin", launchctl });
  const noLogin = runInstall(failed.script, failed.plxd, mac("exit 113"));
  assert.equal(noLogin.run.status, 0, noLogin.run.stderr);
  assert.match(noLogin.run.stdout, /^Nobody is logged in to this Mac, so plxd's login service starts at the next login\. Starting plxd now\.$/m);
  assert.doesNotMatch(noLogin.run.stdout, /didn't stop|warning/);
  assert.match(noLogin.log, /plxd attach\n/);

  // Logged in, the failure is something else: it's shown, with the warning, and attach still runs.
  const loggedIn = runInstall(failed.script, failed.plxd, mac("exit 0"));
  assert.equal(loggedIn.run.status, 0, loggedIn.run.stderr);
  assert.match(loggedIn.run.stdout, /^plxd: the old plxd \(pid 42\) didn't stop$/m);
  assert.match(loggedIn.run.stdout, /^warning: plxd's login service didn't install, so plxd won't start at login\. Starting it now\.$/m);
  assert.doesNotMatch(loggedIn.run.stdout, /next login/);
  assert.match(loggedIn.log, /plxd attach\n/);

  // And when attach fails too, so does the install.
  const noPlxd = runInstall(failed.script, failed.plxd, mac("exit 0"), { ATTACH_EXIT: "4" });
  assert.equal(noPlxd.run.status, 4);
  assert.doesNotMatch(noPlxd.log, /npm install/);
});

test("Linux leaves the sandbox to plxd and names nix-ld on NixOS", () => {
  assert.doesNotMatch(linux, /bubblewrap|socat|apt-get/);
  assert.match(linux, /^if \[ -e \/etc\/NIXOS \] && \[ -z "\$\{NIX_LD:-\}" \]/m);
  assert.match(linux, /programs\.nix-ld\.enable = true;/);
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
