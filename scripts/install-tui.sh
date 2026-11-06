#!/bin/sh
# Installs the Parallax terminal UI on its own, with no app (PLX-1084):
#   curl -fsSL https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts/install-tui.sh | sh
# Puts the newest nightly's plxd in ~/.parallax-plxd, where `host/update` updates it in place, and
# links ~/.local/bin/parallax to it: plxd run as `parallax` opens the TUI (PLX-740), which starts
# plxd itself. Run again, it updates. Reads and writes no shell config file (PLX-750).
# macOS (Apple silicon) and Linux (x86_64, arm64). Nightlies are prereleases, so GitHub's
# /releases/latest skips them: this takes the newest release with a plxd for this OS and arch, as
# install.sh finds the app.
set -eu

# All in one function, called on the last line, so a download cut off midway runs nothing.
main() {
  repo=ryan-stoffel/parallax

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=mac-arm64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64) target=linux-arm64 ;;
    Darwin-*) echo "Parallax needs a Mac with Apple silicon." >&2; exit 1 ;;
    *) echo "No Parallax build for $(uname -s) $(uname -m)." >&2; exit 1 ;;
  esac

  url=$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=20" |
    grep -o "https://[^\"]*/parallax-plxd-[^\"]*-nightly-$target\"" | head -n 1 | tr -d '"') || true
  if [ -z "$url" ]; then
    echo "No nightly found for $target at https://github.com/$repo/releases." >&2
    exit 1
  fi
  name=${url##*/}
  # parallax-plxd-<version>-<target>, as scripts/ci/package-app names it.
  version=${name#parallax-plxd-}
  version=${version%-"$target"}

  dir=$HOME/.parallax-plxd
  bin=$HOME/.local/bin
  link=$bin/parallax
  # A `parallax` that isn't this installer's link, such as one the app made, stays.
  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ "$(readlink "$link" 2> /dev/null || true)" != "$dir/plxd" ]; then
      echo "$link is already there and isn't this installer's. Move it, then run this again." >&2
      exit 1
    fi
  fi

  mkdir -p "$dir" "$bin"
  # Beside where it goes, so the last step is a rename on one file system.
  tmp=$(mktemp -d "$dir/.install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $name"
  curl -fL --progress-bar -o "$tmp/plxd" "$url"
  curl -fsSL -o "$tmp/plxd.sha256" "$url.sha256"

  expected=$(cut -d ' ' -f 1 < "$tmp/plxd.sha256")
  if command -v sha256sum > /dev/null 2>&1; then
    actual=$(sha256sum "$tmp/plxd" | cut -d ' ' -f 1)
  else
    actual=$(shasum -a 256 "$tmp/plxd" | cut -d ' ' -f 1)
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "The download's SHA-256 doesn't match $name.sha256. Nothing was installed." >&2
    exit 1
  fi

  # plxd reports the version in the file beside it (0030), and proves it runs before it's moved.
  chmod +x "$tmp/plxd"
  printf '%s\n' "$version" > "$tmp/plxd.version"
  if ! "$tmp/plxd" --version | grep -q "$version"; then
    echo "The downloaded plxd doesn't run here. Nothing was installed." >&2
    exit 1
  fi

  # The binary first, as self_update does: a version file that moved alone would name a version
  # the old binary isn't, and updates to it would be skipped.
  mv -f "$tmp/plxd" "$dir/plxd"
  mv -f "$tmp/plxd.version" "$dir/plxd.version"
  ln -sfn "$dir/plxd" "$link"

  echo "Installed Parallax $version in $dir"
  # A plxd already running from here keeps its version until it restarts.
  if command -v pgrep > /dev/null 2>&1 && pgrep -f "$dir/plxd serve" > /dev/null 2>&1; then
    echo "plxd is already running. It runs this version once it restarts."
  fi
  case ":$PATH:" in
    *":$bin:"*) echo "Run parallax to start." ;;
    *)
      echo "Run $link to start, or add $bin to your PATH to run parallax."
      ;;
  esac
}

main
