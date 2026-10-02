# 0033: The sidebar is one list of threads, ordered by last prompt, that shows what needs you

- Status: accepted
- Date: 2026-10-01
- Issue: RYA-270

## Context

Ryan wants the sidebar to work like T3 Code's without copying it: start many threads at once, then come back only to the ones that finished or wait on you. The sidebar grouped threads under a Hosts section and then by repository, and a thread showed no sign of whether it had news. A thread's status updated only when its row was hovered, since host-level events don't carry run changes.

Ryan decided: the filter is called **Repos** (Project stays the coordinator's word), plain non-git folders stay out, Projects stay optional and show as one row, and a snoozed thread wakes early when it needs you.

## Decision

### The list

- One list of every connected host's threads and Projects, the most recently prompted first. There is no Hosts section and no grouping by repo. A thread's time is `lastPromptAt`, and a Project's is its `updatedAt`. Rows move only when someone sends a message, never when an agent finishes, so the list doesn't shift under the pointer.
- A row shows its repo's icon and name, its status (or how long ago it was prompted), its title, then its branch, diff, and provider.
- A Project is one row: its repo, its combined status, its icon and name, and how many agents it has run. Its subagents never get rows of their own. Users can still start agents inside a Project directly (RYA-47's Agents view), and they share its context.
- The **Repos** filter is a searchable menu: All repos, No repo, then each host's repositories. The choice is kept in the browser's storage, per window. Each repo's gear opens the icon picker.
- Snoozed and Archived threads sit in drawers under the list.

### Attention

What a row asks of the user, from its run, its waiting permission requests, and `seenAt`:

| State | When | Shows |
| --- | --- | --- |
| Needs you | Any permission request waits | "Needs you" |
| Working | The run is starting or running | The logo's two circles swapping, and "Working 12s" from `lastPromptAt` |
| Done | The run stopped after `seenAt`, or `seenAt` is unset | A disc and check. The logo's circles meet and become it, once, on the change only |
| Failed | As Done, for a failed run | "Failed" |
| Settled | Otherwise | The age |

- Opening a thread with news marks it seen. So does a thread that finishes while it is open. A Project row shows Needs you or Working from all its runs, and has no Done state.
- Animations move only `transform` and `opacity`, and stop under `prefers-reduced-motion`.
- Each repo and Project gets its own event subscription for its runs and their permission requests, so status is live with no hover. The app stamps a run's `updatedAt` with the event's time.

### Snooze

- **In 1 hour**, **In 3 hours**, **Tomorrow** (9 AM), **Next week** (Monday 9 AM), or a custom time. A snoozed thread hides until then, unless it needs you, which brings it back at once.
- The app sends a system notification when a snooze ends, or when a snoozed thread starts needing you. Clicking it opens the thread. With the app closed, the thread just comes back to the list.

### plxd, behind `threadAttention`

- `Thread` gains `seenAt`, `snoozedUntil`, and `lastPromptAt` (its newest turn, else its creation). `Repo` gains `icon`, in 0032's shape, which the app draws as the repo's initials when absent.
- `thread/update { runId, seen?, snoozedUntil? }`: `seen` sets `seenAt` to plxd's clock, and `snoozedUntil` replaces the snooze, where a past time ends it. A change appends `thread.updated`.
- `repo/update { repo, icon }` appends `repo.updated`.
- Every recorded message to a thread's run appends `thread.updated`, so every client re-sorts.
- Migration 19 adds the columns and counts existing threads as seen at the upgrade, so old threads don't all show Done.

## Consequences

- Seen state lives on the host, so every client agrees on what is new. RYA-63's unread badges are this state.
- A row's status needs one subscription per repo and Project on each host. That is fine for tens of them. A host-level run summary event is the fix if it isn't.
- A snooze longer than about 24 days isn't armed until something else changes the list, since `setTimeout` caps there.
- The sidebar no longer has Add host. It lives in Settings > Hosts.
