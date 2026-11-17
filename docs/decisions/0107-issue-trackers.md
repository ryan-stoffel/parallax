# 0107: plxd reads and writes GitHub, Linear, and Jira issues

- Status: accepted; extends [0050](0050-github-setup.md) and [0106](0106-saved-secrets.md)
- Date: 2026-11-17
- Issue: PLX-1594

## Context

Parallax can't see or change the issues the user works from. The app needs one way to list the issues assigned to them on GitHub, Linear, and Jira, read one, file one, move it, and comment on it, from any computer it is connected to.

## Decision

- **plxd talks to the trackers, not the app,** with the `issue/*` methods behind the `issues` capability. A connection is one tracker account on a computer. Each issue carries its connection's id, and every method but `issue/list` takes one.
- **GitHub is the computer's `gh` sign-in** (0050), the connection with id `github`, present while `gh auth status` is signed in. plxd runs the real `gh`, never the agents' shim. Reads use `gh api graphql`, writes `gh issue` and `gh api`. They spend the GitHub quota agents share (0086). An issue's id is `owner/repo#12`, and its states are `open`, `completed`, and `notPlanned`.
- **Linear takes a personal API key, and Jira Cloud a site, an email, and an API token.** `issue/connect` checks them with the tracker first and refuses with the tracker's reason. The store's `issue_connections` table holds the id, provider, account, and site, one row per account, and the token goes to the keystore under the id, as a saved secret's value does (0106). Connecting an account again keeps its id and replaces its token. `issue/disconnect` removes the token, then the row.
- **Linear and Jira go through `curl -q -K -`,** with the URL, the auth header, and the body as a config on stdin, as Cursor's usage does. No token is in argv, a log, the store, or a `Debug` print. plxd has no HTTP crate.
- **States map to five categories:** backlog, todo, in progress, done, and canceled. A Linear issue moves to any of its team's workflow states. A Jira issue moves through a transition, listed as the status it leads to, with its own status included.
- **Bodies and comments are Markdown.** Jira's Atlassian Document Format reads as Markdown for paragraphs, headings, lists, code blocks, hard breaks, and strong, emphasized, code, and link text. Other Jira nodes keep only the text inside them. Markdown written to Jira keeps its paragraphs, line breaks, and fenced code, and the rest as typed.
- **`issue/list` reads every connection at once,** up to 100 open issues assigned to the user on each. A connection that fails is listed in `errors`, and the rest still answer.

## Consequences

- A read-only device can list and read issues, but not connect, file, move, or comment.
- Windows refuses `issue/connect`, as it refuses saved secrets until PLX-23. GitHub still works there.
- A GitHub issue closed as a duplicate reads as not planned.
- Jira Data Center and Server, GitHub Enterprise, and Linear OAuth are out of scope.
- The conversion loses Jira formatting it doesn't cover, such as tables and panels, when an issue is read.
