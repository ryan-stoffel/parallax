# 0044: Project memory: what a child starts with, and who writes it

- Status: accepted; supersedes in part [0005](0005-shared-context-folder.md) (every agent writes the folder, last writer wins, and agents get its path)
- Date: 2026-10-03
- Issue: PLX-383

## Context

A thread starts from zero. Each Project has a context folder (0005), where the coordinator keeps `notes.md` as a status board, and threads in one repo share `context/<repo id>`, but nothing shows it, no first message mentions it (0034), and writes are last-writer-wins. Over a week a Project should mean fewer corrections, repeated explanations, and repeated dead ends than threads, because each child starts with what the Project already knows.

## Decision

### Layers

| Layer | Holds | How a child gets it |
| --- | --- | --- |
| Brief | Goal, scope, and constraints, written or approved by the user | In its first message |
| Memory | Short lasting facts: preferences, conventions, decisions and why, gotchas | An index in its first message, one line per entry; full entries on request |
| Knowledge | Longer write-ups: research, investigations, test instructions | Listed in the index, read on request |
| Board | `notes.md`, as today | Read on request |
| History | One summary per finished child: its task, how it ended, its diff stats, its last result | The coordinator searches it |

- History is written by plxd when a child ends, from the run's row and last result, as 0025's summaries are. It costs no tokens.
- Only lasting facts are memory. What a child did today is history, not memory.

### Scopes

| Scope | Holds | Folder |
| --- | --- | --- |
| You | Preferences across every Project and thread | `context/you` on the host |
| Repo | Facts about one codebase, shared by its Projects and threads | `context/<repo id>`, as today |
| Project | The brief, decisions, knowledge, board, and history | `context/<project id>`, as today |

- An entry can be promoted from Project to Repo to You. One the whole team should know can be offered as an `AGENTS.md` change through a child's PR, since memory is personal and `AGENTS.md` is shared.

### Format

- One Markdown file per entry, `memory/<kind>/<slug>.md`, whose first lines are its kind, title, source (the run or message it came from), date, and writer. Knowledge is `knowledge/<slug>.md`, the brief `brief.md`, and history `history/<run id>.md`. `proposals/<slug>.md` holds both kinds of proposal (PLX-405): in a Project's folder, a child's, which names the scope it is for and waits there until the coordinator's next wake-up carries it, and in a repo's folder, a plain thread's, which waits for the user. Files keep 0005's mirroring and let the user edit them anywhere. The context folder accepts these folders, where today it takes only one flat file name.
- The index is built by plxd from the entries' titles: You, then Repo, then Project, capped at 8 KiB. Over the cap, it ends with a note to read the rest, and the coordinator's next wake-up asks it to merge entries.

### Who writes

- **Children propose, the coordinator curates.** A child has `memory_read` and `memory_propose`. A proposal waits until the coordinator's next wake-up, where it dedupes, checks it against existing entries, and writes with `memory_write` or drops it. This replaces last-writer-wins for memory.
- **Children reach memory only through the tools.** Unlike 0005, plxd gives a child neither the folder's path nor an allowed directory for it. A child in Bypass that finds the folder under plxd's data folder anyway isn't stopped, as 0043 says of pushes.
- **Plain threads** get `memory_read` and `memory_propose` for their repo's scope through 0041's host-wide MCP, but no index in their first message, which stays the user's own (0034). A plain thread's proposals go to the user in the Memory tab. A coordinator curates only its own children's proposals, at any scope.
- **The user** edits and deletes any entry directly.
- **Corrections reach running children.** Changing or deleting an entry sends each running child of the affected Projects a queued message (PLX-370) naming the change.
- **Stale entries.** After each landing ([0045](0045-integration-branch.md)), plxd checks the paths entries name in backticks against the integration branch, and marks an entry naming a missing one for review.

### The Memory tab

- The Brief, then entries grouped as Preferences, Conventions, Decisions, and Gotchas, then Knowledge. Each shows its scope and source, and can be edited, promoted, or deleted.
- A box takes a change in plain words ("we moved off Jest, use Vitest"). It goes to the coordinator, whose rewrite comes back as a proposal the user saves or discards.
- The inbox's Learned lists what changed since the user last looked.

## Consequences

- A child's first message grows by the brief and up to 8 KiB of index.
- Curation costs coordinator turns. A proposal waits for the next wake-up before it reaches other children.
- Memory is per host until worker hosts mirror it ([0046](0046-project-scheduler.md)), and You is not shared across hosts or devices yet.
