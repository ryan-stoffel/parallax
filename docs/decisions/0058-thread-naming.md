# 0058: plxd names threads with the user's own model

- Status: accepted
- Date: 2026-10-08
- Issue: PLX-610

## Context

The app named a new thread and its branch with Qwen 2.5 0.5B, run on this computer through node-llama-cpp (PLX-152, PLX-156). The model was a 469 MB download into `userData/models`, loaded at every launch, and node-llama-cpp added 53 MB to the installed app. `thread/start` waited up to 2 s for a name. Ryan asked to name threads the way T3 Code does: with a small model on the user's own provider, Codex `gpt-6-luna` at low effort by default.

T3 Code's server owns naming. The thread starts at once under a temporary branch. The server then asks a text-generation model for a title and a branch name in the background, and renames the branch. Runs of both CLIs on 2026-10-08 (Claude Code 2.1.288, codex-cli 0.160.0) answered in 7 to 8 s:

- `claude -p --output-format json --json-schema <schema>` prints one `result` message holding the answer as `structured_output`. A signed-out CLI exits 0 with `is_error` and the reason in `result`.
- `codex exec --json --output-schema <file>` prints its events a line each. The answer is the text of an `agent_message` item, and a refused model ends with `turn.failed`.

## Decision

- **plxd names the thread**, since it runs the provider CLIs on the host, local or over SSH. `thread/start` takes `naming` (`backend`, `model`, `effort`) behind the `threadNaming` capability. It returns as soon as the thread has started. The thread starts on the branch the app named from the prompt's first words (`branchSlug`), with no title.
- **One call, two names.** A background task on the runner's tracker asks the model once for JSON `{title, branch}`. The prompt has T3 Code's rules for a new thread's title, without those about tools and attachments, plus its rules for a branch fragment. The user's message is cut to its first and last 4,000 bytes. The call is capped at 60 s and dropped when plxd stops.
- **Which model.** The chosen instance's model goes first. When that instance isn't on the host, can't name threads (only Claude Code and Codex can), or its call fails, the default model of the thread's own instance goes next: `claude-haiku-4-5` for Claude Code and `gpt-6-luna` for Codex, at low effort. If both fail, plxd only logs it, and the thread keeps its first name.
- **The call** runs on the instance's own login, as `agent/commands` and `usage/limits` do: its program and variables, its home as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and plxd's scrubbed environment. It runs in a new folder in plxd's `tmp/`, with the prompt on stdin.
  - Claude Code gets no tools, slash commands, MCP servers, or hooks, and `dontAsk`.
  - Codex runs `exec --ephemeral --skip-git-repo-check -s read-only`. It gets only the instance's program and variables, since the instance's arguments are `app-server`'s.
- **Applying it.**
  - The title is cleaned to one line under the title cap. It is set only while the thread has none, so a rename by the user wins, and is sent as `thread.updated`.
  - The branch name becomes a branch slug (lowercase words joined by hyphens, at most 40 bytes). The run's actor renames the branch to it, so the rename never races the run's own commits.
  - The rename uses `create_named`'s rules: `parallax/<slug>`, with the short run id after it when the name is taken. It happens only while the branch has no upstream (`branch.<name>.merge` unset) and no push or Open PR is running.
  - The store's worktree row and the actor's copy take the new name, and `agent.updated` carries it as `branch`, which is absent from every other `agent.updated`.
- **The app** sends `naming` from Settings > General > Naming model: any Claude Code or Codex model, defaulting to Codex `gpt-6-luna` at low effort. node-llama-cpp is gone from the app and its package. On launch, after the window opens, the app deletes `userData/models`.

## Consequences

- A new thread starts without waiting. Its title and branch name arrive about 10 s later, and before that it shows its prompt.
- Each new thread costs one small call on the user's own plan. It runs on the provider's servers, not on this computer.
- An older plxd lacks `threadNaming`, so the app sends it no `naming`. Its threads keep the branch named from the prompt's words and get no title.
- A thread on an API key account is named on its instance's login, which may not be signed in. Then it keeps its first name.
- If the store fails right after git renamed the branch, git and the row disagree, and Accept and worktree cleanup miss the branch.
