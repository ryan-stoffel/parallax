# 0073: An area is a named list of threads and Projects plxd stores, and a pin is a flag on the thread

- Status: accepted
- Date: 2026-10-15
- Issue: PLX-789

## Context

The sidebar groups threads by where they run: a repo entry, a Project, or a Space ([0069](0069-spaces.md)). Ryan wants his own groups across those, such as "Launch" holding two repo threads, a Space chat, and a Project, and wants to pin a thread to the top of the sidebar. Neither has anywhere to live today.

A Space is where a chat runs: a repo entry with its own repository, and a thread is in exactly one. An area only lists threads that live elsewhere, across repos, Projects, and Spaces, and one thread can be in several areas. So an area can't be a Space.

## Decision

- **plxd stores areas**, in an `areas` table with `area_threads` and `area_projects` membership tables, so mobile and a second desktop see the same ones. An area has an id the client generates, a name, a color, and its members in the order given. Areas are listed in creation order.
- **Rules**: a name is trimmed, 1 to 40 characters, and unique among areas ignoring case. A color is a palette key, 1 to 32 characters of `a-z`, `0-9`, and `-`, as a project icon's ([0032](0032-project-names-and-icons.md)). Members are top-level threads (no `parent`) and Projects. On create and update plxd silently drops ids that name no thread, a child thread, or no Project, and repeats, keeping first-seen order, and returns what it kept. An undo that re-creates a deleted area, or a race with a delete, then just keeps what still exists.
- **Methods**, behind the `areas` capability: `area/create {id, name, color, threads, projects}` is idempotent on `id` (the same name returns the area, another fails with `idConflict`). `area/update {area, name?, color?, threads?, projects?}` replaces what it names and fails with `areaNotFound` for an unknown area. `area/delete {area}` succeeds for an unknown area.
- **Event**: `areas.changed`, host-level, carries every area after any change. A no-op update or a delete of an unknown area appends none. Deleting a thread (directly or through `space/delete`) or a Project removes it from every area by foreign key cascade, and when that removed a membership, the same transaction appends `areas.changed`.
- **Snapshots**: `thread/list` and `orchestration/subscribeShell`'s snapshot list every area, read with the threads at the same `seq`.
- **A pin is `pinned` on the thread**, set by `thread/update {pinned}`, appending `thread.updated` like `snoozedUntil` ([0033](0033-sidebar-attention.md)).
- **Search snippets**: `thread/search` returns, for each thread matched in its messages, one line of the best-matching message around the match, so the sidebar can show why it matched.

## Rejected

| Option | Why not |
| --- | --- |
| Areas as Spaces or repo entries | A thread runs in one repo entry. An area lists threads from many, and one thread can be in several. |
| Areas in the app's localStorage | Mobile, web, and a second desktop would never see them, and a deleted thread would linger in them. |
| Tags on threads | A tag has no color, order, or Projects, and renaming one means touching every thread. |

## Consequences

- An older plxd has no `areas` capability, so the app hides areas and pins there.
- `areas.changed` resends every area, which is fine at the tens of areas a person keeps. A per-area event is a later change if that grows.
- A top-level thread that later gains a parent, by joining a Project, stays in its areas. The client shows a child wherever its root parent is.
