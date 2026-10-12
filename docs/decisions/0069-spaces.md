# 0069: A Space is a named group of chats with no repository, made as a repo entry plxd backs

- Status: accepted
- Date: 2026-10-12
- Issue: PLX-732

## Context

Every chat with no repository lands in one "No Repo" group, and a Project needs a repository. Ryan wants Parallax usable as a plain chat app, with chats organized in named groups that need no folder, like Claude's chat and code modes. "Project" already means the coordinator's body of work ([0033](0033-sidebar-attention.md)), so the new group needs another name. Ryan chose **Space**.

## Decision

- **A Space is a repo entry** ([0017](0017-normal-threads.md)) with `space: true`. plxd makes its repository, a `git init` with one empty commit as for a scratch thread, at `<data folder>/spaces/<id>`, and the entry's `path` is that folder.
- **A chat in a Space is an ordinary thread** started with the Space's id as its `repo`. It runs in its own worktree of the Space's repository, and the Space's chats share one context folder, `context/<id>`, as threads in a repository do.
- **Methods**, behind the `spaces` capability: `space/create {id, name, icon?}` is idempotent on `id` and appends `repo.added`. `repo/update` takes an optional `name`, for a Space only, next to its icon. `space/delete {space}` deletes each chat as `thread/delete` does, then the entry and its folders, and appends `repo.removed`. Deleting again finishes a delete that stopped partway.
- **The app** lists Spaces on the rail and in the place menu (amended 2026-10-12, PLX-739), with Rename and Delete, and makes them from the add palette's New Space. New Thread offers each Space beside the repositories, with no branch, checkout, or Open PR controls. Anywhere the app lists repositories to work in, a Space is left out.

## Rejected

| Option | Why not |
| --- | --- |
| A new `spaces` table and `thread.space` column | Every listing, icon, delete, and context path would grow a second branch for something a repo entry already is. |
| Rename "Project" to something else | 0033 settled the word, and it would touch every record, string, and type. |
| Spaces in the app only | Mobile, web, and a second desktop would never see them. |

## Consequences

- An older plxd lists a Space as a repository named for the Space. It has no `spaces` capability, so the app never creates one there.
- A Space's chats are git worktrees like any thread's, which is more machinery than a plain chat needs. Dropping the worktree for Space chats is a later change if it matters.
- Spaces have no Project or coordinator. A Space can't become a Project.
