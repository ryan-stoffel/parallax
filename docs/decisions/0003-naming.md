# 0003: Parallax and `plxd`

- Status: accepted
- Date: 2026-09-23, renamed 2026-10-01 ([PLX-262](https://linear.app/ryanstoffel/issue/PLX-262))
- Issue: #17, #19, PLX-262

## Context

The plan left two naming questions open: what the product is called, and whether the host daemon, `projectd`, is shared with Roster. The daemon uses neither Roster nor the name `projectd`. The working name was replaced by the final name, Parallax, in PLX-262.

## Decision

- The product is **Parallax**: capitalized in prose and UI, `parallax` in code, paths, and package names.
- The host daemon is **`plxd`**, always lowercase. It lives in `daemon/` and is not shared with Roster (Ryan, #17).
- Identifiers: the app id is `dev.parallax.desktop`, the service label is `io.github.ryan-stoffel.parallax.plxd`, the data folder is `parallax` in each OS's data location (0023), environment variables start with `PLX_` or `PLXD_`, and the Homebrew cask is `parallax`.
- There is no client CLI. The desktop app ([0022](0022-desktop-app.md)) is Parallax.

## Consequences

- Where `docs/PLAN.md` says `projectd`, read `plxd`.
- The rename is a clean break: data under the old name is not migrated, and an installed build under the old name does not update into Parallax.
