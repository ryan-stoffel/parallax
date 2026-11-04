#!/bin/sh
# Adds this computer to Parallax on macOS or Linux: runs `plx connect` with any arguments given, as
# Add a computer's command does (`curl ... | sh`). It uses Node.js 20 or newer if that's here, or
# else downloads Node.js to ~/.parallax-plxd/node and checks it against nodejs.org's SHA-256 list.
set -eu

node_is_new_enough() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

download_node() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "Parallax doesn't run on $(uname -s)." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "Parallax doesn't run on $(uname -m)." >&2; exit 1 ;;
  esac
  base=https://nodejs.org/dist/latest-v22.x
  line=$(curl -fsSL "$base/SHASUMS256.txt" | grep -E "  node-v[0-9.]+-$os-$arch\.tar\.gz$")
  expected=${line%% *}
  name=${line##* }
  echo "Downloading Node.js, which Parallax's setup runs on"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$name" "$base/$name"
  if [ "$(sha256_of "$tmp/$name")" != "$expected" ]; then
    echo "The Node.js download's SHA-256 isn't the one nodejs.org lists, so it wasn't used." >&2
    exit 1
  fi
  tar -xzf "$tmp/$name" -C "$tmp"
  mkdir -p "$(dirname "$1")"
  rm -rf "$1"
  mv "$tmp/${name%.tar.gz}" "$1"
}

if ! node_is_new_enough; then
  node_dir=$HOME/.parallax-plxd/node
  [ -x "$node_dir/bin/node" ] || download_node "$node_dir"
  PATH=$node_dir/bin:$PATH
  export PATH
fi

# npm's upgrade notice would read as something to do.
NPM_CONFIG_UPDATE_NOTIFIER=false
export NPM_CONFIG_UPDATE_NOTIFIER

# This script arrives on stdin, so plx reads the sign-in code from the terminal instead.
if (: </dev/tty) 2>/dev/null; then
  exec npx -y plx-cli@latest connect "$@" </dev/tty
fi
exec npx -y plx-cli@latest connect "$@"
