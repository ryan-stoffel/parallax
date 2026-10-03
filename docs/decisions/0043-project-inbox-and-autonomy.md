# 0043: A Project reports to an inbox, and its autonomy decides who answers its children

- Status: accepted; supersedes in part [0025](0025-coordinator-wake-ups.md) (the cap of 10)
- Date: 2026-10-03
- Issue: PLX-383

## Context

With ten threads, the user reads every chat, answers every question, and remembers what they told each one. A Project should take that on: one place to check, and children that never sit idle waiting for an answer. Permission mode ([0042](0042-project-children-are-threads.md)) decides what tools a child may run without asking. Who may answer a child's questions is a separate choice: many users will want Bypass for speed and still make product calls themselves.

0025 pauses a coordinator after 10 wake-up turns in a row. A day away with 15 to 20 children, each waking it 3 to 5 times (done, a question, a conflict, red checks), is 50 to 100 turns, so 10 stops a Project within an hour.

## Decision

### The inbox

- plxd keeps a Project's inbox in the store: each item has a kind, the child run it's about, a line of text, a time, and `seenAt` (0033's read model). `inbox/list {project}` lists them, `inbox/seen` marks them read, and each new one appends `inbox.added` to the Project's events.
- Items are built from events plxd already handles, not by the coordinator rereading transcripts:

| Kind | Added when |
| --- | --- |
| `needsYou` | A question goes to the user, a child's permission request is waiting (0031), a landing needs approval or failed twice ([0045](0045-integration-branch.md)), or wake-ups paused |
| `done` | A child finishes, with its diff stats and whether it landed |
| `failed` | A child fails, or a placement waits with a reason ([0046](0046-project-scheduler.md)) |
| `decided` | The coordinator answered a question for the user |
| `learned` | Memory changed ([0044](0044-project-memory.md)) |

- The app shows unread items at the top of the coordinator chat, in that order, each linking to its child. Needs you raises a system notification, as 0033's snooze does.

### Questions never block

- A child asks with `ask {question, assumption}`. It returns at once: the child goes on with its assumption. plxd records the question, and the coordinator sees it in its next wake-up.
- The coordinator answers with `answer {question, text}`, or passes it to the user with `escalate {question}`. An answer that differs from the assumption goes to the child as a queued message (PLX-370). The item shows as Decided for you: "went with X, change it?". Changing it sends the child a correction.
- A question nobody has answered stays in Needs you. The child has already moved on, so the user comes back to work done on stated assumptions, not to idle children.

### Autonomy

A Project has an autonomy level, Routine by default:

| Level | The coordinator answers |
| --- | --- |
| Ask me | Nothing. plxd refuses `answer` and sends every question to Needs you. |
| Routine | Questions memory or the code clearly answers. |
| Full | Everything it can justify. |

- Routine and Full differ only in the coordinator's instructions.
- At every level the coordinator's own tools never push, merge, open a PR, or delete a branch without the user ([0045](0045-integration-branch.md)). Children are told the same. In Bypass nothing enforces that on a child, which the disclaimer says.
- Every answer is listed and reversible, and the user can always message a child directly.

### Wake-ups

- 0025 applies to a Project's coordinator as to any parent (0041). The cap is 100 wake-up turns in a row instead of 10. Reaching it pauses wake-ups as 0025 does, adds a Needs you item, and the user's next message to the coordinator lets them through.

### Away

On an external home host, children, wake-ups, and landing go on with the laptop closed, and triggers (M6) start new work. Coming back, the inbox is the summary.

## Consequences

- The inbox costs no tokens to build. Its lines come from events, the coordinator's answers, and memory writes.
- A wrong assumption costs the work done on it before the correction arrives. Ask me makes that more likely, since nothing answers until the user does.
- A looping coordinator runs up to 100 turns before it stops. The per-account caps ([0046](0046-project-scheduler.md)) bound what that spends.
