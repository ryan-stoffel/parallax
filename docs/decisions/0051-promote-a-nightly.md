# 0051: Promote a nightly to stable

- Status: accepted
- Date: 2026-10-03
- Issue: opened with this change

## Context

[0028](0028-release-channels.md) published a nightly on every push to `develop` and a standard release, marked Latest, on every push to `main`. The two channels were two branches. A merge to `main` shipped whatever `develop` had become, including commits that landed while a nightly was being looked at. Several pull requests in one afternoon became several nightlies a few minutes apart.

The version formula in [0030](0030-release-versions.md) stays. Installed nightlies compare versions as semver, and the current tags are `v2610.…-nightly`. A `0.0.x` line would sort as older, so those installs would never be offered the new build.

## Decision

`main` is the only integration branch. Pull requests squash onto it. A push publishes nothing.

`release.yml` publishes two channels from commits on the default branch. GitHub runs the schedule from that branch only.

| Channel | When | Commit | Tag | GitHub release |
| --- | --- | --- | --- | --- |
| Nightly | Every half hour, at `:08` and `:38`, when the default branch has commits since the last nightly and that nightly was published at least six hours ago. A manual `channel=nightly` run does not wait. | The default branch's tip | `v<YYMM.1DDHH.1MMSS>-nightly`, the commit's committer time ([0030](0030-release-versions.md)) | prerelease, not Latest |
| Stable | A manual `channel=stable` run | The latest nightly's commit | `v<YYMM.1DDHH.1MMSS>`, the same timestamp, so semver sorts it above its nightly | marked Latest |

- The half hour is only a check. With no new commits, or inside the six hours, the run stops before it creates a release.
- Commits that land after a nightly stay on the branch until the next snapshot. Promoting does not take them.
- A manual stable run can name another `commit`, and a `version` of the form `YYMM.1DDHH.1MMSS`. That is how a hotfix ships before the next snapshot is promoted. Without `version`, the version is that commit's committer time. The chosen commit does not have to be contained in the default branch. The latest-nightly path does: the nightly's commit must be an ancestor of the default branch, or the same commit.
- `workflow_dispatch` with `channel=dry-run` (the default) builds, signs, and notarizes the selected branch and does not publish. A dry run of `main` versions as standard; any other branch versions as nightly.
- Nightly runs share one queue. A stable run has its own. A run that has started is not cancelled.
- Notes still start at the previous release of the same channel. Each OS still attaches its own files and publishes the draft when it finishes. macOS is still the only signed build, notarized after publishing. Nothing is committed back to the repository.
- The installed app is unchanged. A version containing `-nightly` follows nightly prereleases; any other build follows Latest ([0028](0028-release-channels.md), PLX-286).
- Under `pnpm dev`, Update follows `main`. Both channels are tags on that branch, so a dev checkout no longer switches between `develop` and `main`.

`develop` is not an integration branch and not a release branch. It stays in the repository until the default branch is `main`.

## Consequences

- The schedule does nothing until this workflow is on the default branch. Until `main` is that branch, the schedule builds whatever the default branch is.
- A push to `main` no longer publishes Latest. The first merge of this workflow onto `main` is what makes that true, because GitHub runs the workflow in the pushed commit.
- An installed nightly keeps updating. The next nightly tag is a later timestamp than `v2610.10319.13512-nightly`, so it sorts as newer. Promoting that commit to the same timestamp without `-nightly` is what a standard install sees.
- Two commits in the same second still share a version, and the second release is skipped as already published (0030).
- Nightlies are still not pruned.
