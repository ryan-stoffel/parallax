# 0097: Same-named Projects count as one across computers

- Status: accepted; amends [0090](0090-projects-page-and-spaces.md)
- Date: 2026-11-02
- Issue: PLX-1245

## Context

A Project lives on one computer, and `thread/setProject` only takes a Project on the thread's computer. So a computer with no Projects hid Add to Project from all of its threads, and a Project's plus button listed one computer's threads. New thread's computer bar already treats same-named Projects as one Project.

## Decision

- **Add to Project** lists every connected computer's Projects, by name. Choosing one adds the thread to the Project of that name on the thread's computer, and makes that Project first if it has none, with the name, icon, and instructions copied.
- **A Project's page** lists threads from every computer with a Project of its name, and opens and archives each on its own computer.
- **The plus button** lists threads on every connected computer, including archived and orchestrator threads. Adding an archived thread un-archives it, since the page lists no archived threads.
- plxd doesn't change. Each same-named Project stays its own entry on its own computer.

Amended 2026-11-04 (PLX-1373): plxds can now reach each other for agent work ([0101](0101-agents-work-across-computers.md)). Projects stay as this record has them.

## Rejected

| Option | Why not |
| --- | --- |
| One Project shared across computers, kept in sync | plxds don't talk to each other, and a thread's Project context is read on the thread's computer. |
| Moving a thread to the Project's computer | Its worktree and CLI session are on its own computer. |

## Consequences

- Uploaded files aren't copied, since they live on their own computer. A copy starts with none.
- Later edits to one copy's instructions don't reach the others.
- Two same-named Projects on one computer stay separate there, and each page lists its own threads on that computer.
