# 0054: Access levels are the same for every provider

- Status: accepted; supersedes in part [0027](0027-claude-permission-modes.md) (the modes' names and order, and which ACP agents offer them)
- Date: 2026-10-05

## Context

The Access picker used Claude Code's names (Manual, Accept Edits, Bypass Permissions), and which modes a provider offered depended on its CLI. An ACP agent without modes of its own, such as Pi or Antigravity, offered only Edit.

## Decision

One ladder, most supervised first. The wire values in `AgentPermission` are unchanged.

| App label | `AgentPermission` | Meaning |
| --- | --- | --- |
| Supervised | `manual` | Asks before commands and file changes. |
| Auto-accept edits | `edit` | Accepts file edits, asks before other actions. The default. |
| Auto | `auto` | The provider approves routine actions and blocks the risky ones. |
| Plan (legacy) | `plan` | Plans without editing. Hidden unless Settings > General > Legacy Plan mode (kept per computer) is on, or the thread started in Plan. |
| Full access | `bypass` | Runs commands and edits files without asking. |

Each backend offers the levels it can honor. Claude and Codex keep their native mappings. Cursor's SDK has no approval callback, so it has no Supervised.

For an ACP agent, plxd enforces the ladder itself, because ACP agents ask through `session/request_permission`:

- Full access allows every request.
- Auto-accept edits allows requests for `edit`, `delete`, and `move` calls and asks for the rest.
- Supervised, Auto, and Plan ask for every request.
- Supervised, Auto-accept edits, and Full access are offered for every ACP agent. Plan and Auto stay with agents that map a mode of their own.

## Consequences

- An ACP agent that never asks, because its own configuration allows everything, is not limited by Supervised. plxd can only answer what the agent asks.
- Auto-accept edits now allows edits for ACP agents when the client can't answer requests, where it rejected them before.
