# 0090: A Projects page, nav rows in the sidebar, and Spaces with instructions and files

- Status: accepted; amends [0087](0087-sidebar-rows-no-areas-or-folders.md)'s Projects drawer and [0069](0069-spaces.md)'s Spaces, and extends [0078](0078-coordinator-instructions-pinned.md)'s instructions to a Space's threads
- Date: 2026-10-27
- Issue: PLX-1108

## Context

Projects sat folded in a drawer at the bottom of the sidebar, so they were hard to see. Ryan wants the sidebar to read like Claude's: New thread and Search as rows, a row per page, a way to choose which rows show, and pinned projects listed by name. Projects get a page of cards. He also wants a second kind of project, like Claude's projects: a place that groups threads and gives each the instructions and files the user set. Spaces (0069) already group threads with no repository, but the app stopped making them in PLX-857, and they carried nothing to their threads.

## Decision

- **Two kinds of project.** A Project is a coordinator on a repository (0024). A Space groups threads with no repository. The Projects page's New project menu makes either.
- **No "chat".** A thread with no repository runs commands and edits files on its computer, which "chat" doesn't convey. It reads No repo, with a laptop, on its card, in the repo filter, and in its group; New thread asks "What should we do on <computer>?"; and Mod+Shift+N is New thread without a repo. A Space's threads are threads.
- **A Space's instructions and files.** plxd keeps `instructions` (up to 32 KiB) and `files` (up to 50 paths) on the Space's repo entry, in two columns added by store migration 54. `repo/update` sets them, behind the `spaceContext` capability, and fails with `invalidParams` for an entry that isn't a Space. A file is one `host/upload` saved: its path must be a file inside the uploads folder once links are followed, which a worker's sandbox already reads (0071). The list is replaced whole, and plxd stores each canonical path once.
- **What a thread gets.** Each CLI process of a thread in a Space gets the Space's name, its instructions, and its files' paths on the system-prompt channel 0078 built for the coordinator, read as they are when the process starts. The agent reads a file when it helps, as it does an attachment.
- **The sidebar's head.** What makes something, then what finds it, then where things are: New thread, New project or repository, Search, and Projects, as rows, then More, a divider that folds open to Pull requests and Usage, which leave the footer. They grow in under Projects with the rest, the divider moving below them as Less, and fold away again. Settings › Appearance › Sidebar switches each of the three pages between the head and More, kept on this computer. Under them, Pinned lists pinned projects of both kinds by icon and name, folds, and opens each; a right-click or its actions button opens its menu.
- **The Projects page.** A large heading with how many projects there are and how many need the user, New project, then a search, an All, Projects, and Spaces filter when there are both, and a sort (Recent, Name, Created), then Pinned and Other projects as a grid of cards, up to three across. A card reads as the sidebar's thread cards do: its icon on a tile of its color and its status (the sidebar's Needs you, Working, Done) or its age, then its name, then its kind, how many threads it has, and a Project's branch or a Space's file count. Hovering lights it in its own color. Its menu holds Pin, then the Project menu 0087 put on its row (Rename, Change icon, Full access, Autonomy, Fresh session, Delete), or for a Space Rename, Change icon, and Delete.
- **A Space's page** is New thread in it: the composer, then its Instructions and Files and its threads.
- **Pins** are kept on this computer, as the sidebar's other view choices are.
- **The Projects drawer is gone.** A Project that needs the user, or matches a search, still shows atop the list (0087).

## Rejected

| Option | Why not |
| --- | --- |
| A new kind of project in plxd | A Space already is a named group of threads with its own entry, and 0069 rejected a parallel table. |
| Writing the instructions as `CLAUDE.md` and `AGENTS.md` in the Space's repository | Each backend reads a different file, a thread's worktree is cut before a later change, and the files would show in its diff. |
| Copying files into the shared context folder | A thread's sandbox can't read it (0044), and it holds Markdown only. |
| Keeping the Projects drawer | The page and Pinned show every project, and three Projects places in one sidebar is clutter. |
| Pins in plxd | Thread pins moved there for mobile; project pins are a view choice until another client needs them. |

## Consequences

- A Space thread's open CLI process keeps the instructions it started with. The next process, as after a restart or a backend switch, reads the new ones.
- Claude Code may ask before reading a file outside the thread's worktree, as with an attachment, in a mode that asks.
- An older plxd has no `spaceContext`, so the page shows only its threads there, and no `spaces`, so New project offers only a Project.
