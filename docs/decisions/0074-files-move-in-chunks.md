# 0074: Files move to and from a host in 1 MiB slices and pieces

- Status: accepted; supersedes in part [0071](0071-file-uploads.md) (the 4.5 MiB cap on an attached file) and PLX-755's `present_files` kinds and 4 MiB cap
- Date: 2026-10-16
- Issue: PLX-833

## Context

Ryan works with agents on other computers, over SSH, Connect, LAN, and the relay. A file he attaches has to reach the agent there, and a file the agent makes has to download here. Every transfer already goes through the host's plxd, but each is one base64 request: `host/upload` takes at most 6 MiB of base64 (0071), `agent/file` and `host/readUpload` answer at most 4 MiB, and a frame is at most 8 MiB (0007). The app gives a request 30 s, so an 8 MiB line needs about 1.7 Mbit/s, and a slow SSH or relay link times out. `present_files` also refused anything over 4 MiB or outside 12 kinds, which ruled out .zip, .csv, .html, .md, and .svg.

## Decision

- **Capability.** `fileChunks { chunkBytes: 1048576, maxBytes: 1073741824 }`. `chunkBytes` is the most file bytes one slice or piece carries, about 1.4 MiB of base64, which a slow link sends well inside the timeout. `maxBytes` is the largest file pieces assemble. An older plxd ignores the new fields, so the app checks for the capability first.
- **Slices.** `agent/file` and `host/readUpload` take optional `offset` and `length`. Either makes the call a slice: `offset` defaults to 0, and `length` defaults to and is at most `chunkBytes`. The answer is that slice, empty past the end, with the whole file's `size`. A slice reads a file of any size. Only `agent/file`'s `working` side reads slices.
  - `agent/file` keeps its path rules: relative, no `..` or `.git`, every folder on the way checked with `lstat`, and the file opened once without following a symlink (`O_NOFOLLOW`) or blocking on a FIFO, then checked on that handle. The slice is read from that handle, never the path again. A symlink's content is still its target.
  - `host/readUpload` keeps its check that the real path is inside the real uploads folder. A slice must also name the file by its real path below that folder, so no link inside it is followed, and opens it the same way as `agent/file`.
  - A call with neither field is unchanged: whole files, capped as before.
- **Pieces.** `host/upload` takes optional `uploadId`, `offset`, and `last`. Any of them makes the call a piece.
  - The first piece has `offset` 0 and no `uploadId`. plxd makes `uploads/<id>.partial/<name>` under a new UUIDv7 and answers it as `uploadId`, with the `path` the file will have.
  - Each later piece names that `uploadId`, which only parses as a lowercase, hyphenated UUIDv7, so it always names a plain folder, and only one plxd made. Its `offset` must be the length received so far, so a gap or a repeat fails with `invalidParams`, as does a file that would pass `maxBytes`. A piece is at most `chunkBytes`. The name is checked as in 0071.
  - `last` renames the folder to `uploads/<id>/`, so the answered path only ever holds a whole file.
  - A failed write truncates the file back to `offset`, so the piece can be sent again.
  - One lock serializes pieces and the sweep.
- **Abandoned uploads.** A `.partial` folder whose newest entry is over an hour old is removed. The sweep runs at start and every 15 minutes, in the loop that already cleans merged worktrees. There was no upload cleanup before.
- **`present_files`** takes any file up to 256 MiB, which the app reads in slices. Known kinds keep their `kind` and viewers. Anything else is `kind: "file"`, a file to download. From outside the thread's folder it still copies in only the 12 known kinds, so a call, such as one a prompt injection asks for, can't pull a key or a credentials file into the folder, where the next commit would take it.

## What 0071 and 0026 still hold

- 0071: the `fileUploads` capability, the `uploads/<uuid v7>/<name>` layout, the name rules, the `Attached files:` list in the message, the transcript's cards, the sandbox's read-only uploads folder, and finished uploads never being removed. A file attached in one request is still capped at 6 MiB of base64.
- 0026: images sent with a prompt are unchanged. They are still base64 in the start or send request, with their caps, stored in the `images` table, and served by `agent/image`.

## Rejected

| Option | Why not |
| --- | --- |
| A larger frame | Still one request, so a slow link still times out, and the whole file sits in memory on both sides. |
| A client-made `uploadId` | plxd-made ids need no format rules beyond parsing, and a piece can only name a folder plxd made. |
| Pieces at any offset, assembled at the end | Ordered appends need no bookkeeping: the file's length is the state. |
| Tracking unfinished uploads in memory | A restart would orphan their files with nothing to tell them from finished ones. |

## Consequences

- An attached file can be up to 1 GiB, and a downloaded one any size, at 1 MiB per round trip.
- A retried piece that already landed fails as a repeat. The app restarts the upload.
- The app side, which sends and reads in pieces and shows `kind: "file"`, is a separate issue. Until then, the app works as before and drops `file` cards.
