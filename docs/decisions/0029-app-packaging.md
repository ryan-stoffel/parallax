# 0029: App packaging and release builds

- Status: accepted; versions, macOS signing, and the update metadata superseded by [0030](0030-release-versions.md); `release.yml`'s jobs superseded by PLX-211 (below); node-llama-cpp removed by [0058](0058-thread-naming.md)
- Date: 2026-09-30
- Issue: PLX-66

## Context

The releases 0028 publishes carried only notes. The app needs `plxd` inside its package, where `findPlxd` looks (`process.resourcesPath`), and the two native modules main loads (`node-pty` and `node-llama-cpp`, external in `vite.config.ts`) have to load from the package.

## Decision

- **Tool: electron-builder**, a dev dependency of `apps/desktop/` configured in `electron-builder.yml`. It runs after `vp build` and `vp pack`, which still produce `dist/`. 0022 rejected Electron Forge for tying the build to packaging.
- **One installer per OS.** [0030](0030-release-versions.md) adds a macOS zip for the updater. More formats (deb and rpm) are config lines for later.

  | Target | Runner | Installer | `plxd` |
  | --- | --- | --- | --- |
  | macOS arm64 | `macos-26` | `dmg` | `aarch64-apple-darwin` |
  | Linux x86_64 | `ubuntu-24.04` | `AppImage` | `x86_64-unknown-linux-musl` |
  | Linux arm64 | `ubuntu-24.04-arm` | `AppImage` | `aarch64-unknown-linux-musl` |
  | Windows x86_64 | `windows-2025` | `nsis` | `x86_64-pc-windows-msvc` |
  | Windows arm64 | `windows-11-arm` | `nsis` | `aarch64-pc-windows-msvc` |

- **Each installer is built on its own runner**, with no cross-compiling. `scripts/ci/package-app` builds `plxd --release` for the runner's target, then `dist/`, then the installer, into `apps/desktop/release/`. It puts `plxd` (`plxd.exe`) in the package's resources folder, through `extraResources`, and the same script builds an installer on a developer's machine.
- **Native modules** are unpacked from `app.asar`: `node-pty` (the prebuild for the build's own OS and arch, with macOS's `spawn-helper`). `node-llama-cpp` and its `@node-llama-cpp/<platform>` package were too, until [0058](0058-thread-naming.md) removed them. Only `node-pty` is a `dependency`; everything the bundles inline is a dev dependency, so electron-builder doesn't copy it into the package too. pnpm's strict `node_modules` needed no workaround, because electron-builder reads pnpm's layout itself.
- **Version** is stamped at build time with `-c.extraMetadata.version` and never committed. [0030](0030-release-versions.md) sets it (`YYMM.1DDHH.1MMSS`, plus `-nightly` off `main`). A local build is `0.0.0-local`.
- **Builds are unsigned**, except the macOS release build, which [0030](0030-release-versions.md) signs and notarizes. Without a certificate (`CSC_KEYCHAIN` or `CSC_LINK`), `package-app` sets `CSC_IDENTITY_AUTO_DISCOVERY=false` unless it is already set, so a local build doesn't pick up a Developer ID from the keychain. An unsigned macOS arm64 app launches without ad-hoc signing. Known limitation: Windows Smart App Control, which clean Windows 11 installs start in evaluation mode and many end up with on, blocks an unsigned `plxd.exe` or installer outright, not just with a warning, and a self-signed certificate doesn't pass it. Ryan chose to leave Windows unsigned for now; the Windows installers won't run on machines with it on until PLX-65 signs them.
- **`release.yml`** is a `plan` job, a `build` matrix of the five runners, and `finish` and `notarize` jobs after them. PLX-211 made publishing per OS, to get the macOS update out in about two minutes:
  - `plan` computes the version and tag (0030, from the commit's time). `scripts/ci/draft-release` then finds out whether the release is complete (has `SHA256SUMS`). If it is, nothing else runs, so a re-run of a published commit is cheap. A release without it, from an earlier attempt, is reused. Otherwise it creates the release as a draft, with 0028's notes (from the channel's previous published release), its commit, and the prerelease flag for nightly. Only `plan` creates it, so there is never a second release for a tag; any error reading the releases, other than "not found", fails `plan` rather than risk one.
  - `build` runs `package-app` on each runner, then `scripts/ci/publish-build` uploads the installer and its update metadata straight to that release and publishes it (`gh release edit --draft=false`, plus `--latest` for standard). That's idempotent, so the first build done makes the release visible and creates its tag, and a failed build only leaves its own OS's files missing. Installers and blockmaps go first and the `.yml` last, so an updater never finds metadata before its files. A failed upload fails the job and leaves the `.yml` off; re-running the job re-uploads (`--clobber`). A build whose files are all attached already, as in a re-run of the whole workflow, uploads nothing, so a rebuilt installer never replaces one the release's metadata describes. Nothing is deleted any more: another build may be attaching to the same release. It runs no tests or lint: the PR that landed the commit already passed CI.
  - `build` caches the release `plxd` per OS and arch, keyed on everything that goes into it (the workspace's Cargo files, `rust-toolchain.toml`, `daemon/`, `crates/`, and `package-app`), so a commit that changes no Rust packages the last one and skips the Rust build. That works because `plxd` reads its version at run time (0030).
  - `finish` runs after every build, done or failed: it joins the Windows builds' metadata as attached to the release (0030), and when all five succeeded, writes `SHA256SUMS` from the digests GitHub keeps for each file, so nothing big is downloaded.
  - `notarize` notarizes the published dmg after the builds (0030).
  - `plan`, `build`, and `finish` have `contents: write`. In `build` only the publish step has the token in its environment, so electron-builder never sees it; checkout and setup-node still get it through their default `token` input.
  - Releases must stay mutable (the repository's immutable releases setting off): the builds attach to a release after it is published.
  - `workflow_dispatch` runs every job on any branch, signing and notarizing included, and never creates or publishes a release: the release steps print what they would do. Its installers stay in the run's artifacts, uploaded uncompressed since they are compressed already, and `finish` joins the Windows metadata from artifacts instead of the release.
- **The app's updater is unchanged.** It still follows a channel's branch by git (PLX-204). Reading these releases is PLX-68, against the metadata 0030 adds.

## Still open

- Windows and Linux signing (PLX-64, PLX-65). macOS signing and the versions are 0030's.
- PLX-68: an updater that reads these releases.
- PLX-28: bundling `plxd` builds for remote hosts. Releases carry no standalone `plxd`, and an installer holds only its own target's.
- The app icon is Electron's default.

## Consequences

- The macOS update is out as soon as the macOS build is, about two minutes after a push that changes no Rust and three and a half when Rust changes (PLX-211; 7.5 minutes before). The whole run still takes as long as the slowest of five native builds, and the next push's run waits for it (one run per branch keeps the notes in order). Pushes that queue behind a running build collapse to the newest, as in 0028.
- Every release adds about 0.8 GB of installers (dmg 167 MB, AppImages 169 and 179 MB, Windows 155 and 142 MB), and nothing prunes them (0028's consequence, now bigger).
- Installers aren't smoke-tested in CI. Launching a packaged build is a manual check, recorded on PLX-66: on all five runners the unpacked app launched, connected to its bundled `plxd`, spawned a shell through `node-pty`, and loaded `node-llama-cpp`, once, from a temporary step that was removed before merge.
- The `musl` Linux builds are new to CI: `check-rust` builds the glibc target, so `musl-tools` is installed on the release runners for bundled SQLite.
- 0023's line that each package also bundles `plxd` for remote hosts is PLX-28's, not this record's.
