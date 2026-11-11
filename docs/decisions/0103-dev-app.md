# 0103: Parallax (Dev), a private build with its own updates and data

- Status: accepted; adds a third channel to [0028](0028-release-channels.md) and [0051](0051-promote-a-nightly.md)
- Date: 2026-11-11
- Issue: PLX-1533

## Context

Ryan wants to try breaking changes on himself before they reach Nightly. Stable and Nightly share one plxd login service and `~/.parallax`, so a plxd or database change in a build he installs reaches the Nightly he works in every day. Releases on `ryan-stoffel/parallax` are public, so a channel there is everyone's.

T3 Code's "T3 Code (Dev)" is its local development build, with its own data folder (`~/.t3/dev`), a blueprint sidebar backdrop, and a blueprint icon. It has no update channel.

## Decision

- **Builds.** The Release workflow's manual `channel=dev` builds the branch it runs on, any branch, as version `<YYMM.1DDHH.1MMSS>-dev` from the commit's time ([0030](0030-release-versions.md)). Run on `develop`, it has everything Nightly has; run on a feature branch, it carries that branch's changes before they merge.
- **Private releases.** Dev builds are published to the private repo `ryan-stoffel/parallax-dev`, which holds only release files, with the `DEV_RELEASE_TOKEN` secret, a fine-grained token that can write only that repo. Each release is a tag on that repo's `main`, marked Latest, and its notes name the public commit and branch. The tag doesn't point at the source, which that repo doesn't have.
- **Updates.** electron-updater's private GitHub provider reads the private repo's Latest release through the REST API and only its `latest*.yml`, so dev builds write `latest*.yml`. The app reads them with the token `gh auth token` prints, through the login shell, so no token ships in the app and only an account that can read the repo gets updates. A check costs two requests from the quota that gh login shares with every agent, so a window coming forward checks at most every 5 minutes, not every 10 seconds.
- **Identity.** "Parallax (Dev)", appId `dev.parallax.desktop.dev`, so it installs and runs beside Stable and Nightly. Its icon is the mark in white on blueprint paper with dimension lines (`design/icon/`), and its sidebar top and send buttons wear blueprint paper where Nightly's wear a night sky. The renderer's `.stage` class is either.
- **Its own data.** Before anything reads them, the app sets `PLXD_DATA_DIR=~/.parallax-dev` and `PLXD_SERVICE_LABEL=io.github.ryan-stoffel.parallax.plxd.dev`, and every plxd it runs inherits them. Its userData is `~/.parallax-dev/desktop` and its plxd copy `~/.parallax-dev-plxd` (0072). plxd already serves another data folder under another label, and `attach` starts only the default label's service for the default folder. A first launch starts empty and onboards.
- **Other computers.** A dev build doesn't update other computers' plxd: they serve Stable and Nightly too, and public releases have no plxd of a `-dev` version.
- **No `parallax` command.** A dev build doesn't install the `parallax` command (PLX-750): run from a terminal, its plxd wouldn't get the dev data folder.

## Consequences

- Dev never touches Nightly's plxd, database, or app data, so a breaking change can ship to Dev alone.
- Dev starts with no projects or threads, and signs in to Connect as a computer of its own.
- Installing plxd on an SSH host from Dev fails: that install downloads the app's own version from public releases.
- Connect's LAN listener (port 7341, 0065) belongs to whichever plxd binds it first; the other reports the port in use.
- An update check without gh signed in shows "Dev updates need the GitHub CLI signed in".
- On Windows arm64 a Dev update installs the x64 build: the private provider names each file by its asset id, so electron-updater's NSIS updater can't match the arch and takes the first file. Windows runs it under emulation.
- New Repository still makes repositories in `~/.parallax/projects`, which Nightly shares: they are the user's repositories, not plxd's data.
