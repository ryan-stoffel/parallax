# 0020: Drop the editor fork

- Status: accepted
- Date: 2026-09-27

## Context

The Code - OSS fork took most of the project's effort (patches, upgrades, a 90-minute app build, Playwright suites, packaging) while the product logic lives in `wispd`. The backlog had grown past what could be kept in order.

## Decision

- wisp has no UI for now. The repo is `wispd` and its crates only.
- Removed: `editor/`, `scripts/editor/`, the Playwright suites (`ci/smoke`, `ci/e2e`, `ci/screenshots`), `screenshots.yml`, `release.yml` and the Homebrew cask scripts, and the protocol's TypeScript generator.
- The wire protocol (0007) stays as `wispd`'s client interface. The ts-rs derives stay because the sample-coverage tests use them to list enum variants.
- `ci.yml` runs `check-rust` and the ssh attach check (#95) against the debug `wispd`.

This supersedes 0002, 0006, 0008, 0011, and 0018, and the editor parts of 0001, 0007, 0015, and `docs/PLAN.md`. A future frontend gets its own decision.
