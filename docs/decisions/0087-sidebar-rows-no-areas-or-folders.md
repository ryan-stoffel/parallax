# 0087: Projects list as rows, finished work rises, and areas and folders are gone

- Status: accepted; amends [0075](0075-arc-sidebar.md) and supersedes [0073](0073-areas.md)'s areas; its Projects drawer and Projects atop the list are replaced by the Projects page and Pinned in [0090](0090-projects-page-and-spaces.md); [0094](0094-sidebar-modes-drafts-pins.md) puts drafts and pinned threads on top under thin lines, and moves a pinned card's pin to its top-right; amended by [0093](0093-orchestrator-threads-and-projects.md), where a Project is an orchestrator thread
- Date: 2026-10-25
- Issue: PLX-1043

## Context

Ryan likes how thread rows look, and the Project squares at the top of the sidebar didn't match them. Threads that finished no longer rose to the top of Today, since rows were ordered by their last prompt only. "All caught up" was a note he'd rather not see; a blank sidebar reads as done. He no longer wants areas or the pinned folders.

## Decision

- **Projects** are cards shaped like a thread's (see Cards), kept in a Projects drawer at the bottom, above Working, folded until opened, as Working, Snoozed, and Archived are. A Project never archives, so it doesn't sit atop the list: one that waits on the user, or matches a search, shows there instead, and goes back to the drawer once answered. Its menu, from its actions button, a right-click, or A, holds Rename, Change icon, Full access, Autonomy, Fresh session, and Delete. Its card ends with its branch (its integration branch, else its checkout's), its computer, and its coordinator's provider. Favorites hold only pinned threads. Mod+K still opens any Project. A Show or Hide choice for Projects was tried before the drawer and dropped.
- **Cards**: thread and Project rows are cards, a little apart, with no outline (one was tried and dropped). A card's top line is its repo's or Project's icon and name, with its status or age at the end; then its title in bold, bolder while hovered; then, for a thread, its branch, cut in the middle at word breaks to fit (`feature/PLX-49-…implementation`), its git and pull request details, its computer, and its provider's logo, in color while the thread is open.
- **No separator**: nothing sits between what's kept and Today: no line, Clear, or Fold. View (group, rows, Projects, auto-archive) moves into the repo filter's menu.
- **Pinned threads** are full thread cards, the same size as Today's, above it in the order dragged into, each marked by its pin. A pin's own menu (Change icon, Add to favorites) gives way to the thread row's; dragging a row onto the favorites still makes it one.
- **Order**: a thread is active as of its last prompt, or when its run last stopped after that (`activeAt`), so a thread that finishes rises to the top of Today. The app records the stop itself (`stoppedAt`), since a run's `updatedAt` also moves on later changes such as a linked pull request. A running thread, or one waiting out a usage limit, keeps its prompt's time, so it doesn't move while it works. A Project is active as of its own last change or when one of its runs last stopped. Rows move only on a prompt or a finish.
- **Empty Today** is blank. A search that matches nothing still says so.
- **Areas** are gone from plxd: `area/*`, `areas.changed`, the `Area` types, the thread list's `areas`, and their tables (migration 53). Pins stay a flag on the thread, behind a new `pins` capability; the app also reads `areas` as pins from an older plxd.
- **Folders** are gone from the app: pins are one flat list in the order dragged into. A layout saved with folders flattens on load, each folder's pins in its place. New folder, a folder's New thread, and a folder in a row's place are gone.

## Consequences

- Projects shuffle as they get busy, as threads do, and lose 0075's drag order.
- A chat with no repo reads as No repo again.
- PLX-858, keeping pin order in plxd, has no folders to carry.
