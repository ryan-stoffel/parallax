#!/bin/sh
# Installs the newest Parallax nightly (PLX-891):
#   curl -fsSL https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts/install.sh | sh
# macOS (Apple silicon): copies the app from the dmg into /Applications, after Parallax is quit.
# Linux (x86_64, arm64): puts the AppImage in ~/.local/share/parallax-nightly, links
# ~/.local/bin/parallax-nightly to it, and adds a launcher entry. The file name has no version,
# so the app's own updater replaces it in place.
# Nightlies are prereleases, so GitHub's /releases/latest skips them: this takes the newest
# release with a nightly file for this OS and arch, which also passes over a nightly whose build
# for it failed or hasn't finished.
set -eu

# All in one function, called on the last line, so a download cut off midway runs nothing.
main() {
  repo=ryan-stoffel/parallax

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) asset=mac-arm64.dmg ;;
    Linux-x86_64) asset=linux-x86_64.AppImage ;;
    Linux-aarch64) asset=linux-arm64.AppImage ;;
    Darwin-*) echo "Parallax needs a Mac with Apple silicon." >&2; exit 1 ;;
    *) echo "No Parallax build for $(uname -s) $(uname -m)." >&2; exit 1 ;;
  esac

  url=$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=20" |
    grep -o "https://[^\"]*-nightly-$asset\"" | head -n 1 | tr -d '"') || true
  if [ -z "$url" ]; then
    echo "No nightly found for $asset at https://github.com/$repo/releases." >&2
    exit 1
  fi

  if [ "$(uname -s)" = Darwin ] &&
    [ "$(osascript -e 'application id "dev.parallax.desktop" is running' 2> /dev/null)" = true ]; then
    echo "Quit Parallax, then run this again." >&2
    exit 1
  fi

  tmp=$(mktemp -d)
  # Detaches the dmg too when a step fails after mounting it.
  trap 'hdiutil detach -quiet "$tmp/dmg" 2> /dev/null || true; rm -rf "$tmp"' EXIT
  echo "Downloading ${url##*/}"
  curl -fL --progress-bar -o "$tmp/download" "$url"

  if [ "$(uname -s)" = Darwin ]; then
    hdiutil attach -quiet -nobrowse -readonly -mountpoint "$tmp/dmg" "$tmp/download"
    set -- "$tmp"/dmg/*.app
    app=${1##*/}
    rm -rf "/Applications/$app"
    ditto "$tmp/dmg/$app" "/Applications/$app"
    echo "Installed /Applications/$app"
    open "/Applications/$app"
    return
  fi

  dir=$HOME/.local/share/parallax-nightly
  appimage=$dir/Parallax.AppImage
  mkdir -p "$dir" "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons"
  chmod +x "$tmp/download"
  mv "$tmp/download" "$appimage"
  ln -sf "$appimage" "$HOME/.local/bin/parallax-nightly"

  # The launcher entry and icons come from the AppImage itself.
  (cd "$tmp" && "$appimage" --appimage-extract '*.desktop' > /dev/null &&
    "$appimage" --appimage-extract 'usr/share/icons/*' > /dev/null)
  cp -R "$tmp/squashfs-root/usr/share/icons/." "$HOME/.local/share/icons/"
  for desktop in "$tmp"/squashfs-root/*.desktop; do
    sed "s|^Exec=AppRun|Exec=$appimage|; /^X-AppImage-/d" "$desktop" \
      > "$HOME/.local/share/applications/${desktop##*/}"
  done

  echo "Installed $appimage"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) echo "Open Parallax from your app launcher, or run parallax-nightly." ;;
    *) echo "Open Parallax from your app launcher, or run ~/.local/bin/parallax-nightly." ;;
  esac
}

main
