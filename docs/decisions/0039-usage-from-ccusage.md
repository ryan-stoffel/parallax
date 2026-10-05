# 0039: The Usage page counts every Claude Code, Codex, and Cursor session, from ccusage and Cursor's API

- Status: accepted
- Date: 2026-10-02
- Issue: PLX-348

## Context

The Usage page's Cost and Tokens views summed `usage/history`, which only knows about runs plxd started. Ryan wants all of his usage: Claude Code and Codex run in terminals outside Parallax, and he uses Cursor desktop. Claude Code and Codex each keep a log of every session on the host (`~/.claude/projects`, `~/.codex/sessions`), and ccusage already reads both and prices them. Cursor keeps no local log of tokens. Its dashboard reads them from a private API that accepts the desktop app's own sign-in, the same way tokscale does.

## Decision

- **`usage/daily`** takes `since`, a civil date, and `timeZone`, an IANA name, and answers `days`: input, output, cache read, and cache write tokens and cost per local day, agent (`CliKind`: `claude`, `codex`, `cursor`), and model. A source that fails becomes a `problems` entry (`ccusage` or `cursor`, with a message written for people), so the other sources still show. It also answers `sessions`: Claude Code's and Codex's session counts per local day of each session's last activity, from `ccusage session` (PLX-561). Cursor's API has no session id, so Cursor has none, and when the count fails `sessions` is left out rather than becoming a problem. An invalid time zone is `invalidParams`. The sources run at the same time, and cancelling the request stops them.
- **Claude Code and Codex come from ccusage 20**: `ccusage daily --json --by-agent --since <date> -z <timeZone>`, found on the launcher's `PATH`, else run as `npx -y ccusage@20`. With neither on the host, the problem says to install Node.js or ccusage. plxd keeps only the agents `claude` and `codex`. Runs plxd started are already in those logs, so nothing is counted twice. It gives up after 60 seconds, which leaves time for npx's first download.
- **Cursor comes from `POST https://cursor.com/api/dashboard/get-filtered-usage-events`**. plxd reads `cursorAuth/accessToken` from Cursor's `state.vscdb`, opened read-only. It takes the user id from the JWT's `sub` and sends the cookie `WorkosCursorSessionToken=<user id>%3A%3A<token>`. It pages from 1, 500 events a page, up to 200 pages. Events are summed by local day and model. The cost is `tokenUsage.totalCents`, else `chargedCents`, and events that used and cost nothing are dropped. Without Cursor, or with Cursor signed out, there are no Cursor rows and no problem. HTTP 401 or 403 says to sign in to Cursor again.
- **The request goes through the system `curl`**, with its config, including the cookie, on stdin (`-K -`), so `ps` never shows the token. plxd never logs the token. An HTTP crate isn't an option: cursor.com's bot protection turns away rustls's TLS fingerprint. `rusqlite`, which the store already builds, moves into plxd's dependencies.
- **App.** Cost and Tokens ask each connected host for `usage/daily` in the app's time zone, once for the range and the range before it, and add the hosts together. Ranges are whole local days: Today, 7, 30, and 90 days. Today replaces Past 24h, because ccusage reports whole days, and it shows how the day splits by model instead of a chart with one bar. To compare fairly, the range before counts its last day only as far as today has gone. The summary shows the total, the sessions in the range beside the range before's, and the busiest model. Each host's problems show as quiet notes above the rest. Each section is a full-width row: summary, tokens by kind, chart, one card per provider, and a breakdown that shows five rows until Show more. The summary and tokens strips stay short so the chart fits in an 800px window without scrolling.
- **What stays.** Limits still reads `usage/get`. `usage/history` and the store's usage records stay. The app just stops using `usage/history` on this page.

## Consequences

- Usage now covers the whole host, not just Parallax. The Usage page is no longer a record of what Parallax ran.
- A host without Node.js shows no Claude Code or Codex usage until Node.js or ccusage is installed. The first `npx` run downloads ccusage.
- Cursor's API is private and can change. A change shows up as a problem on the page, not as a failed answer.
- The page is only as complete as the logs. Claude Code deletes session logs older than 30 days by default (`cleanupPeriodDays`), so 90 days, and the range before 30 days, can come up short, and Change can look extreme.
- Cursor pages are fetched one at a time. On Ryan's Mac, 180 days (90 days and the 90 before them) took 9 s, and two days took 1 s.

## Evidence

On 2026-10-02, on macOS 27.0, `plxd serve` with an empty data folder answered `usage/daily` from `2026-08-04` in `America/Los_Angeles` with no problems. ccusage ran through `npx`, since `ccusage` wasn't on the `PATH`. The totals were Claude Code $1,872.99 (4.40B tokens), Codex $103.43 (125M), and Cursor $2,211.18 (2.23B, from 97 rows). The built app against it showed all three on the Usage page.
