# 0071: A file attached to a message is saved on the host, and the message names its path

- Status: accepted; superseded in part by [0074](0074-files-move-in-chunks.md) (a file may also arrive in 1 MiB pieces, up to 1 GiB, and be read back in slices)
- Date: 2026-10-14
- Issue: PLX-779

## Context

The composer takes any file, but only images reach the agent (0026). Ryan wants to attach a PDF, such as a paper, and have the agent read it. Every backend's agent can read a file on disk with its own tools: Claude Code's Read tool reads PDFs (with poppler for more than 10 pages, PLX-780), and Codex, Cursor, and OpenCode read files through their tools. None of them take an arbitrary file inside the message the way Claude Code takes an image block. The host may be another computer, so the app can't write the file there itself.

## Decision

- **Method.** `host/upload {name, data}` saves a file at `<data folder>/uploads/<uuid v7>/<name>` and answers its absolute `path`. It's behind the `fileUploads` capability, whose `maxBytes` caps the base64 `data` at 6 MiB, so one request fits in one 8 MiB frame (0007). A name with `/`, `\`, or `:` (on Windows `C:x` names a path on drive C), a name that is `.` or `..`, or `data` that isn't base64, fails with `invalidParams`.
- **The message.** On send, the app uploads each attached file and adds an `Attached files:` list of their paths after the text. The agent decides how to read them. `agent/start`, `agent/send`, `thread/start`, `project/start`, the queue, and the store are unchanged, and the transcript shows the list as part of the message.
- **The transcript** takes the list back off a sent message and shows each file as a card above the text: a PDF's first page, which it draws from `host/readUpload {path}`, or else the file's name. `host/readUpload` serves only files inside the uploads folder, after following links.
- **Images** keep 0026's path, since the model then gets them as images. Each is also saved with `host/upload`, as `image-<n>.<ext>`, and listed with the files, so the agent has a file to copy, edit, or pass to a tool (PLX-799), as T3 Code does. The transcript shows them as images, not cards, and Stop and the pencil put them back without their paths, since they are saved again when the message sends.
- **Sandbox.** A worker's sandbox (0013) lists the uploads folder as read-only, so it stays readable inside the otherwise unreadable data folder.

## Rejected

| Option | Why not |
| --- | --- |
| A `files` field on every start and send method, like `images` | It runs through the queue, placement, the store, and every backend, and each backend would still only hand the agent a path. |
| Save into the thread's worktree | A new thread has no worktree yet when the app sends, and the file would show up in its diff and commits. |
| Send a PDF to Claude as a document block | Claude only, and still nothing for any other file type. |

## Consequences

- A file is at most about 4.5 MiB. A larger one is refused when it's attached. Chunked uploads are the upgrade if that's too small.
- Uploads are never removed. Removing them with their thread would need the thread to record them.
- Amended 2026-10-23 (PLX-941): files now persist in the other direction too. A file a Project's child presents with `present_files` is copied into the Project's `artifacts/<thread>/` (0005), where it outlives the child's worktree, and clients read it back in slices with `context/readBytes`, as `host/readUpload` reads an upload (0074). Unlike uploads, artifacts are deleted oldest first past 2 GiB a Project.
- The paths are in the message's text, so another client, such as the mobile app, shows them as text, and Stop puts them back as text.
