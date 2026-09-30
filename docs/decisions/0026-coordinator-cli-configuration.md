# 0026: The coordinator loads its CLI's own configuration

- Status: accepted; supersedes in part [0004](0004-subscription-providers.md) (the coordinator's no-write flags), [0019](0019-coordinator-mcp-tools.md) (the coordinator's allowlist), and [0024](0024-coordinator-chat.md) (the coordinator's flags and settings sources)
- Date: 2026-09-29
- Issue: RYA-188

## Context

The coordinator ran 0004's no-write command plus wispd's MCP server (0019), in its own worktree (0024): `--tools Read,Glob,Grep --setting-sources user --strict-mcp-config --permission-mode dontAsk`, `--settings` with hooks off and RYA-176's temp-folder read denies, `--allowedTools` naming wispd's eight tools, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. So it couldn't use the user's MCP servers (Linear, say), skills, plugins, hooks, or Claude Code's own subagents. Ryan wants agents to do more on their own, with the configuration he gets when he runs `claude` in a terminal: user settings, and the repository's too (its `.mcp.json`, `.claude/settings.json`, and project skills).

The coordinator has one invariant: it can't edit files or run commands through its CLI's tools. Nobody can answer a permission prompt in `-p` mode, so every other tool must run without one.

## Decision

### Claude Code

A coordinator is a no-write run with wispd's MCP tools attached (`RunRequest::coordinator_tools`). It runs, in its worktree (0024):

```sh
claude -p --output-format stream-json --verbose --input-format stream-json \
  --permission-mode bypassPermissions \
  --disallowedTools Edit,Write,NotebookEdit,Bash,Monitor,EnterWorktree \
  --settings '{"permissions":{"deny":["Read(//tmp/claude-<uid>/**)","Read(//private/tmp/claude-<uid>/**)"]}}' \
  --mcp-config '{"mcpServers":{"wispd":{...}}}' \
  [--model <m>] [--effort <e>] [--resume <id>]
```

- **Everything else loads.** There is no `--tools`, `--setting-sources`, or `--strict-mcp-config`, and `--settings` carries only RYA-176's deny rules, so hooks are on. User, project, and local settings, hooks, skills, plugins, subagents, and MCP servers all load: the user's servers, the repository's `.mcp.json`, and plugins' servers. `--mcp-config` adds wispd's server to them instead of replacing them, now that strict mode is off. The project's files are the worktree's, so they are the repository's committed `HEAD`. Uncommitted or ignored ones, such as `.claude/settings.local.json`, don't load.
- **`--disallowedTools`** is a set of deny rules. A bare tool name removes the tool from the model's context [1]. Deny rules block in every permission mode, `bypassPermissions` included [2]. A PreToolUse hook that returns "allow" can't override one [3]. Built-in subagents inherit the parent's permission rules [4], so a Task or Agent subagent the coordinator starts can't use those tools either.
  - The list is the tools that edit files or run commands. `Monitor` is on it because it runs a command in the background. It follows Bash's rules [7], but naming it removes it outright. `EnterWorktree` is on it because it runs `git worktree add`.
  - `Glob` and `Grep` come back without `Bash`, since Claude Code leaves them out of the default set only when Bash is present [1].
- **`bypassPermissions`** approves every other tool. Allow rules can't do this:
  - A glob is accepted only after a literal `mcp__<server>__` prefix. An unanchored `*` or `mcp__*` "is skipped with a warning and doesn't auto-approve anything" [3].
  - wispd doesn't know the names of the user's, the repository's, or plugins' servers.

  With bypass, allow rules have no effect [2], so `--allowedTools` is gone, and with it `mcp::ALLOWED_TOOLS`. RYA-176's deny rules still hold.
- **No `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.** With the flag on, Claude Code 2.1.283 forces permission mode `default`, whatever `--permission-mode` says (Evidence). In `-p` that denies every tool no allow rule names, which would be every third-party MCP tool.
  - So wispd doesn't set it for a coordinator, of either account kind. It stays in `SCRUBBED_VARS`, so the coordinator doesn't inherit it from wispd either.
  - The scrub added little here: the coordinator now loads hooks and MCP servers that already run unsandboxed on the host.
  - The cost is that an API key account's `ANTHROPIC_API_KEY` is visible to those subprocesses, as it is in a terminal `claude` session.
  - A no-write run without wispd's tools keeps 0004's flags and the scrub unchanged.
- **Second check on `system/init`.** A coordinator whose init lists any of the six denied tools fails with `policyViolation`, and every other tool is accepted. So does one whose `permissionMode` isn't `bypassPermissions`, which is how a scrub flag set by managed settings shows up; the run fails loudly instead of silently denying every MCP tool. The `apiKeySource` and `modelUsage` checks, and all credential scrubbing (`SCRUBBED_PREFIXES`, `SCRUBBED_VARS`), are unchanged.

### Other backends

Codex's coordinator (RYA-39), and any later one, follows the same rule: its CLI's own default configuration, user and repository, with only the write and shell tools taken away and nothing left to prompt.

### Workers

Workers stay on 0013 (`--restricted`, a fixed `--tools`, `--strict-mcp-config`, and `worker_settings`), because loading user and repository settings would let them widen wispd's sandbox. `--settings` beats settings files only for scalar keys, and array keys merge across every scope [5][6]:

- `sandbox.excludedCommands` in a repository's `.claude/settings.json` takes matching Bash commands out of the sandbox. `allowUnsandboxedCommands: false` doesn't stop it: "every command Claude runs must be sandboxed or appear in `excludedCommands`" [6]. wispd's own `Bash` allow rule then approves them.
- `sandbox.filesystem.allowWrite` and `allowRead` add write paths and re-open denied reads. Only managed settings can lock `allowRead` down (`allowManagedReadPathsOnly`) [6].
- In `-p`, workspace trust gates only a repository's `permissions.allow` and `additionalDirectories`, not the sandbox arrays [3].
- The user's own settings can add `additionalDirectories` and `Edit(...)` allow rules, which the sandbox makes writable, and can set `filesystem.disabled` or `allowAppleEvents`.

A follow-up will run the whole worker CLI inside a wispd-owned Seatbelt or bubblewrap profile, so that settings files can't widen what it may touch. Workers can then load their CLI's configuration too.

## Consequences

- A coordinator can use Linear, skills, plugins, and subagents, and anything else its user's or repository's configuration adds.
- **Tradeoff: its hooks and MCP servers run on the host, outside any sandbox,** the repository's included. A repository's `.mcp.json` servers connect without asking, and its hooks and `env` block apply in `-p` [3]. That reopens, for the coordinator, what #134 closed.
  - A repository's `env` block can set `ANTHROPIC_BASE_URL` and send the account's token elsewhere, which neither `apiKeySource` nor `modelUsage` catches.
  - Its hooks can already run any command as the user, and so can plugins' monitors, which start on their own [7].
  - Run a coordinator only on repositories you'd run `claude` on.
- The "no writes" invariant covers Claude Code's own tools only. An MCP server, a hook, or `DesignSync` (which writes to claude.ai design projects) can write elsewhere. 0024's `git status` check around each turn still catches writes inside the coordinator's worktree, but not ignored files or anything outside it. A repository hook that writes there, such as a formatter on Stop, now stops the turn with `policyViolation`, and the next process's refresh discards the write.
- Tools that are neither denied nor reviewed now reach the coordinator, such as `CronCreate`, `ScheduleWakeup`, `SendMessage`, `PushNotification`, and `Workflow`. What they can start in a `-p` session wasn't examined. A new built-in that writes or runs commands needs adding to `COORDINATOR_DENIED_TOOLS`.
- Managed settings that disable `bypassPermissions`, or set the scrub flag, stop every coordinator with `policyViolation`. That is deliberate.
- A plain no-write run and every worker are unchanged, and so are their tests.
- The coordinator's mode is still fixed, so the app still offers no Access choice for it (0024). Choosing its mode is the permission picker's work.

## Evidence

- **Flags.** Checked in the CLI reference [1] and in `claude --help` for the installed Claude Code 2.1.283: `--disallowedTools`, `--mcp-config`, `--permission-mode`, `--settings`, and `--strict-mcp-config`.
- **Probe.** On 2026-09-29, on macOS 27.0 with Claude Code 2.1.283. The runs used `env -i` with a throwaway `CLAUDE_CONFIG_DIR` and git repository, a dummy `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, a dead address, so nothing reached Anthropic. Claude Code writes `system/init` before its first request.

  | Flags | Scrub | `permissionMode` |
  | --- | --- | --- |
  | `--permission-mode bypassPermissions --disallowedTools Edit,Write,NotebookEdit,Bash` | unset | `bypassPermissions` |
  | same | `1` | `default`, with "Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set" on stderr |
  | `--permission-mode dontAsk`, same deny list | `1` | `default`, same warning |
  | the command above, with `--settings` and the six-tool deny list | unset | `bypassPermissions` |

  With the six-tool deny list, `tools` was `Task`, `CronCreate`, `CronDelete`, `CronList`, `DesignSync`, `ExitWorktree`, `Glob`, `Grep`, `ListAgents`, `PushNotification`, `Read`, `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `TaskStop`, `WebFetch`, `WebSearch`, and `Workflow`, and it had none of the denied tools. Without `Monitor` on the list, `Monitor` appeared. Without any deny list, `Bash`, `Edit`, `Write`, and `NotebookEdit` appeared, and `Glob` and `Grep` didn't.
- **Not tested:** a real coordinator turn that calls a denied tool through a subagent, or a third-party MCP tool, against a live or fake API. The subagent and hook behavior above rests on the docs.
- **Sandbox widening.** The findings under Workers come from the docs [3][5][6]. `claude sandbox status` doesn't print the merged arrays, so a run didn't confirm them.
- **History.** A wisp coordinator first wrote this change on `wisp/e837bee4` against a checkout that predated 0024. RYA-188 ported it onto `develop`, kept RYA-176's deny rules, and added `Monitor` to the deny list.

## Sources

Read on 2026-09-29, as raw Markdown (`.md` appended to each page URL).

1. Claude Code CLI reference (`--disallowedTools`, `--tools`, `--mcp-config`, `--strict-mcp-config`): https://code.claude.com/docs/en/cli-reference
2. Claude Code permission modes ("Deny rules block in every mode, including `bypassPermissions` ... Allow rules have no effect in `bypassPermissions`"; root and `disableBypassPermissionsMode`): https://code.claude.com/docs/en/permission-modes
3. Claude Code permissions (tool name wildcards, hooks and deny rules, "What runs before you trust a folder"): https://code.claude.com/docs/en/permissions
4. Claude Code subagents (built-in subagents inherit the parent's permission rules): https://code.claude.com/docs/en/sub-agents
5. Claude Code settings ("Lists merge instead of overriding"; `--settings` takes precedence per key): https://code.claude.com/docs/en/settings
6. Claude Code sandboxing and settings reference (`excludedCommands`, `allowUnsandboxedCommands`, `filesystem.allowWrite`, `allowRead`, `allowManagedReadPathsOnly`, `filesystem.disabled`): https://code.claude.com/docs/en/sandboxing, https://code.claude.com/docs/en/settings-reference
7. Claude Code tools reference (`Monitor` runs a command in the background under Bash's permission rules; plugin monitors; `PushNotification`; `Workflow`): https://code.claude.com/docs/en/tools-reference
