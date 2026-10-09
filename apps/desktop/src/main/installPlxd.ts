import { execFile } from "node:child_process";

import { exitError, sshCommand } from "./connection";

/** Each release `v<version>` has plxd for each macOS and Linux target (package-app), and SHA256SUMS. */
const RELEASES = "https://github.com/ryan-stoffel/parallax/releases/download";

/**
 * Installs plxd `$1`, a release's version, in `~/.parallax-plxd` on a macOS or Linux host, where
 * `LOCATE_PLXD` looks first, then stops the running `plxd serve` so the next attach starts this one
 * (SIGTERM, which ends its agents' runs). Not in plxd's data folder: creating `~/.parallax` would
 * move plxd off an older host's data in the OS folder. Like T3 Code's remote install
 * (packages/ssh/src/tunnel.ts): downloads with curl or wget, checks the SHA256 against the
 * release's SHA256SUMS, and proves it runs before replacing anything. Exits 3 with one line for
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
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time 600 "$1" -o "$2" || fail "Couldn't download $1."
  elif command -v wget >/dev/null 2>&1; then wget -q -T 30 "$1" -O "$2" || fail "Couldn't download $1."
  else fail "Installing plxd needs curl or wget on the host."
  fi
}
fetch "${RELEASES}/v$version/SHA256SUMS" "$tmp/SHA256SUMS"
fetch "${RELEASES}/v$version/$name" "$tmp/plxd"
expected=$(awk -v name="$name" '$2 == name { print $1 }' "$tmp/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/plxd" | cut -d' ' -f1)
else actual=$(shasum -a 256 "$tmp/plxd" | cut -d' ' -f1)
fi
[ -n "$expected" ] && [ "$actual" = "$expected" ] || fail "plxd's SHA256 doesn't match the release's SHA256SUMS."
chmod 755 "$tmp/plxd"
# plxd reports the version in this file beside it (0030).
printf '%s\\n' "$version" > "$tmp/plxd.version"
"$tmp/plxd" --version >/dev/null 2>&1 || fail "plxd $version doesn't run on this host."
mv "$tmp/plxd.version" "$dir/plxd.version"
mv "$tmp/plxd" "$dir/plxd"
# plxd's data folder, as plxd picks it: ~/.parallax, unless only the OS folder exists.
[ ! -d "$HOME/.parallax" ] && [ -d "$data" ] || data=$HOME/.parallax
pid=$(cat "\${PLXD_DATA_DIR:-$data}/plxd.lock" 2>/dev/null || true)
if [ -n "$pid" ] && ps -o args= -p "$pid" 2>/dev/null | grep -q 'plxd serve'; then
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
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
