// @ts-check
// The install script for each OS (0056). Each installs the app, or plxd alone (`--headless`, and
// always on Linux), checking every download against the release's SHA-256. Every one puts plxd at
// ~/.parallax-plxd/plxd (plxd.exe on Windows) with plxd.version, as host/update and the app's SSH
// install do (0072), turns Parallax Connect on, installs plxd's login service from there, and
// installs plx-connect when npm is there. macOS and Linux run theirs with `sh -s`, Windows with
// PowerShell. They print plain ASCII lines, since Windows PowerShell's output encoding varies, and
// fail with a non-zero exit.

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
 * The install script for `os`: the app and plxd, or with `headless`, plxd alone. Linux always
 * gets plxd alone.
 * @param {Os} os
 * @param {Installer} installer
 * @param {Channel} channel
 * @param {boolean} [headless]
 */
export function installScript(os, installer, channel, headless = false) {
  if (os === "macos") return macScript(installer, channel, headless);
  if (os === "linux") return linuxScript(installer);
  return windowsScript(installer, channel, headless);
}

/**
 * What every POSIX script starts with: the asset, its SHA-256, and its version; plxd's place,
 * `$plxd` in `$dir`; and `download`, which saves the asset to `$1` and checks it, removing it and
 * stopping the script when its SHA-256 isn't the release's.
 * @param {Installer} installer
 */
const posixHead = (installer) => `set -eu
url=${shQuote(installer.url)}
sha256=${shQuote(installer.sha256)}
version=${shQuote(installer.version)}
dir="$HOME/.parallax-plxd"
plxd="$dir/plxd"
mkdir -p "$dir"
download() {
  echo "Downloading $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$1" "$url"
  else
    wget -q -O "$1" "$url"
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$1" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$1" | cut -d' ' -f1)
  fi
  if [ "$actual" != "$sha256" ]; then
    rm -f "$1"
    echo "error: the download's SHA-256 is $actual, not $sha256 as the release says, so it wasn't installed." >&2
    exit 1
  fi
  echo "Checked its SHA-256"
}`;

/**
 * Puts `$dir/.plxd.new` in place as `$plxd`, with its version in `plxd.version` beside it, where
 * plxd reads it (0030); without it, plxd reports its build's placeholder, 0.1.0. A new file, not
 * the old one overwritten, so a running plxd keeps its own.
 */
const posixPlace = `chmod 755 "$dir/.plxd.new"
printf '%s\\n' "$version" > "$dir/plxd.version"
mv -f "$dir/.plxd.new" "$plxd"
echo "Installed plxd $version in $dir"`;

/**
 * macOS: mounts the dmg and copies the app into /Applications, or ~/Applications when that isn't
 * writable, then copies its plxd, from its Resources folder, to `~/.parallax-plxd`. An app of the
 * same name already in either is replaced only when its version differs. With `headless`, it
 * downloads plxd alone, the signed copy from the app (package-app).
 * @param {Installer} installer
 * @param {Channel} channel
 * @param {boolean} [headless]
 */
export function macScript(installer, channel, headless = false) {
  if (headless) return `${posixHead(installer)}\ndownload "$dir/.plxd.new"\n${posixPlace}\n${posixTail}`;
  return `${posixHead(installer)}
bundle=${shQuote(`${appName(channel)}.app`)}
tmp=$(mktemp -d /tmp/plx-connect.XXXXXX)
trap 'hdiutil detach "$tmp/mnt" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
app=
for each in /Applications "$HOME/Applications"; do
  if [ -d "$each/$bundle" ]; then app="$each/$bundle"; break; fi
done
current=
if [ -n "$app" ]; then
  current=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)
fi
if [ -n "$app" ] && [ "$current" = "$version" ]; then
  echo "$bundle $version is already in \${app%/*}"
else
  download "$tmp/parallax.dmg"
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
cp "$app/Contents/Resources/plxd" "$dir/.plxd.new"
${posixPlace}
${posixTail}`;
}

/**
 * Linux: downloads the release's static plxd, so no AppImage runtime has to run (NixOS won't run
 * one), and links `~/.local/bin/plxd` to it, where earlier installs put plxd, so `plxd` stays on
 * PATH and their service runs this one until `service install --replace` moves it over. Then
 * installs bubblewrap and socat, which Claude Code's worker sandbox needs (0013), when it can
 * without a password: `nix profile install` on NixOS (unless the user's profile is nix-env's),
 * else the package manager as root or with passwordless sudo. Otherwise, and for nix-ld on NixOS,
 * which agent CLIs' generic Linux binaries need, it says what to do. Then turns on lingering, so
 * plxd's user service runs with nobody logged in.
 * @param {Installer} installer
 */
