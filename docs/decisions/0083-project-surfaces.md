# 0083: A Project's surfaces read as one place

- Status: accepted; supersedes PLX-494's Project layout where they differ, amends [0044](0044-project-memory.md)'s Memory tab and [0075](0075-arc-sidebar.md)'s Project favorite
- Date: 2026-10-23
- Issue: PLX-948

## Context

Projects v2 (PLX-934) makes a Project one coordinator thread you stay in for months: session epochs, six derived thread states, a board of items, a Library of artifacts, steering from the one thread, and subscriptions. The surfaces built so far came piece by piece. PLX-494 laid out the Project tab as Waiting on you, Working, Done, and Resolved with an activity chart, and Knowledge as the brief, memory, and proposals; PLX-906 then reworked the Project tab as a log. Ryan reviewed several rounds without being satisfied, then signed off on one clickable mockup of every surface on 2026-10-23 (spec 5.10).

## Decision

**Principles.**

- Grounded and glanceable. Every row is built the same way: a state mark, a title, one muted line, and one thing at its end. Rows sit in rounded groups with hairlines between them, under small uppercase headings.
- Each fact shows once: the board on the Project tab, memory in Knowledge, files under All files.
- What needs the user comes first, but a quiet Project looks quiet, not empty.
- One working mark everywhere: the dotted ring in Parallax blue (PLX-920).
- Sora for names and headings only. No dashboards, charts, or decoration that doesn't carry a fact.

**Surfaces.**

| Surface | Design | Ships with |
| --- | --- | --- |
| Sidebar Project | The favorite's square (0075) keeps its icon. While any of its runs works, a streak of Parallax blue runs around the square's edge, clear of its icon or uploaded image, and the Waiting on you count sits on the square's top right corner in place of the needs-you dot. Opening it from the sidebar shows the coordinator chat with the Project tab. | PLX-948 |
| Knowledge tab | A head (name in Sora, entry and document counts); proposals first as To review, each with Accept, Edit, and Dismiss; the brief in place, edited on a click; memory grouped by kind, each row ending in Last used; the entries unused for 60 days or stale, with Keep and Retire; then knowledge documents. | PLX-948 |
| Coordinator chat | Epoch dividers, inline question and approval cards, `@thread` in the composer, a Listening pill, and the agents bar by state. | PLX-942, PLX-944 |
| Project tab | A head with the open count and the state counts as plain text; Waiting on you above the board only when something waits; the board as linked items; threads grouped by the six states; Pull requests, Library, and Scheduled tabs; All files behind the book. | PLX-939, PLX-940, PLX-941 |
| A child's thread | A crumb back to its Project, with its state and landing in the header. | PLX-939 |
| Notifications | Only what needs the user (spec 5.8), with a per-Project setting. | PLX-944 |

**Knowledge in detail.**

- A row's muted line is its scope and where it came from: the title of the thread whose run its source names, or the file it names. The user's own entries name no source.
- Keep writes an entry over itself, which dates it today and drops its Last used, so it leaves the review list (0044). Retire deletes it.
- Editing a proposal saves the edited text at the proposal's target, then removes the proposal.
- Learned lately no longer shows here: the entries it named are in memory.
- Consolidation notes (step 11) and the machine that wrote a You entry (PLX-946) show once plxd reports them.

## Rejected

| Option | Why not |
| --- | --- |
| A Project row in the sidebar, as the mockup sketches | 0075 made Projects favorites' squares; the square carries the same two facts. |
| The Knowledge tab's proposal count on its tab | The panel's tabs don't load memory; the proposals already lead the tab. |
| Counting escalated questions in the sidebar from each Project's inbox | Only the open Project's inbox is loaded, and marking an item seen sends no event. PLX-939 puts each run's state on `AgentRun`, which the sidebar already has. |

## Consequences

- Until PLX-939, the sidebar's count is the Project's runs waiting on an approval, so it can be lower than the Project tab's count, which also includes escalated questions and unread failures.
- 0044's Memory tab order changes: proposals, brief, entries, review, knowledge.
- The surfaces that ship with later steps follow this record, so each PR checks its surface against the mockup and these rules.
