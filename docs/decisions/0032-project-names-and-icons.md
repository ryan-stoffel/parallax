# 0032: A project's name and icon live on its host

- Status: accepted
- Date: 2026-10-01
- Issue: RYA-227

## Context

Ryan wants projects to be renamable and to have an icon he chooses, with a color, like Cursor's Projects. A project's name is fixed at `project/create`, and a project has no icon. The app (RYA-230) adds an icon picker and a Rename action, and needs a contract to build them on.

A project lives in its host's store (0009), and any number of clients can attach to one plxd (0007). The app sorts its sidebar by `Project.updatedAt`, most recent first.

## Decision

- **Shape.** `Project.icon` is optional: `{ "name": "rocket", "color": "green" }`.
  - `name` is a Lucide icon's name in kebab-case: 1 to 64 characters of `a-z`, `0-9`, and `-`.
  - `color` is optional, a key of the app's palette: 1 to 32 characters from the same set. Absent means the app's accent.
  - Absent `icon` means the app's default icon.
  - Anything else fails with `invalidParams`. Unknown fields inside `icon` are ignored, as everywhere in 0007.
- **The host stores it.** plxd keeps the name and color as the client sent them and never interprets them. Migration 16 adds nullable `projects.icon_name` and `projects.icon_color`, and a NULL name means no icon, so existing projects have none. A project's name and icon are part of the project, so every client of the host sees the same ones.
  - Neither names nor colors are checked against a list. The app owns the icon set and the palette, and falls back to its default icon and accent for a name or color it doesn't know, so it can change either without a plxd release.
- **Methods.**
  - `project/create` takes an optional `icon`. It is part of the create's idempotency check (0007): a retry with the same id and a different icon fails with `idConflict`.
  - `project/update { project, name?, icon? }` changes a project. An absent field stays as it is, and `icon` replaces the whole icon, so an icon sent without a color clears the color. `name` follows `project/create`'s rules. The repository can't change. It returns `{ project }` as `project/create` does, and fails with `projectNotFound` for an unknown id.
  - There is no way to remove an icon once set. `"icon": null` reads as absent, like every optional field, and leaves the icon as it is. The app can pick its default icon by name instead.
- **`updatedAt`.** A rename or a new icon is not activity, so `project/update` leaves `updatedAt` as it is, and the sidebar order stays put.
- **Event.** A change appends a host-level `project.updated` event carrying the whole project, logged, replayed, and pruned like `project.created` (0016). An update that changes nothing appends no event.
- **Deleting (PLX-338).** `project/delete { project }` deletes each of the Project's runs through its actor, coordinators first, as `thread/delete` deletes a thread's: it stops a running CLI, then removes the run's rows, events, turns, images, worktree, and branch, one run per transaction. The Project row goes last, in the same store job that appends a host-level `project.deleted { project }`, so a crash midway leaves the Project listed and deleting it again finishes the job. An unknown id or a repo entry's id fails with `projectNotFound`. plxd advertises it as `projectDelete`.
- **Capability.** plxd advertises `projectEdit` in `initialize`. It gates `project/update`, `project.updated`, and `icon` on `Project` and `project/create`, since an older plxd would silently drop an `icon` (0007). On a host without it, the app hides editing and sends no icon.

## Consequences

- RYA-230 builds the picker and Rename on this contract without another protocol change.
- The generated TypeScript type is `ProjectIcon`. An app component with the same name has to import the type under another name.
- A `project/create` retried after the project was renamed or given another icon fails with `idConflict`, since the stored project no longer matches its params. A client only retries a create right after a lost connection, before the user can edit it.
- The palette and the icon set can change in the app alone. A host never holds a name it would reject later, because it never checks names against a list.