export function linuxScript(installer) {
  return `${posixHead(installer)}
download "$dir/.plxd.new"
${posixPlace}
mkdir -p "$HOME/.local/bin"
rm -f "$HOME/.local/bin/plxd.version"
ln -sf "$plxd" "$HOME/.local/bin/plxd"
echo "Linked ~/.local/bin/plxd to it"
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
    # nix profile would turn a nix-env profile into one nix-env refuses, so that one is left alone.
    if [ -n "$nixos" ] && [ ! -e "$HOME/.nix-profile/manifest.nix" ] && [ ! -e "$HOME/.local/state/nix/profile/manifest.nix" ]; then
      # shellcheck disable=SC2046 # one package per word
      nix --extra-experimental-features 'nix-command flakes' profile install $(printf 'nixpkgs#%s ' $packages)
    elif [ -n "$nixos" ]; then
      :
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
    echo "warning: Claude Code's worker sandbox needs $packages. Add to environment.systemPackages in configuration.nix, then run sudo nixos-rebuild switch."
  else
    echo "warning: Claude Code's worker sandbox needs $packages, which plx-connect couldn't install without a password. Install with your package manager, such as: sudo apt install $packages"
  fi
fi
if [ -n "$nixos" ] && [ -z "\${NIX_LD:-}" ] && [ ! -e /run/current-system/sw/share/nix-ld/lib/ld.so ]; then
  echo "warning: agent CLIs such as Claude Code ship generic Linux binaries, which NixOS runs only with nix-ld. Add programs.nix-ld.enable = true; to configuration.nix, then run sudo nixos-rebuild switch."
fi`;

/**
 * What every POSIX script ends with, once `$plxd` is in place: Parallax Connect on, then plxd's
 * login service installed from `$plxd` and started, replacing any service or `serve` running
 * another plxd. On a Mac nobody is logged in to, there's no GUI session for launchd to start the
 * LaunchAgent in, but its file is written, so it starts at the next login. Any other failure is
 * printed with a warning. Without the service running, plxd starts now with `attach`, and the
 * install fails when that does too. Then plx-connect from npm when npm is there.
 */
const posixTail = `echo "Turning on Parallax Connect"
"$plxd" connect on
echo "Installing plxd's login service"
if ! out=$("$plxd" service install --replace </dev/null 2>&1); then
  if [ "$(uname -s)" = Darwin ] && ! launchctl print "gui/$(id -u)" >/dev/null 2>&1 &&
    "$plxd" service status </dev/null 2>/dev/null | grep -qx 'installed: true'; then
    echo "Nobody is logged in to this Mac, so plxd's login service starts at the next login. Starting plxd now."
  else
    printf '%s\\n' "$out"
    echo "warning: plxd's login service didn't install, so plxd won't start at login. Starting it now."
  fi
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
 * Windows: runs the NSIS installer silently (a per-user install under %LOCALAPPDATA%\Programs) and
 * copies plxd.exe from the folder holding `<app name>.exe`, or with `headless`, downloads plxd.exe
 * alone, to %USERPROFILE%\.parallax-plxd. A running plxd.exe can't be overwritten, but it can be
 * renamed, so the old one moves aside to plxd.exe.old. Then it allows that plxd through Windows
 * Firewall on TCP 7340, warning when that needs an administrator, and installs plxd's logon task
 * (0023) with `service install --replace`. A plxd from before PLX-576 has no `service`, so then
 * plxd is started with `attach`, which runs `serve` outside the SSH session's job. It waits for
 * `attach` alone with `WaitForExit`: `Start-Process -Wait` also waits for its descendants, so the
 * `serve` it leaves running would hang it. Reading `Handle` first keeps `ExitCode`, which is
 * otherwise lost when the process exits before PowerShell opens it. Windows PowerShell can turn a
 * native command's stderr into errors, which `Stop` would throw, so `service install` runs under
 * `Continue`.
 * @param {Installer} installer
 * @param {Channel} channel
 * @param {boolean} [headless]
 */
export function windowsScript(installer, channel, headless = false) {
  const name = appName(channel);
  const get = headless
    ? `Save-Checked "$plxd.new"`
    : `$installer = Join-Path $env:TEMP ${psQuote(installer.name)}
Save-Checked $installer
"Running the installer"
$run = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
Remove-Item -Force $installer
if ($run.ExitCode -ne 0) { throw "The installer exited with $($run.ExitCode)." }
$app = Get-ChildItem -Directory (Join-Path $env:LOCALAPPDATA 'Programs') |
  Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName "$name.exe")) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'resources\\plxd.exe')) } |
  Select-Object -First 1
if (-not $app) { throw "Couldn't find $name.exe and plxd.exe under $env:LOCALAPPDATA\\Programs." }
"Installed $name in $($app.FullName)"
Copy-Item -Force -LiteralPath (Join-Path $app.FullName 'resources\\plxd.exe') -Destination "$plxd.new"`;
  const again = headless ? "" : " Opening Parallax starts it again.";
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$url = ${psQuote(installer.url)}
$sha256 = ${psQuote(installer.sha256)}
$version = ${psQuote(installer.version)}
$name = ${psQuote(name)}
$dir = Join-Path $env:USERPROFILE '.parallax-plxd'
$plxd = Join-Path $dir 'plxd.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
function Save-Checked($file) {
  "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower()
  if ($actual -ne $sha256) {
    Remove-Item -Force -LiteralPath $file
    throw "The download's SHA-256 is $actual, not $sha256 as the release says, so it wasn't installed."
  }
  'Checked its SHA-256'
}
${get}
if (Test-Path -LiteralPath $plxd) {
  Remove-Item -Force -LiteralPath "$plxd.old" -ErrorAction SilentlyContinue
  Move-Item -Force -LiteralPath $plxd -Destination "$plxd.old"
}
Move-Item -LiteralPath "$plxd.new" -Destination $plxd
[IO.File]::WriteAllText((Join-Path $dir 'plxd.version'), "$version\`n")
"Installed plxd $version in $dir"
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
"Installing plxd's logon task"
$ErrorActionPreference = 'Continue'
& $plxd service install --replace *> $null
$service = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($service -ne 0) {
  "Starting plxd"
  $in = New-TemporaryFile
  $out = New-TemporaryFile
  $attach = Start-Process -FilePath $plxd -ArgumentList 'attach' -RedirectStandardInput $in.FullName -RedirectStandardOutput $out.FullName -NoNewWindow -PassThru
  $null = $attach.Handle
  $attach.WaitForExit()
  Remove-Item -Force $in.FullName, $out.FullName
  if ($attach.ExitCode -ne 0) { throw "plxd attach exited with $($attach.ExitCode)." }
  "warning: Windows has no plxd login service yet, so plxd runs until you sign out.${again}"
}
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
