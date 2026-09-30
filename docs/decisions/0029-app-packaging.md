# 0029: App packaging and release builds

- Status: accepted
- Date: 2026-09-30
- Issue: RYA-66

## Context

The releases 0028 publishes carried only notes. The app needs `wispd` inside its package, where `findWispd` looks (`process.resourcesPath`), and the two native modules main loads (`node-pty` and `node-llama-cpp`, external in `vite.config.ts`) have to load from the package.

## Decision

- **Tool: electron-builder**, a dev dependency of `apps/desktop/` configured in `electron-builder.yml`. It runs after `vp build` and `vp pack`, which still produce `dist/`. 0022 rejected Electron Forge for tying the build to packaging.
- **One installer per OS.** More formats (a zip for auto-update, deb and rpm) are config lines for later.

  | Target | Runner | Installer | `wispd` |
  | --- | --- | --- | --- |
  | macOS arm64 | `macos-26` | `dmg` | `aarch64-apple-darwin` |
  | Linux x86_64 | `ubuntu-24.04` | `AppImage` | `x86_64-unknown-linux-musl` |
  | Linux arm64 | `ubuntu-24.04-arm` | `AppImage` | `aarch64-unknown-linux-musl` |
  | Windows x86_64 | `windows-2025` | `nsis` | `x86_64-pc-windows-msvc` |
  | Windows arm64 | `windows-11-arm` | `nsis` | `aarch64-pc-windows-msvc` |

- **Each installer is built on its own runner**, with no cross-compiling. `scripts/ci/package-app` builds `wispd --release` for the runner's target, then `dist/`, then the installer, into `apps/desktop/release/`. It puts `wispd` (`wispd.exe`) in the package's resources folder, through `extraResources`, and the same script builds an installer on a developer's machine.
- **Native modules** are unpacked from `app.asar`: `node-pty` (its prebuilds and macOS `spawn-helper`), `node-llama-cpp`, and the `@node-llama-cpp/<platform>` package holding its llama.cpp binary. Only `node-pty` and `node-llama-cpp` are `dependencies`; everything the bundles inline is a dev dependency, so electron-builder doesn't copy it into the package too. pnpm's strict `node_modules` needed no workaround, because electron-builder reads pnpm's layout itself.
- **Version** is stamped at build time with `-c.extraMetadata.version` and never committed: `0.0.0-nightly.<YYYYMMDD>.g<sha7>` on `develop` and `0.0.0-release.<YYYYMMDD>.g<sha7>` on `main`, the tag's date and sha as a semver prerelease. The `g` keeps a sha made of digits from becoming a numeric identifier, which semver forbids with a leading zero. A local build is `0.0.0-local`.
- **Builds are unsigned.** No signing or notarization code exists; `package-app` sets `CSC_IDENTITY_AUTO_DISCOVERY=false` unless it is already set, so a local build doesn't pick up a Developer ID from the keychain. electron-builder's own `CSC_*` behavior is otherwise untouched, for RYA-65. An unsigned macOS arm64 app launches without ad-hoc signing. Known limitation: Windows Smart App Control, which clean Windows 11 installs start in evaluation mode and many end up with on, blocks an unsigned `wispd.exe` or installer outright, not just with a warning, and a self-signed certificate doesn't pass it. Ryan chose to leave Windows unsigned for now; the Windows installers won't run on machines with it on until RYA-65 signs them.
- **`release.yml`** is a `plan` job, a `build` matrix of the five runners, and a `publish` job:
  - `plan` computes 0028's tag (from the commit's date and sha) and the version, and finds out whether the release exists. If it does, nothing else runs, so a re-run of a published commit is cheap.
  - `build` runs `package-app` on each runner and uploads the installer as a workflow artifact. It runs no tests or lint: the PR that landed the commit already passed CI.
  - `publish` needs every build, so a failed build publishes nothing. It creates the release with 0028's tag, notes, and prerelease or Latest flag, attaching the five installers and a `SHA256SUMS` file in one `gh release create`. Only this job has `contents: write`.
  - `workflow_dispatch` runs `plan` and `build` on any branch and never publishes, to prove the pipeline before merge. Its installers stay in the run's artifacts.
- **The app's updater is unchanged.** It still follows a channel's branch by git (RYA-204). Reading these releases is RYA-68.

## Still open

- RYA-64: signing, and the real versions and their policy.
- RYA-65: the certificates and secrets that signing and notarization need.
- RYA-68: an updater that reads these releases, which will likely want a zip on macOS and the `.blockmap` files.
- RYA-28: bundling `wispd` builds for remote hosts. Releases carry no standalone `wispd`, and an installer holds only its own target's.
- The app icon is Electron's default.

## Consequences

- A push to `develop` or `main` takes as long as the slowest of five native builds (a cold Windows arm64 Rust build is the long pole), where 0028's release took seconds. Pushes that queue behind a running build collapse to the newest, as in 0028.
- Every release adds about 0.8 GB of installers (dmg 167 MB, AppImages 169 and 179 MB, Windows 155 and 142 MB), and nothing prunes them (0028's consequence, now bigger).
- The packages leave out node-llama-cpp's CUDA and Vulkan binaries (Linux and Windows x64), which would add 200 to 300 MB each and need the vendor's GPU runtime. It runs on the CPU there; the only user today is the thread namer's small model.
- Installers aren't smoke-tested in CI. Launching a packaged build is a manual check, recorded on RYA-66: on all five runners the unpacked app launched, connected to its bundled `wispd`, spawned a shell through `node-pty`, and loaded `node-llama-cpp`, once, from a temporary step that was removed before merge.
- The `musl` Linux builds are new to CI: `check-rust` builds the glibc target, so `musl-tools` is installed on the release runners for bundled SQLite.
- 0023's line that each package also bundles `wispd` for remote hosts is RYA-28's, not this record's.
