# 0086: Agents reach GitHub through plxd

- Status: accepted; extends [0063](0063-schedules-pr-watches-and-delegation.md)'s "agents go through plxd for pull requests"
- Date: 2026-10-25
- Issue: PLX-1018, for PLX-1019 to PLX-1023

## Context

Every agent on a host shares one `gh` login, so one 5,000-request REST quota and one 5,000-point GraphQL quota an hour. 0063 gave agents `pull_request_status` and `watch_pull_request` (PLX-837) and told them, in plxd's MCP instructions, to use them instead of `gh`. A rate-limit audit on Oct 25 still counted 642 `gh pr view` and 268 `gh pr checks` calls in the 9 days from Oct 17. Agents fell back to `gh` for what `pull_request_status` didn't return: title, body, branch names, changed files, check links and run ids, and review thread ids. Several agents asking about the same pull request each cost a read, and agents still read failed job logs, diffs, and upload PR media with their own `gh` calls. Instructions alone don't stop a call; nothing on the agent's side refuses one.

## Decision

Agents reach GitHub through plxd tools, and `gh` refuses what those tools replace.

- **Reads are shared.** A plxd tool reads once per pull request or per head SHA and shares the result across every run that asks, and with the watch sweep. A pull request's read serves every read of it for 30 s.
- **Writes are paced.** plxd sends pull request writes (comments, review replies, resolving threads, merges) itself, spaced to stay under GitHub's secondary rate limits, instead of each agent calling `gh` on its own.
- **A `gh` shim refuses the rest.** plxd puts a `gh` shim first on agents' `PATH`. It refuses each `gh` command a plxd tool replaces, naming the tool to use, and passes every other command to the real `gh`. `github_budget` reports the quota left.

The tools:

| Tool | Replaces | Issue |
| --- | --- | --- |
| `pull_request_status` | `gh pr view`, `gh pr checks` | PLX-1018 |
| `ci_failure_log` | `gh run view --log-failed` | PLX-1019 |
| `upload_pr_media` | committing media or `gh api` uploads for PR bodies | PLX-1020 |
| `pull_request_diff` | `gh pr diff` | PLX-1021 |
| PR writes and `merge_when_ready` | `gh pr comment`, `gh pr review`, `gh pr merge`, thread replies and resolves through `gh api` | PLX-1022 |
| `gh` shim and `github_budget` | any replaced `gh` command; `gh api rate_limit` | PLX-1023 |

## Consequences

- Several agents on one pull request cost one read per 30 s, and the watch sweep's read serves their status calls.
- A status can be up to 30 s old. An agent that just pushed sees its new head once the shared read ages out; `watch_pull_request` covers waiting on it.
- Each replaced `gh` command needs its plxd tool to answer everything agents used it for, or they find another way around the shim. A new field an agent needs goes into the tool, not back into `gh`.
- The shim only covers agents plxd starts. A user's own `gh` calls, in a terminal or a hook, still spend the shared quota.
