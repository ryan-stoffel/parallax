import { execFile } from "node:child_process";

import { exitError, sshCommand } from "./connection";

/** Each release `v<version>` has plxd for each macOS and Linux target, and its `.sha256` (package-app). */
const RELEASES = "https://github.com/ryan-stoffel/parallax/releases/download";

/**
 * Installs plxd `$1`, a release's version, in `~/.parallax-plxd` on a macOS or Linux host, where
 * `LOCATE_PLXD` looks first. Not in plxd's data folder: creating `~/.parallax` would move plxd off
 * an older host's data in the OS folder. Like T3 Code's remote install
 * (packages/ssh/src/tunnel.ts): downloads with curl or wget over HTTPS only, checks the SHA256
 * against the release's `<asset>.sha256`, and proves it runs before replacing anything. Then the
 * old plxd stops, which ends its agents' runs: a host with plxd's login service (a Mac with
 * Connect on, a Linux host plx-connect set up) gets `service install --replace`, which points the
 * service at this plxd and restarts it, so a Mac's LaunchAgent moves off its own app's plxd
 * until that one is newer (`repointService`); any other host's `plxd serve`, or one whose service
 * can't be moved, gets SIGTERM, so the next attach starts this one. Exits 3 with one line for
 * people when it can't. `sh -s` reads it from ssh's stdin.
 */
export const INSTALL_SCRIPT = `set -eu
version=$1
fail() { printf '%s\\n' "$1" >&2; exit 3; }
case $(uname -s) in
  Darwin) os=mac data="$HOME/Library/Application Support/parallax" ;;
  Linux) os=linux data=\${XDG_DATA_HOME:-$HOME/.local/share}/parallax ;;
  *) fail "Parallax has no plxd for $(uname -s)." ;;
esac
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Parallax has no plxd for $(uname -m)." ;;
esac
[ "$os-$arch" != mac-x64 ] || fail "Parallax has no plxd for Intel Macs."
name=parallax-plxd-$version-$os-$arch
dir=$HOME/.parallax-plxd
mkdir -p "$dir"
tmp=$(mktemp -d "$dir/.install-XXXXXX")
trap 'rm -rf "$tmp"' EXIT
# HTTPS only, redirects too: the checksum comes from the same place as plxd.
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto =https --proto-redir =https --connect-timeout 30 --max-time 600 "$1" -o "$2" || fail "Couldn't download $1."
  elif command -v wget >/dev/null 2>&1; then wget -q --https-only -T 30 "$1" -O "$2" || fail "Couldn't download $1."
  else fail "Installing plxd needs curl or wget on the host."
  fi
}
fetch "${RELEASES}/v$version/$name.sha256" "$tmp/plxd.sha256"
fetch "${RELEASES}/v$version/$name" "$tmp/plxd"
expected=$(awk -v name="$name" '$2 == name { print $1 }' "$tmp/plxd.sha256")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/plxd" | cut -d' ' -f1)
else actual=$(shasum -a 256 "$tmp/plxd" | cut -d' ' -f1)
fi
[ -n "$expected" ] && [ "$actual" = "$expected" ] || fail "plxd's SHA256 doesn't match the release's."
chmod 755 "$tmp/plxd"
# plxd reports the version in this file beside it (0030).
printf '%s\\n' "$version" > "$tmp/plxd.version"
"$tmp/plxd" --version >/dev/null 2>&1 || fail "plxd $version doesn't run on this host."
mv "$tmp/plxd.version" "$dir/plxd.version"
mv "$tmp/plxd" "$dir/plxd"
# A login service would start its own plxd again, so it's moved to this one, which restarts it.
# When it can't be, such as on a Mac nobody has logged in to since it started, serve is stopped below.
if "$dir/plxd" service status 2>/dev/null | grep -qx 'installed: true' &&
  "$dir/plxd" service install --replace >/dev/null 2>&1; then
  exit 0
fi
# plxd's data folder, as plxd picks it: ~/.parallax, unless only the OS folder exists.
[ ! -d "$HOME/.parallax" ] && [ -d "$data" ] || data=$HOME/.parallax
pid=$(cat "\${PLXD_DATA_DIR:-$data}/plxd.lock" 2>/dev/null || true)
# This user's serve only: a stale pid may be another user's process by now.
if [ -n "$pid" ] && [ "$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$(id -u)" ] &&
  ps -o args= -p "$pid" | grep -q 'plxd serve'; then
  kill "$pid" 2>/dev/null || true
  i=0
  while [ $i -lt 30 ] && kill -0 "$pid" 2>/dev/null; do sleep 1; i=$((i + 1)); done
fi
`;

/**
 * Installs this app's plxd (`version`) on the SSH host at `destination` (PLX-642), through
 * `INSTALL_SCRIPT`. `ssh` is the program (0023). Resolves to an error for people, or undefined
 * once it's installed.
 */
export function installPlxd(
  destination: string,
  version: string,
  ssh = "ssh",
  platform = process.platform,
): Promise<string | undefined> {
  // The version reaches the host's login shell as an argument.
  if (!/^[\w.-]+$/.test(version)) return Promise.resolve(`${version} isn't a release version.`);
  const [file, ...args] = sshCommand(destination, ssh, ["sh", "-s", "--", version], platform);
  return new Promise((resolve) => {
    const child = execFile(file!, args, { timeout: 15 * 60_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve(undefined);
      const code = typeof error.code === "number" ? error.code : null;
      const last = stderr.trim().split("\n").pop() ?? "";
      if (code === 3) return resolve(last);
      if (code === 255)
        return resolve(exitError(code, null, stderr, destination, platform).message);
      resolve(`Parallax couldn't install plxd on ${destination}: ${last || error.message}`);
    });
    child.stdin?.on("error", () => {}); // EPIPE when ssh exits early; the callback reports it.
    child.stdin?.end(INSTALL_SCRIPT);
  });
}
