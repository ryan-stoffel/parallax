# 0028: Nightly and standard releases

- Status: accepted
- Date: 2026-09-29
- Issue: RYA-203

## Context

People want every `develop` build, or only released code, and wisp published neither. [0006](0006-release-versioning-and-packaging.md) is superseded by [0020](0020-drop-the-editor-fork.md), and RYA-64 hasn't chosen versions yet.

## Decision

`release.yml` publishes two channels as GitHub releases, each with the notes GitHub generates from the PRs merged since the channel's previous release:

| Channel | Trigger | Tag | Release |
| --- | --- | --- | --- |
| Nightly | push to `develop` | `nightly-<YYYYMMDD>-<sha7>` | prerelease |
| Standard | push to `main` (a release PR or hotfix) | `release-<YYYYMMDD>-<sha7>` | normal, marked Latest |

- The tag points at the pushed commit. The date is that commit's date, so a re-run finds its own release and does nothing.
- A channel is its tag prefix and prerelease flag: nightly is `prerelease: true`, standard is `prerelease: false`. Nothing else tells them apart.
- Until an updater reads the releases, the app follows a channel by branch: nightly is `develop`, standard is `main` (RYA-204).
- A packaged-app updater (RYA-68) reads the releases instead, taking the newest release whose prerelease flag matches the channel. The channel setting and its plumbing don't change, only where the updater looks.
- RYA-64 replaces the date-sha tags with versions. The prerelease flag stays the channel contract.

## Consequences

- Every push to `develop` adds a release, and nothing prunes them yet. Pruning old nightlies is a later issue.
- If pushes queue, GitHub skips the ones between the running and the newest. Their PRs still appear in the newest release's notes.
- Each release carries the app's installers for the five targets and a `SHA256SUMS` file, built by the same workflow first ([0029](0029-app-packaging.md)). A failed build publishes nothing. There are no standalone `wispd` binaries on the releases.
- The existing `v0.1.0` and `v0.2.0` releases stay. A standard release becomes Latest after them.
