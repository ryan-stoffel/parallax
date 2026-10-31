# 0095: A pull request's guide is written by plxd and kept per head

- Status: accepted; extends [0058](0058-thread-naming.md)'s hidden model call
- Date: 2026-10-30
- Issue: PLX-1188

## Context

The PR view's Guide tab (PLX-1188) shows an agent-written walkthrough of a pull request: an overview, then its changes in reading order, each linked to its lines in Code and with an optional Mermaid diagram. It should be ready by the time Guide is clicked, so it is written in the background when a PR view opens, without a visible thread, and kept so reopening the view or restarting plxd doesn't pay for it again.

## Decision

- `pr/guide`, behind `prGuide`, takes the pull request's URL, the head commit the app shows, the model, and `regenerate`. It answers at once with the newest guide plxd has for the pull request, whether one for that head is being written, and why the last try for it failed. It never reads GitHub itself, so the app polls it every few seconds while one is written.
- With no guide for that head, none being written, and no failed try, it starts one. A failed try isn't retried until `regenerate`, so a broken model or a missing `gh` doesn't cost a call per poll. `regenerate` starts one even when a guide for the head exists. Starting a try makes its head the pull request's newest and forgets failed tries at its other heads. A try is kept only if its head is still the newest when it's stored, so an older head's try that finishes last never replaces a newer head's guide.
- The app sends the user's default model at its effort, or the naming model at the naming effort when there's no default or the default's instance isn't Claude Code or Codex. plxd runs it as 0058 runs the naming model: one tool-less CLI call in an empty temp folder, with a JSON schema, through `Backend::namer`, which now takes any schema from its folder. Claude Code and Codex can; other kinds answer that they can't.
- The prompt holds the title, the description, and the diff from `pr/sharedDiff`'s per-head cache. Each file's diff is cut at 20 KB and files past 150 KB in total are left out; their paths go on the guide as `omitted`, which the tab shows.
- plxd checks the answer before keeping it: a non-empty overview and at least one step with a title and explanation, at most 20 steps, text capped, hunks only in files of the diff with `start` at least 1 and `end` at least `start`, and blank or oversized diagrams dropped. A guide that fails the check is a failed try.
- The store keeps one guide per repository and number (`pr_guides`, migration 58) as JSON with its head. A guide for a new head replaces the old one, which the app shows marked out of date while the new one is written.
- The app renders diagrams with Pele, links and images off, its `--pele-*` variables mapped to the theme's tokens. A diagram that doesn't render is left out.

## Consequences

- Opening a PR view costs one model call per new head, on the user's own login and quota. Listing pull requests costs none.
- Tries under way and failed ones live in memory: a restart forgets a failure, and the next open tries again.
- Only the newest guide per pull request is kept, so going back to an older head writes it again.
