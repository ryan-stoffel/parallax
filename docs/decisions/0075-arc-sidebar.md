# 0075: The sidebar is favorites, pinned threads in folders, and Today, as Arc's is

- Status: accepted; supersedes in part [0033](0033-sidebar-attention.md) (one list, most recently prompted first) and the app's use of [0073](0073-areas.md)'s areas
- Date: 2026-10-17
- Issue: PLX-857

## Context

The sidebar (0033, PLX-789, 0073, PLX-852) asked the user to manage threads, Projects, areas, and Spaces. What a user checks most is which threads finished or failed, so they can read one or send it back to work. Finished coding threads went to Archived, and chats he comes back to for days, such as homework or a brainstorm, got buried among them. Ryan prototyped several sidebars in the renderer preview and picked the one modeled on Arc's browser sidebar.

## Decision

- **Favorites**: every host's Projects as squares atop the sidebar, as many to a row as fit and stretched to fill it, and any pinned thread moved up among them. They keep the order they're dragged or moved into (Alt+Left and Right, or their menu), else by name, so they don't shuffle as Projects get busy. A Project's square has a dot only for what finished, failed, or waits on the user, and its menu holds what its row's did: Rename, Change icon, Full access, Autonomy, and Delete.
- **Pins**: the pinned threads (0073's `pinned`) as rows under the favorites, in folders that nest. Dropping a row on another's middle makes a folder of the two; on an edge, it goes before or after. A folder has a name and a color, both set from its menu, and its New thread files what it starts there. A chat in a folder names the folder where it has no repo. A pinned thread, and a favorite one, keep its row's Archive, Snooze, and Delete, in their menus and on E, S, and ⌫; its Resume after usage limits waits on PLX-860.
- **Today**: under a divider, New thread, then every other open thread, most recently active first. Clear archives the finished threads already seen, but not one waiting out a usage limit (0049). View groups them by repo or by day under headings that fold and stick while their rows scroll, shows them as one-line rows, and archives a finished thread neither prompted nor running past a chosen time, which is off by default.
- **Working** keeps working threads in its drawer above Snoozed and Archived, folded until opened.
- **Rows** show the branch, commits not pushed and uncommitted lines (`agent/gitStatus`), and the open pull requests' checks as one mark.
- **Threads another thread started** (0041), subagents' among them, don't list; opening one marks the row of the thread at the top of its family, which also says when one of them needs the user, or failed since that row was last read.
- **Folding the top** shrinks the favorites and turns the pins into one line of how many there are and what finished or failed.
- **Areas and Spaces** no longer show in the app, and neither do inline approvals in rows; plxd keeps areas, Spaces, and their methods.
- Folders, their order, the favorites' order, pin icons, folds, and Today's settings live in the app's localStorage.

## Rejected

| Option | Why not |
| --- | --- |
| Keep areas beside folders | Two ways to group the same threads; threads, Projects, areas, and Spaces were already too many kinds of thing to manage. |
| Folders as areas in plxd now | An area doesn't nest, order its members among pins and other folders, or hold an icon per thread; PLX-858 changes plxd for that. |
| Auto-archive on by default | T3 Code's users pushed back on threads settling themselves; this is opt-in. |
| Code and chat in separate lists | It's the split Claude and Codex make, which Ryan wants gone; folders keep chats together with any thread. |

## Consequences

- 0073 rejected areas in localStorage because mobile, web, and a second desktop never see them. Folders have the same gap until PLX-858 keeps them in plxd, where they may replace areas.
- A scope saved while areas showed lists every thread.
- A thread that waits on the user still says Needs you in its row, and ⌥↓ goes to it, but it's answered in the thread.
