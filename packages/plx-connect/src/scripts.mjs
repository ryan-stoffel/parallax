// @ts-check
// The install script for each OS (0056). Each installs the app, finds its plxd, turns Parallax
// Connect on, keeps plxd running, and installs plx-connect when npm is there. macOS and Linux run
// theirs with `sh -s`, Windows with PowerShell. They print plain ASCII lines, since Windows
// PowerShell's output encoding varies, and fail with a non-zero exit.

import { PLXD_PORT } from "./tailscale.mjs";
import { appName } from "./releases.mjs";

/** @typedef {import("./releases.mjs").Channel} Channel */
/** @typedef {import("./releases.mjs").Installer} Installer */
/** @typedef {import("./releases.mjs").Os} Os */

/** `value` as one word for a POSIX shell. @param {string} value */
export const shQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `value` as a PowerShell string literal. @param {string} value */
export const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

/**
 * The install script for `os`.
 * @param {Os} os
 * @param {Installer} installer
 * @param {Channel} channel
 */
export function installScript(os, installer, channel) {
  if (os === "macos") return macScript(installer, channel);
  if (os === "linux") return linuxScript(installer);
  return windowsScript(installer, channel);
}

/**
 * macOS: mounts the dmg and copies the app into /Applications, or ~/Applications when that isn't
 * writable. An app of the same name already in either is replaced only when its version differs.
 * plxd is in the app's Resources folder.
 * @param {Installer} installer
 * @param {Channel} channel
 */
export function macScript(installer, channel) {
  return `set -eu
url=${shQuote(installer.url)}
version=${shQuote(installer.version)}
bundle=${shQuote(`${appName(channel)}.app`)}
tmp=$(mktemp -d /tmp/plx-connect.XXXXXX)
trap 'hdiutil detach "$tmp/mnt" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
app=
for dir in /Applications "$HOME/Applications"; do
  if [ -d "$dir/$bundle" ]; then app="$dir/$bundle"; break; fi
done
current=
if [ -n "$app" ]; then
  current=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)
fi
if [ -n "$app" ] && [ "$current" = "$version" ]; then
  echo "$bundle $version is already in \${app%/*}"
else
  echo "Downloading $url"
  curl -fsSL --retry 3 -o "$tmp/parallax.dmg" "$url"
  mkdir "$tmp/mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$tmp/mnt" "$tmp/parallax.dmg" >/dev/null </dev/null
  if [ -z "$app" ]; then
    if [ -w /Applications ]; then app="/Applications/$bundle"; else mkdir -p "$HOME/Applications"; app="$HOME/Applications/$bundle"; fi
  fi
  rm -rf "$app"
  ditto "$tmp/mnt/$bundle" "$app"
  hdiutil detach "$tmp/mnt" -quiet
  echo "Installed $bundle $version in \${app%/*}"
fi
plxd="$app/Contents/Resources/plxd"
${posixTail}`;
}

/**
 * Linux: installs the release's static plxd in ~/.local/bin, so no AppImage runtime has to run
 * (NixOS won't run one). Then installs bubblewrap and socat, which Claude Code's worker sandbox
 * needs (0013), when it can without a password: `nix profile install` on NixOS, else the package
 * manager as root or with passwordless sudo. Otherwise, and for nix-ld on NixOS, which agent CLIs'
 * generic Linux binaries need, it says what to do. Then turns on lingering, so plxd's user service
 * runs with nobody logged in.
 * @param {Installer} installer
 */
export function linuxScript(installer) {
  return `set -eu
url=${shQuote(installer.url)}
mkdir -p "$HOME/.local/bin"
echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$HOME/.local/bin/.plxd.new" "$url"
else
  wget -q -O "$HOME/.local/bin/.plxd.new" "$url"
fi
chmod +x "$HOME/.local/bin/.plxd.new"
mv -f "$HOME/.local/bin/.plxd.new" "$HOME/.local/bin/plxd"
plxd="$HOME/.local/bin/plxd"
echo "Installed $plxd"
${linuxPackages}
if ! loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
  echo "warning: loginctl enable-linger failed, so plxd runs only while you're logged in."
fi
${posixTail}`;
}

/**
 * The part of the Linux script that sees to Claude Code's sandbox packages and, on NixOS, nix-ld.
 * `has` also looks in Nix profiles, which a non-login shell may not have on its PATH.
 */
const linuxPackages = `has() {
  command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.nix-profile/bin/$1" ] || [ -x "$HOME/.local/state/nix/profile/bin/$1" ]
}
missing() {
  m=
  has bwrap || m=bubblewrap
  has socat || m="$m socat"
  echo $m
}
nixos=
[ -e /etc/NIXOS ] && nixos=1
packages=$(missing)
if [ -n "$packages" ]; then
  echo "Installing $packages for Claude Code's worker sandbox"
  sudo=
  [ "$(id -u)" = 0 ] || sudo="sudo -n"
  {
    if [ -n "$nixos" ]; then
      # shellcheck disable=SC2046 # one package per word
      nix --extra-experimental-features 'nix-command flakes' profile install $(printf 'nixpkgs#%s ' $packages)
    elif command -v apt-get >/dev/null 2>&1; then
      $sudo apt-get install -y $packages
    elif command -v dnf >/dev/null 2>&1; then
      $sudo dnf install -y $packages
    elif command -v pacman >/dev/null 2>&1; then
      $sudo pacman -S --noconfirm --needed $packages
    elif command -v zypper >/dev/null 2>&1; then
      $sudo zypper --non-interactive install $packages
    elif command -v apk >/dev/null 2>&1; then
      $sudo apk add $packages
    fi
  } </dev/null >/dev/null 2>&1 || true
  packages=$(missing)
  if [ -z "$packages" ]; then
    echo "Installed Claude Code's sandbox packages"
  elif [ -n "$nixos" ]; then
    echo "warning: Claude Code's worker sandbox needs $packages. Add them to environment.systemPackages in configuration.nix, then run sudo nixos-rebuild switch."
  else
    echo "warning: Claude Code's worker sandbox needs $packages, which need a password to install. Install them with your package manager, such as: sudo apt install $packages"
  fi
fi
if [ -n "$nixos" ] && [ -z "\${NIX_LD:-}" ] && [ ! -e /run/current-system/sw/share/nix-ld/lib/ld.so ]; then
  echo "warning: agent CLIs such as Claude Code ship generic Linux binaries, which NixOS runs only with nix-ld. Add programs.nix-ld.enable = true; to configuration.nix, then run sudo nixos-rebuild switch."
fi`;

