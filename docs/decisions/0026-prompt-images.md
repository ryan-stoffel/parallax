# 0026: Images sent with a prompt live in the store, not the event log

- Status: accepted
- Date: 2026-09-29
- Issue: RYA-191

## Context

Ryan wants to paste images into the composer the way Claude desktop does: the image goes to the agent next to the text, and its file name never appears in the prompt. The transcript also has to show those images again after a reload or a restart. The event log (0007, 0014) was built for small events: `agent.output` batches flush at 256 KiB, a transcript item's text is capped at 32 KiB, `agent/events` pages are about 4 MiB, frames are 8 MiB, and the in-memory replay window holds 64 MiB (0016). A single screenshot can be several megabytes.

## Decision

- **Protocol.** `agent/start`, `agent/send`, `thread/start`, and `project/start` take optional `images`: a `mediaType` (`image/png`, `image/jpeg`, `image/gif`, or `image/webp`) and base64 `data`. They're behind the `promptImages` capability, since an older plxd would silently drop them (0007). A message with images may have no text (RYA-193): Claude Code then gets no text block, since the Messages API refuses a blank one.
- **Caps.** Measured on `data`, the base64 text:
  - 5 MiB per image. That's the most every Claude platform accepts per image (Anthropic counts its limit on the base64), so an image plxd accepts, Claude accepts too.
  - 6 MiB per message and 10 images. The request has to fit in one 8 MiB frame next to up to 1 MiB of text.
  - Going over a cap fails with `imageTooLarge`. Data that isn't base64, or bytes that don't match `mediaType`, fail with `invalidParams`.
  - The capability's options list the caps (`maxImages`, `maxImageBytes`, `maxTotalBytes`), so the app can downscale before it sends anything. An oversized frame would otherwise close the connection.
- **Storage.**
  - Once a CLI has taken a message, plxd writes each of its images to a new `images` table in the store (`run_id`, `id`, `media_type`, `data`) under a fresh UUIDv7.
  - The message's `turnStarted` item lists those ids, the same way it carries a follow-up's text (RYA-92). That includes the prompt's turn, which has no `turnId`.
  - `agent/image {runId, imageId}` returns the image as it was sent. It fails with `imageNotFound` for an unknown id.
  - `thread/delete` removes a thread's images along with its turns and events. Otherwise, images stay as long as their run does, like its events (0016, #207).
- **Backends.**
  - Claude Code gets a message's images as Messages API base64 image blocks, ahead of the text block, in its stream-json user message.
  - Codex gets them as files in a private folder under the data folder's `tmp/`, one `--image=<file>` each, on `exec` and `exec resume`. plxd deletes the folder once Codex exits.
  - Codex wraps each image in `<image name=[Image #1] path="...">` itself, so its model sees plxd's temp path. It never sees the user's file name, because plxd never receives one.

## Consequences

- Transcripts stay small. A client fetches only the images it's about to show, one frame per image.
- `plxd.sqlite3` grows by every image sent. #207's run pruning has to remove a run's `images` rows along with its events.
- A retry of a start or send isn't compared on its images, only on the params it already was. A client has to resend the same images with the same id.
- If storing fails after the CLI already has the images, the agent still sees them. Only the rebuilt transcript shows the message without them.
