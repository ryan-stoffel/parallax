# 0091: Classic, Beta, and Folders sidebars, with drafts and pins on top

- Status: accepted; amends [0087](0087-sidebar-rows-no-areas-or-folders.md)'s "no separator" and its pinned thread cards, and [0090](0090-projects-page-and-spaces.md)'s New sidebar switch
- Date: 2026-10-29
- Issue: PLX-1150

## Context

Only one New Thread draft could exist, because a second New thread reused the first screen. Drafts listed under the pins, and hovering one blanked its status with nothing in its place. A pinned thread showed its pin in its details line, so pinning made its row a line taller. Thread, Project, and draft rows each built their own card, a hovered title turned bolder and re-truncated, and the hover actions reserved a fixed width. The new sidebar (0090) was a switch in Settings › Beta, and Ryan wants a third sidebar that groups threads by repo, as Codex does.

## Decision

- **Three modes.** Settings › Appearance › Sidebar picks Classic (the default), Beta, or Folders with a segmented control, kept on this computer as `parallax.sidebarMode`. Classic is 0087's sidebar: the search box, filter, and buttons in its head, Today as one list, Projects in their drawer, and Pull requests and Usage in the footer. Beta is 0090's sidebar: New thread, Search, and the pages as rows, then Pinned projects. Folders has Beta's head, and lists the threads in a folder per repo. A stored `parallax.beta.newSidebar: true` reads as Beta. The nav-row switches, Working section, and Archive pages move to the same section from Threads and Beta.
- **Folders are repos, not 0075's folders.** A folder is keyed `host/repo`, and a thread added to a Space sits in that Space's folder. Folders sort by name, then computer, so they don't move as threads do, with No repo last. A folder names its computer only when there are several. Each folds on its own, in its own store (`parallax:folderFolded`), with Alt-click folding them all. A Project is one row in its repo's folder. View's Group option doesn't show in Folders.
- **Drafts on top.** Each fresh New thread gets its own draft id, so opening another leaves the open one as a draft, and several can exist at once. Drafts list at the very top of every mode, newest first, with a thin line under them. A draft's X, shown on hover, or Backspace discards it, with Undo. Drafts slide in and out with the other rows, and the arrow keys reach them.
- **Pins under the drafts.** Pinned threads are ordinary thread rows, under the drafts and favorites, with a thin line under them. A permanent pin sits in each one's top-right, and clicking it unpins. The pin is no longer a detail, so pinning doesn't change a row's height.
- **One row card.** Thread, Project, and draft rows share `RowCard`: place and status, title, details, hover actions, and a `trailing` slot that stays visible on hover. The title keeps its weight on hover, and the line under the actions keeps clear of their measured width. A card under its repo's heading leads with its title and status.

## Rejected

| Option | Why not |
| --- | --- |
| Folders as user-made folders, as 0075 had | 0087 removed them, and a repo is the group Ryan asked for. |
| Folders sorted by latest activity, as Group by Repo is | Folders would jump as threads finish. |
| Projects as folders of their threads in Folders mode | A Project's threads show inside the Project (0042). |

## Consequences

- Beta and Folders share the head, so a change to it reaches both.
- Settings › Beta has nothing in it until another feature goes there.
