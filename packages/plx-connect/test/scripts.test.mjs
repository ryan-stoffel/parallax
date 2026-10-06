// @ts-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { sshArgs } from "../src/run.mjs";
import { linuxScript, macScript, psQuote, shQuote, windowsScript } from "../src/scripts.mjs";

const installer = (/** @type {string} */ name) => ({
  version: "2610.10522.11930-nightly",
  name,
  url: `https://github.com/ryan-stoffel/parallax/releases/download/v2610.10522.11930-nightly/${name}`,
});
const mac = macScript(installer("parallax-2610.10522.11930-nightly-mac-arm64.dmg"), "nightly");
const linux = linuxScript(installer("parallax-2610.10522.11930-nightly-linux-x86_64.AppImage"), "nightly");
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

test("Linux unpacks plxd from the AppImage into ~/.local/bin and turns on lingering", () => {
  assert.match(linux, /^appimage="\$HOME\/Applications\/"'Parallax-Nightly\.AppImage'$/m);
  assert.match(linux, /"\$appimage" --appimage-extract resources\/plxd/);
  assert.match(linux, /mv -f "\$HOME\/\.local\/bin\/\.plxd\.new" "\$HOME\/\.local\/bin\/plxd"/);
  assert.match(linux, /loginctl enable-linger/);
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
  assert.match(windows, /Start-Process -FilePath \$plxd -ArgumentList 'attach'/);
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
