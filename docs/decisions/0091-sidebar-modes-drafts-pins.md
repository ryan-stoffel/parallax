# 0091: Inbox and Traditional sidebars, with drafts and pins on top

- Status: accepted; amends [0087](0087-sidebar-rows-no-areas-or-folders.md)'s "no separator" and its pinned thread cards, and [0090](0090-projects-page-and-spaces.md)'s New sidebar switch
- Date: 2026-10-29
- Issue: PLX-1150

## Context

Only one New Thread draft could exist, because a second New thread reused the first screen. Drafts listed under the pins, and hovering one blanked its status with nothing in its place. A pinned thread showed its pin in its details line, so pinning made its row a line taller. Thread, Project, and draft rows each built their own card, a hovered title turned bolder and re-truncated, and the hover actions reserved a fixed width. The new sidebar (0090) was a switch in Settings › Beta, and Ryan wants a sidebar that groups threads by repo in folders, as Codex and Claude do.

## Decision

- **Two styles.** Settings › Appearance › Sidebar picks Inbox (the default) or Traditional with a segmented control, kept on this computer as `parallax.sidebarMode`.
  - **Inbox** is 0087's sidebar: the search box, filter, a Projects button, New project, and New thread in its head, the threads as one list by activity, and Pull requests and Usage in the footer. Its Projects drawer is gone: a Project that needs the user, or matches a search, lists atop the threads, and the rest are on the Projects page.
  - **Traditional** has 0090's head (New thread, New project or Space, Search, and the pages as rows, then Pinned projects) and lists the threads in a folder per repo. A row under a folder leaves out its repo, since the folder names it, and is denser than Inbox's cards: title and status, then branch, computer, and provider. A Project under a folder is one line of its icon and name, then its details.
  - In Traditional, the head's row is **New project** (a Space, which 0093 names a Project); orchestrator threads (0093's name for a coordinator Project) start from New thread's picker, which lists them under the repositories with New orchestrator thread last. Pinned there is one style: a pinned Space is a line of its icon and name that opens its page; a pinned orchestrator thread or thread is the same dense card as a thread under a folder, with its first line (its repo's or Project's icon and name) back, since it's pinned on its own. A thread whose only details are its computer and provider shows them at its title's end, so no row spends a line on them.
  - Earlier names read as these: Classic as Inbox, and Beta and Folders, which shared 0090's head, as Traditional. A stored `parallax.beta.newSidebar: true` reads as Traditional. The nav-row switches, Working section, and Archive pages move to the same section from Threads and Beta.
- **Folders are repos, not 0075's folders.** A folder is keyed `host/repo`, and a thread added to a Space sits in that Space's folder. Folders sort by name, then computer, so they don't move as threads do, with No repo last. A folder names its computer only when there are several. Each folds on its own, in its own store (`parallax:folderFolded`), with Alt-click folding them all. A Project is one row in its repo's folder. View's Group option doesn't show in Traditional.
- **Drafts on top.** Each fresh New thread gets its own draft id, so opening another leaves the open one as a draft, and several can exist at once. Drafts list at the very top of every mode, newest first, with a thin line under them. A draft's X, shown on hover, or Backspace discards it, with Undo. Drafts slide in and out with the other rows, and the arrow keys reach them.
- **Pins under the drafts.** Pinned threads are ordinary thread rows, under the drafts and favorites, with a thin line under them. A permanent pin sits in each one's top-right, and clicking it unpins. The pin is no longer a detail, so pinning doesn't change a row's height.
- **One row card.** Thread, Project, and draft rows share `RowCard`: place and status, title, details, hover actions, and a `trailing` slot that stays visible on hover. The title keeps its weight on hover, and the line under the actions keeps clear of their measured width. A card under its repo's heading leads with its title and status.

## Rejected

| Option | Why not |
| --- | --- |
| Folders as user-made folders, as 0075 had | 0087 removed them, and a repo is the group Ryan asked for. |
| Folders sorted by latest activity, as Group by Repo is | Folders would jump as threads finish. |
| Projects as folders of their threads in Traditional | A Project's threads show inside the Project (0042). |
| Three styles, keeping 0090's head over a flat list as Beta | Ryan settled on two (2026-10-30): one by activity, one by folder. |

## Consequences

- Settings › Beta has nothing in it until another feature goes there.
