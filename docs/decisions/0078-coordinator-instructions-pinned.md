# 0078: The coordinator's instructions are pinned

- Status: accepted; amends [0024](0024-coordinator-chat.md)'s "Its first message"
- Date: 2026-10-23
- Issue: PLX-935

## Context

[0024](0024-coordinator-chat.md) put `coordinator.md`, the repository's path, and the Project's autonomy level ([0043](0043-project-inbox-and-autonomy.md)) ahead of the user's first message. A resume sends only the new text. Once the provider compacts the conversation, the rules survive only as the provider's summary of that first message: never edit files, the autonomy level, and the board format. A coordinator meant to run for weeks compacts many times.

## Decision

- Every CLI process of a coordinator's run gets its instructions in the backend's system-prompt channel: the first process, every resume, a handoff to another backend, and a restart after a revert. plxd builds them before each process from `coordinator.md`, the repository's path, and the Project's autonomy as it is then. `RunRequest::instructions` carries them, and only a coordinator sets it.
- Per backend:
  - Claude Code: `--append-system-prompt-file`, a file in plxd's data folder's `tmp/` that the run deletes when it ends. The CLI keeps one addition, so a thread that also gets the math format gets both in it, joined. A file, not `--append-system-prompt`, because Rust refuses a newline in an argument to a `.cmd` shim, as npm installs Claude Code on Windows.
  - Codex: `developerInstructions` on `thread/start`, `thread/resume`, and `thread/fork`. The fallback `thread/start` after a failed resume reuses them.
  - `OpenCode`: `system` on every `prompt_async`, which `OpenCode` adds to its own system prompt for that message.
  - ACP agents and Cursor: neither has a channel that adds to the agent's own prompt. ACP has none, and Cursor's `systemPrompt` replaces its whole harness prompt and is gated on the server. They get the instructions ahead of each process's first message instead.
- A coordinator's first message is the user's own text, or the handoff text on a backend switch.

## Consequences

- A compacted or resumed Claude, Codex, or `OpenCode` coordinator still has its rules.
- A change of autonomy reaches the coordinator from its next process. Each wake-up still names the level as it is then.
- Sessions started before this keep their old first message. They get the pinned instructions from their next process, and the duplicate is harmless.
- Claude Code 2.1.309 records a conversation's system prompt on its first request and resends that record on every resume until the conversation compacts (`--system-prompt-snapshot`, on by default). So on Claude, a session started before this and a change of autonomy reach the system prompt only after the next compaction. Compaction, the case this record is for, is covered.
- On ACP agents and Cursor, a compaction inside one long process can still drop the instructions until the next process starts.