/**
 * What every POSIX script ends with, once `$plxd` is set: Parallax Connect on, plxd's login
 * service installed and started (`plxd service install` starts it), else plxd started without
 * it, then plx-connect from npm when npm is there.
 */
const posixTail = `echo "Turning on Parallax Connect"
"$plxd" connect on
echo "Installing plxd's login service"
if ! "$plxd" service install; then
  echo "warning: plxd's login service didn't install, so plxd won't start at login. Starting it now."
  "$plxd" attach </dev/null >/dev/null
fi
npm=$(command -v npm 2>/dev/null || true)
if [ -z "$npm" ]; then
  case \${SHELL:-} in
    */bash|*/zsh) npm=$("$SHELL" -lc 'command -v npm' </dev/null 2>/dev/null | tail -n 1 || true) ;;
  esac
fi
case $npm in /*) ;; *) npm= ;; esac
if [ -z "$npm" ]; then
  echo "npm isn't installed, so plx-connect wasn't installed here."
elif PATH="$(dirname "$npm"):$PATH" "$npm" install -g --prefix "$HOME/.local" plx-connect </dev/null >/dev/null; then
  echo "Installed plx-connect in ~/.local"
else
  echo "warning: npm couldn't install plx-connect here."
fi
`;

/**
 * Windows: runs the NSIS installer silently (a per-user install under
 * %LOCALAPPDATA%\Programs), finds the folder holding `<app name>.exe` and plxd.exe, and allows
 * plxd through Windows Firewall on TCP 7340, warning when that needs an administrator. Windows has
 * no `plxd service` yet (0023's logon task, PLX-22), so plxd is started with `attach`, which runs
 * `serve` outside the SSH session's job. It waits for `attach` alone with `WaitForExit`:
 * `Start-Process -Wait` also waits for its descendants, so the `serve` it leaves running would
 * hang it. Reading `Handle` first keeps `ExitCode`, which is otherwise lost when the process
 * exits before PowerShell opens it.
 * @param {Installer} installer
 * @param {Channel} channel
 */
export function windowsScript(installer, channel) {
  const name = appName(channel);
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$url = ${psQuote(installer.url)}
$name = ${psQuote(name)}
$installer = Join-Path $env:TEMP ${psQuote(installer.name)}
"Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
"Running the installer"
$run = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Remove-Item -Force $installer
if ($run.ExitCode -ne 0) { throw "The installer exited with $($run.ExitCode)." }
$dir = Get-ChildItem -Directory (Join-Path $env:LOCALAPPDATA 'Programs') |
  Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName "$name.exe")) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'resources\\plxd.exe')) } |
  Select-Object -First 1
if (-not $dir) { throw "Couldn't find $name.exe and plxd.exe under $env:LOCALAPPDATA\\Programs." }
$plxd = Join-Path $dir.FullName 'resources\\plxd.exe'
"Installed $name in $($dir.FullName)"
$rule = "$name plxd"
try {
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PLXD_PORT} -Program $plxd -ErrorAction Stop | Out-Null
  "Allowed plxd through Windows Firewall on TCP ${PLXD_PORT}"
} catch {
  "warning: Windows Firewall refused the rule for plxd ($($_.Exception.Message)). Allow $plxd on TCP ${PLXD_PORT} as an administrator."
}
"Turning on Parallax Connect"
& $plxd connect on
if ($LASTEXITCODE -ne 0) { throw 'plxd connect on failed.' }
"Starting plxd"
$in = New-TemporaryFile
$out = New-TemporaryFile
$attach = Start-Process -FilePath $plxd -ArgumentList 'attach' -RedirectStandardInput $in.FullName -RedirectStandardOutput $out.FullName -NoNewWindow -PassThru
$null = $attach.Handle
$attach.WaitForExit()
Remove-Item -Force $in.FullName, $out.FullName
if ($attach.ExitCode -ne 0) { throw "plxd attach exited with $($attach.ExitCode)." }
"warning: Windows has no plxd login service yet, so plxd runs until you sign out. Opening Parallax starts it again."
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  "npm isn't installed, so plx-connect wasn't installed here."
} else {
  & $npm.Source install -g plx-connect | Out-Null
  if ($LASTEXITCODE -eq 0) { 'Installed plx-connect' } else { "warning: npm couldn't install plx-connect here." }
}
`;
}

/**
 * The command a shell runs for PowerShell to read a script from stdin and run it. The script
 * goes on stdin, not the command line, which cmd.exe limits to 8191 characters; the reader is
 * `-EncodedCommand`, so no shell's quoting can change it. It prints an error as one plain line,
 * where PowerShell would print CLIXML to a redirected stderr, and exits 1.
 */
export const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    "$s = [Console]::In.ReadToEnd(); try { & ([scriptblock]::Create($s)) } catch { [Console]::Error.WriteLine('error: ' + $_.Exception.Message); exit 1 }",
    "utf16le",
  ).toString("base64"),
];
