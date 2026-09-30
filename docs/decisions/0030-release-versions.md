# 0030: Release versions, update metadata, and macOS signing

- Status: accepted; supersedes in part [0028](0028-release-channels.md) (tags) and [0029](0029-app-packaging.md) (versions, unsigned macOS builds, one installer per OS). RYA-211 moved `wispd`'s version out of the binary and notarization after publishing (below).
- Date: 2026-09-30
- Issue: RYA-206 (absorbs RYA-205)

## Context

The app should install new releases itself (RYA-68) through `electron-updater`. That needs three things 0028 and 0029 didn't have:

- Semver tags. The updater compares versions as semver and reads a release's channel from its first prerelease identifier. `nightly-20260930-49ef244` isn't semver.
- Update metadata: `latest*.yml` or `<channel>*.yml` on each release, a macOS zip, blockmaps, and `app-update.yml` inside the app. `electron-builder.yml` had `publish: null`, so none of it was built.
- A signed macOS app. Squirrel.Mac, which `electron-updater` uses on macOS, only installs an update signed like the running app.

## Decision

### Versions and tags

- **The version is the commit's committer time in UTC, `YYMM.1DDHH.1MMSS`**. A commit at 2026-09-30 17:45:12 UTC is `2609.13017.14512`. `release.yml`'s `plan` job reads the time from the API and stamps it with `-c.extraMetadata.version`, as 0029 did. Nothing is committed and nobody bumps it.
- **Standard (`main`) has no prerelease: `2609.13017.14512`. Nightly (any other ref) is `2609.13017.14512-nightly`.** The tag is `v<version>` in both.
- Why this shape:
  - A re-run of a commit gets the same version, since the committer time is fixed.
  - Versions rise with commit time, to the second, across both channels. Minutes weren't enough: several PRs often merge within one minute.
  - The standard release of a commit is newer than its nightly, because semver sorts a prerelease below its release.
  - Windows version resources take four numbers of at most 65535. The parts here are at most 9912, 13123, and 15959. A plain `HHMMSS` patch, or a date as one number, doesn't fit.
  - **Every tag has the same length.** GitHub orders releases by their commit's day, then by tag name as text, so `9` sorts above `10`. Its releases feed and `/releases/latest` follow that order, and the updater takes the first nightly it finds in the feed. The leading `1`s keep `DDHH` and `MMSS` at five digits where semver forbids leading zeros. So the text order is the time order, whatever time zone GitHub uses for the day. A simulation of that ordering over random commit times confirms it. Without them, a nightly at 17:05:03 (`2609.3017.503`) would sort above one at 17:45:12 (`2609.3017.4512`), and the updater would offer the older build.
  - It still reads as a date: `2609.13017.14512` is 2026-09, day 30 at 17h, 45m 12s, after each leading `1`.
- It breaks in 2100, when `YY` wraps.
- Two commits in the same second get the same version. The second one's release is then skipped as already published.
- A local build is `0.0.0-local` (0029).

### `wispd`'s version (RYA-211)

