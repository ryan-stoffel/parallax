# 0038: An uploaded image can be a Project's or repo's icon, stored inline on the host

- Status: accepted
- Date: 2026-10-02
- Issue: PLX-339

## Context

Ryan wants to upload an image as a Project's icon and as a repo's icon, the initials tile in the breadcrumb and sidebar. An icon is a Lucide name and a palette color (0032, 0033), stored on the host so every client sees the same one. Prompt images (0026) already have a shape, `{ mediaType, data }`, and checks, but they live in their own table and a client fetches each one with `agent/image`.

## Decision

- **Shape.** `ProjectIcon` gains optional `image`, in 0026's `PromptImage` shape: `{ "mediaType": "image/webp", "data": "<base64>" }`. It applies to `Project.icon` and `Repo.icon`, so to `project/create`, `project/update`, `repo/update`, `project/list`, `thread/list`, and the `project.created`, `project.updated`, and `repo.updated` events. When it is present the app draws the image instead of the glyph. `name` stays required, so an app that doesn't know `image` still draws a glyph.
- **Inline and small.** The image travels and is stored inside the icon, not fetched separately. The app sends a 128 px square WebP, so the cap is 64 KiB (65536 bytes) of base64 `data`.
  - Over the cap fails with `imageTooLarge`.
  - Data that isn't base64, or bytes that don't match `mediaType`, fail with `invalidParams`, with 0026's checks.
- **Replace whole.** `icon` still replaces the whole icon (0032), so an icon sent without `image` clears the stored image, the way a missing `color` clears the color. Picking a glyph after an upload is that.
- **Store.** Migration 22 adds nullable `icon_image_type` and `icon_image_data` to `projects` and `repos`. A NULL type means no image, so existing icons keep their glyph. The image is part of a project's `project/create` idempotency check like the rest of the icon.
- **Capability.** plxd advertises `iconImages { maxBytes: 65536 }` in `initialize`, since an older plxd would silently drop `image` (0007). The app sends no image to a host without it.

Amended 2026-11-03 (PLX-1272): a repo with no icon, its own or a namesake's, takes the repository's own favicon or logo. `repo/logo`, behind the `repoLogo` capability, finds the file by name and folder among those git doesn't ignore and answers with its bytes, and the app redraws it whole as the same 128 px WebP and stores it with `repo/update` and `iconIfUnset`, which leaves an icon the user picked meanwhile. So it is an ordinary icon: a user's pick replaces it, and the app never replaces an icon that's set, even when the repository's logo later changes.

Amended 2026-11-09 (PLX-1498): a repository cloned on several computers has one icon. `Repo` gains `iconAt`, when its icon was last picked: `repo/update` sets it on every pick, also of the icon the entry already has, and leaves it absent for a logo set with `iconIfUnset` (migration 62, `repos.icon_at`). On every copy of a repository, matched by name, the app draws the icon picked most recently, or among icons with no pick time the one on the entry created first. plxds still don't sync icons. A pick goes to each connected copy (PLX-927), and the pick time settles the copies that were offline.

## Consequences

- Lists and `*.updated` events stay self-contained: a client draws an image icon with no extra request.
- Each project or repo with an image adds up to 64 KiB to its row, to every list, and to each `project.updated` or `repo.updated` event in the log. That is fine for tens of icons. Fetching icons by id, as `agent/image` does, is the fix if it isn't.
- The app has to downscale and encode an upload before sending it. plxd never resizes or re-encodes.
- The TypeScript type for `image` is `PromptImage`, named for its first use.
