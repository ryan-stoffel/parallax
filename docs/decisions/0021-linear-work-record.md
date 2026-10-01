# 0021: Linear is the work record

- Status: accepted
- Date: 2026-09-28
- Issue: RYA-5

## Context

GitHub issues were the single record of work: `type:*`, `area:*`, and `priority:*` labels, GitHub milestones, and a `blocked` issue per question for Ryan. After 0020 the issues were wiped, and the re-plan for the desktop app (0022) and the other OSes (0023) was written in Linear instead. Agents follow CLAUDE.md, so while it still points at GitHub issues they file work in the wrong place.

## Decision

- **Where:** the Linear project Wisp (team Ryanstoffel) replaces GitHub issues. Plans, reasoning, decisions, progress, blockers, and questions go in Linear issue comments. GitHub keeps the code, pull requests, and CI.
- **Milestones:** M0 Foundations, M1 App shell, M2 Hosts, M3 Subscriptions, M4 Projects, M5 Review, M6 Local agent + triggers, M7 Release. Each has an epic issue with the Epic label (RYA-74 to RYA-81), and its tasks are the epic's sub-issues, not a checklist.
- **Labels:** one type label per issue: Feature, Bug, Chore, Docs, or Improvement. One label from the Area group: app, daemon, ci, or release. Blocked marks an issue waiting on Ryan or a third party. Priority is Linear's own field, not a label.
- **Comments:** working an issue still posts Plan, Progress, and Handoff comments, on the Linear issue.
- **Branches:** `<type>/<ID>-<slug>` with the Linear ID, e.g. `feature/RYA-12-connect-app-to-wispd`. The prefix follows the type label; Improvement uses `feature/`. Linear's suggested branch name (`stoffelthomasryan/rya-…`) is never used.
- **Commits:** Conventional Commits that end with the Linear ID, e.g. `feat: show follow-up messages in a rebuilt transcript (RYA-92)`. A squash merge adds the PR number after it.
- **Pull requests:** the body links the issue on its own line, `Linear: https://linear.app/ryanstoffel/issue/RYA-n`, instead of `Closes #n`. Linear's GitHub integration attaches the PR to the issue from the ID in the branch name and marks the issue Done when the PR merges.
- **Blocked on Ryan:** add the Blocked label to the issue that is waiting, comment the question there and mention Ryan, then move on. There is no separate `blocked` issue per question.

`#n` references in older records and commits are GitHub issues and PRs from before the move. They stay as they are.

## Consequences

- CLAUDE.md and `.github/pull_request_template.md` describe this flow.
- Agents need the Linear MCP tools to read and write issues. GitHub is only needed for PRs and CI.
- New GitHub issues aren't used. The history from before the move stays on GitHub.
