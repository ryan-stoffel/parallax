# 0087: Projects list as rows, finished work rises, and areas and folders are gone

- Status: accepted; amends [0075](0075-arc-sidebar.md) and supersedes [0073](0073-areas.md)'s areas
- Date: 2026-10-25
- Issue: PLX-1043

## Context

Ryan likes how thread rows look, and the Project squares at the top of the sidebar didn't match them. Threads that finished no longer rose to the top of Today, since rows were ordered by their last prompt only. "All caught up" was a note he'd rather not see; a blank sidebar reads as done. He no longer wants areas or the pinned folders.

## Decision

- **Projects** list as rows shaped like a thread's, at the top of the sidebar, above the favorites and pins and folded with them: the name and status (Needs you, Working, or age), then the Project's icon, "Project", and how many threads it holds. Its menu, from its actions button, a right-click, or A, holds Rename, Change icon, Full access, Autonomy, Fresh session, and Delete. Favorites hold only pinned threads moved up.
- **Order**: a thread is active as of its last prompt, or when its run last stopped after that (`activeAt`), so a thread that finishes rises to the top of Today. A running thread keeps its prompt's time, so it doesn't move while it works. A Project is active as of its own last change or when one of its runs last stopped. Rows still move only on a prompt or a finish, never as an agent streams.
- **Empty Today** is blank. A search that matches nothing still says so.
- **Areas** are gone from plxd: `area/*`, `areas.changed`, the `Area` types, the thread list's `areas`, and their tables (migration 53). Pins stay a flag on the thread, behind a new `pins` capability; the app also reads `areas` as pins from an older plxd.
- **Folders** are gone from the app: pins are one flat list in the order dragged into. A layout saved with folders flattens on load, each folder's pins in its place. New folder, a folder's New thread, and a folder in a row's place are gone.

## Consequences

- Projects shuffle as they get busy, as threads do, and lose 0075's drag order.
- A chat with no repo reads as No repo again.
- PLX-858, keeping pin order in plxd, has no folders to carry.
