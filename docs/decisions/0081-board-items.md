# 0081: The board is items

- Status: accepted; amends [0044](0044-project-memory.md)'s Board layer and the board lines of `coordinator.md`
- Date: 2026-10-23
- Issue: PLX-940

## Context

A Project's coordinator kept `notes.md`, its status board, by rewriting the whole file with `write_context`, last writer wins, with no versions and no item ids (0005, 0044). Rewriting a whole file drops items: a Cursor tester saw a coordinator rewrite its `notes.md` 111 times in 3 days, and decisions fell off. Ryan chose stored items, edited by delta, with `notes.md` generated from them (Projects v2 spec, decision 3).

## Decision

- **plxd stores the board** in a `board_items` table (migration 49): a host-wide integer id, the Project, one line of Markdown text, a status (`open`, `done`), a section (`now`, `next`, `risks`), links (thread run ids, a pull request URL, files), and when it was added, changed, and marked done.
- **Methods**, behind the `board` capability: `board/list {project}`, `board/add {project, text, section, status?, links?}`, `board/update {project, id, text?, section?, status?, links?}`, which replaces `links` whole, and `board/remove {project, id}`, which succeeds with `removed: false` for an unknown item. The id is a small integer, not a client-generated UUID, so it costs an agent a few tokens to read and pass back. So `board/add` is not idempotent: a retry adds a second item, which the coordinator or user removes.
- **Agent tools**: the coordinator gets `board_add`, `board_update`, and `board_remove`, each one change to one item. `board_update` replaces only the link fields it names. Children don't get them.
- **plxd renders the files.** After every change, at start, and every hour, plxd writes `notes.md` (`## Now`, `## Next`, `## Risks`, a section with no items left out) and `archived.md` (done items marked done 7 or more days ago) through `context/write`'s own path, so each rewrite appends `context.changed`, and only when the content changed. Each line is `- [ ]` or `- [x]`, the text, then `(id N, …)` with its links. `notes.md` ends with `Older items: [archived](archived.md)` while anything is archived.
- **`context/write` refuses `notes.md` and `archived.md`** for every writer, with a message naming the three tools. An agent that writes the file on disk directly is overwritten at the next render.
- **Migration**: migration 49 marks a store that has Projects. On the next start, before plxd serves anything, it copies each Project's `notes.md` and `archived.md` to `notes.legacy.md` and `archived.legacy.md` (once), and, for a Project with no items yet, parses them: a `- [ ]` or `- [x]` line under `## Now`, `## Next`, or `## Risks` becomes an item there, one under another heading or none goes to Risks with its status, and every other line that isn't blank, a heading, or the `Older items:` link becomes an open Risks item as written. Items from `archived.md` count as done at least 7 days ago, so they stay archived. Then it renders the board and clears the mark. A crash at any step is safe to run again.

## Consequences

- An edit changes one item, so a rewrite can't drop the others, and each item can link its threads and pull request.
- The coordinator learns ids from `notes.md` or a tool's result, and must pass one to change an item.
- The app still reads `notes.md`; it can move to `board/list` and render the links itself.
- A migrated item from a free-form line sits in Risks until the coordinator files or removes it.
