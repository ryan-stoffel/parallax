# 0028: Nightly and standard releases

- Status: accepted; tags superseded by [0030](0030-release-versions.md); all-or-nothing publishing superseded by RYA-211 (below)
- Date: 2026-09-29
- Issue: RYA-203

## Context

People want every `develop` build, or only released code, and Parallax published neither. [0006](0006-release-versioning-and-packaging.md) is superseded by [0020](0020-drop-the-editor-fork.md), and RYA-64 hasn't chosen versions yet.

## Decision

`release.yml` publishes two channels as GitHub releases, each with the notes GitHub generates from the PRs merged since the channel's previous release:

| Channel | Trigger | Tag | Release |
| --- | --- | --- | --- |
| Nightly | push to `develop` | `v<YYMM.1DDHH.1MMSS>-nightly` ([0030](0030-release-versions.md)) | prerelease |
| Standard | push to `main` (a release PR or hotfix) | `v<YYMM.1DDHH.1MMSS>` ([0030](0030-release-versions.md)) | normal, marked Latest |

- The tag points at the pushed commit. The version is that commit's committer time, so a re-run finds its own release and does nothing. Until 0030 the tags were `nightly-<YYYYMMDD>-<sha7>` and `release-<YYYYMMDD>-<sha7>`; those releases stay.
- A channel is its tag prefix and prerelease flag: nightly is `prerelease: true`, standard is `prerelease: false`. Nothing else tells them apart.
- Until an updater reads the releases, the app follows a channel by branch: nightly is `develop`, standard is `main` (RYA-204).
- A packaged-app updater (RYA-68) reads the releases instead: `electron-updater` takes the release marked Latest for standard, and the newest `nightly` prerelease for nightly (0030). The channel setting and its plumbing don't change, only where the updater looks.
- 0030 replaced the date-sha tags with semver versions. The prerelease flag stays the channel contract.

## Consequences

- Every push to `develop` adds a release, and nothing prunes them yet. Pruning old nightlies is a later issue.
- If pushes queue, GitHub skips the ones between the running and the newest. Their PRs still appear in the newest release's notes.
- Each release carries the app's installers for the five targets, the update metadata the updater reads ([0030](0030-release-versions.md)), and a `SHA256SUMS` file, built by the same workflow ([0029](0029-app-packaging.md)). There are no standalone `plxd` binaries on the releases.
- **Publishing is per OS (RYA-211).** `plan` creates the release as a draft, with its notes. Each build attaches its own files as soon as it is done and then publishes the draft, so the first one done makes the release visible and macOS no longer waits for Windows. A failed build leaves its OS out of the release, which still goes out for the others, until its job is re-run. Until then, and while a slower build is still running, apps on that OS find the newest release without their update file and report that it has no update for them; they update once it arrives. `SHA256SUMS` is added last, once every build has attached, so a release without it is incomplete.
- The existing `v0.1.0` and `v0.2.0` releases stay. A standard release becomes Latest after them.
