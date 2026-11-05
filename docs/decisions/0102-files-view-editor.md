# 0102: A code editor in the Files view

- Status: accepted; narrows [0020](0020-drop-the-editor-fork.md) and the plan's "An editor" non-goal, which meant a fork of Code - OSS
- Date: 2026-11-05
- Issues: PLX-1427, PLX-1428

## Context

People want to read and change a thread's files without leaving Parallax. T3 Code has this. An agent often writes the same files, so a save can't silently replace what it wrote, and a view open over ssh or the relay can't move whole files to check for changes.

## Decision

The side panel's Files view edits text files in place with CodeMirror 6. It stays a pane, not an IDE: no extensions, language servers, or debugging. "Open in" still hands a folder to a real editor.

- **CodeMirror over `@pierre/diffs/edit`, T3 Code's choice:** that package is 11 MB, brings Shiki, and its editor is new. CodeMirror is proven on large files and brings find, multiple cursors, and undo. Over Monaco: it's much smaller, and draws with the app's CSS variables, so its colors follow the appearance and VS Code themes.
- **Saves are automatic:** 600 ms after typing stops and on Mod+S, as in T3 Code, so an agent's next read sees what you typed.
- **Saves are conditional:** `agent/fileWrite` carries the SHA-256 of the content it was edited from, and plxd refuses a mismatch. The app shows Reload or Overwrite, and Overwrite sends the SHA-256 it was just told, so a third write in between is still caught.
- **Changes on disk are polled:** the app asks for the open file's SHA-256 every 3 seconds while it's on screen, without its content. An unedited view reloads in place.

## Consequences

A file whose line endings are mixed opens read-only, since the editor holds one line ending and saving would rewrite every line. A file over 4 MiB, `agent/file`'s cap, can't be opened, only downloaded. plxd's check and rename aren't atomic together, so a write landing in that gap is replaced.