- `wispd --version`, the protocol's `initialize` and `host/version`, and the `LaunchAgent`'s probe report the app's version, as before, but `wispd` reads it at run time. `package-app` writes it to `wispd.version`, one line beside the bundled `wispd` (`Wisp.app/Contents/Resources/` on macOS, `resources/` on Windows and Linux), and `wispd::version()` reads that file beside its own executable (`current_exe`, symlinks resolved). Without the file, as in a cargo build, it reports `Cargo.toml`'s placeholder.
- Before, `WISP_VERSION` was compiled in (`option_env!`), so every release rebuilt `wispd` even when no Rust changed. Now one `wispd` build is packaged into any app version, and `release.yml` caches it (0029).
- `main` reads the version first thing, and it's kept for the life of the process. So a `serve` that outlives an app update still reports the version it started as, and the app's check after an update (RYA-68: the running serve's version against `<bundled wispd> --version`) still sees them differ and replaces it, as it did when the version was compiled in.
- On macOS the file is in the bundle before electron-builder signs it, so it is a sealed resource and `codesign --verify --strict` covers it.

### Channels

- 0028's contract stays: nightly is a GitHub prerelease, and standard is marked Latest. `electron-updater` names the standard channel `latest`, and the version's prerelease identifier names the other: `nightly`.
- **Standard:** the updater reads `/releases/latest`, which is the release marked Latest, then that release's `latest*.yml`.
- **Nightly:** with `allowPrerelease`, the updater reads the releases' Atom feed (the newest ten). It takes the first entry whose tag is valid semver with the prerelease identifier `nightly`, then that release's `nightly*.yml`.
- Notes still start at the channel's previous release. That's the newest release whose tag matches `v<x.y.z>-nightly` (nightly) or `v<x.y.z>` (standard), or 0028's `nightly-*` and `release-*` tags. So the first new nightly's notes start at the last `nightly-*` release, and the first standard release's at `v0.2.0`.

### The interim `nightly-*` releases stay

`electron-updater` 6.8.9's `GitHubProvider` skips any feed entry whose tag isn't valid semver. It also skips standard releases, `v0.1.0` and `v0.2.0` included, when looking for a nightly. So they never confuse it. A simulation against a feed of today's releases confirms this. Until the first `v…-nightly` release exists, a nightly app gets `ERR_UPDATER_NO_PUBLISHED_VERSIONS`. Until the first `v…` standard release replaces `v0.2.0` as Latest, a standard app gets `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`. The app treats both as "no update" (RYA-68). Pruning old releases is still 0028's later issue.

### Update metadata

- `electron-builder.yml` has `publish: { provider: github, owner: ryan-stoffel, repo: wisp, channel: ${channel} }`:
  - The app ships it as `app-update.yml` in its resources folder, `Wisp.app/Contents/Resources/app-update.yml` on macOS.
  - `${channel}` is the version's first prerelease identifier, or `latest`. For the github provider, electron-builder doesn't infer the channel from the version by itself, so without it a nightly would write `latest*.yml`.
  - `package-app` still passes `--publish never`, and `release.yml` attaches the files.
- **The crash that led to `publish: null`:** 0029 had no `publish` config and had `GH_TOKEN` set. So electron-builder picked a GitHub config itself and looked for the repo in `apps/desktop/.git/config`, which doesn't exist. The config came out `null`, and naming the channel file crashed (`reading 'channel'`). An explicit owner and repo never take that path. The build jobs also no longer get a token (0029).
- Per build, electron-builder writes:

  | Target | Metadata (standard / nightly) | Updater reads |
  | --- | --- | --- |
  | macOS arm64 | `latest-mac.yml` / `nightly-mac.yml` | `wisp-<version>-mac-arm64.zip` and its `.blockmap` |
  | Windows x64 and arm64 | `latest.yml` / `nightly.yml` | `wisp-<version>-win-<arch>.exe` and its `.blockmap` |
  | Linux x86_64 | `latest-linux.yml` / `nightly-linux.yml` | the AppImage (its blockmap is inside it) |
  | Linux arm64 | `latest-linux-arm64.yml` / `nightly-linux-arm64.yml` | the AppImage |

- **macOS builds a zip as well as the dmg.** The zip is what the updater installs. The dmg is for first installs and stays out of the metadata (`dmg.writeUpdateInfo: false`).
- **Windows:** both Windows runners write the same `<channel>.yml`. Neither attaches it: each uploads it as a small workflow artifact, and `release.yml`'s `finish` job, after all builds, joins their `files` lists into one and attaches that, since `NsisUpdater` picks the file whose name contains its arch. It does so only when both builds made one: `NsisUpdater` falls back to the first file, so a list with only x64 would give arm64 machines the x64 installer. Every other file name is unique to its build.
- Each release attaches every installer, the zip, the blockmaps, and the channel's four `.yml` files. `SHA256SUMS` covers all of them and is written last, from GitHub's own digest of each file, once every build succeeded.

### macOS signing and notarization

- **Only the macOS build signs, on every run of `release.yml`:** pushes to `develop` and `main`, and `workflow_dispatch`, which proves it on a branch but never publishes.
  - The secrets from RYA-65 go only to two steps: `CSC_LINK` (a base64 `.p12`) and `CSC_KEY_PASSWORD` to the macOS build's package step, and `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` to the `notarize` job's notarize step.
  - The `.p8` key is written to a file in `$RUNNER_TEMP` with mode 600 and removed after use.
- The workflow imports the certificate into a keychain of its own, in `$RUNNER_TEMP`, and names it in `CSC_KEYCHAIN`. electron-builder 26.15.3 can import `CSC_LINK` itself, but it then unlocks that keychain with the certificate's password instead of the keychain's, so the build fails.
- electron-builder signs with the Developer ID Application certificate from that keychain. It signs every binary in the bundle with the hardened runtime and a secure timestamp. That covers `Contents/Resources/wispd`, node-pty's `pty.node` and `spawn-helper`, and node-llama-cpp's addon and dylibs, since `@electron/osx-sign` walks all of `Contents/`. It then builds the dmg and zip, and signs the dmg. It doesn't notarize: the build has no `APPLE_API_*` variables.
- **Entitlements** (`apps/desktop/entitlements.mac.plist`, for the app and everything in it) are `com.apple.security.cs.allow-jit` only, for V8. Everything the app loads is signed with its own Team ID, so library validation passes without `disable-library-validation`. Spawning processes (node-pty's shell, `wispd`, and the agents `wispd` starts) needs no entitlement.
- The build runs `codesign --verify --deep --strict` on the app and publishes (0029).
- **Notarization comes after publishing (RYA-211).** It took about 3.5 of the build's 6.7 minutes, and updates don't need it: Squirrel.Mac checks the code signature, and an installed update carries no quarantine flag, so Gatekeeper doesn't assess it. Notarizing a disk image gets tickets for the image and everything in it, the app included. So `release.yml`'s `notarize` job, after the builds, takes the published dmg (the run's artifact on `workflow_dispatch`) and:
  1. notarizes it with `notarytool` and prints Apple's log if it isn't accepted
  2. runs `spctl --assess` on the dmg, then `codesign --verify --deep --strict` and `spctl --assess --type execute` on the app inside it

  A failure fails the job, which alerts, and leaves the release published. Until the ticket exists, a dmg downloaded by hand may get a Gatekeeper prompt on first open.
- **Nothing is stapled.** Stapling changes the dmg's bytes, so it would mean replacing the published file, which leaves the release briefly without a dmg, and `SHA256SUMS`. Without a staple, Gatekeeper looks the ticket up online on first open.
- **`package-app` signs only when `CSC_KEYCHAIN` or `CSC_LINK` is set.** Otherwise it still sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so a local build never signs with an identity in the login keychain. It leaves auto-discovery on when a certificate is given, because without it electron-builder finds no identity and silently skips signing. electron-builder notarizes only when the `APPLE_API_*` variables are set, which `release.yml` no longer does.
- Windows and Linux stay unsigned (RYA-65; 0029's Smart App Control limitation stands).

## Consequences

- Apple's notarization service runs once per release, on the dmg, after it is published. An outage there fails the `notarize` job but not the release or updates; fresh downloads prompt until it is re-run.
- Squirrel.Mac requires each update to be signed like the running app. Changing the signing certificate's Team ID would strand installed apps on the old one.
- `app.getVersion()` and `wispd`'s reported version are these date versions. Nothing in the code parses them.
- A release carries 13 files plus `SHA256SUMS` (0029's five installers, the zip, three blockmaps, four `.yml`). Each release is about 175 MB bigger for the zip.
- Unsigned Windows builds still update: their `app-update.yml` names no `publisherName`, so `electron-updater` skips its signature check.
