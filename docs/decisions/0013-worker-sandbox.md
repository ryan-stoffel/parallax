# 0013: The worker sandbox

- Status: accepted; the Linux sandbox is under [Claude Code on Linux](#claude-code-on-linux) (PLX-20), Codex workers are under [Codex](#codex) (PLX-38), and the refusal of Claude workers on native Windows is in [0023](0023-cross-platform.md); a worker in Bypass Permissions runs without it since [0027](0027-claude-permission-modes.md); a worker in Plan whose client answers permission requests also gets `ExitPlanMode` since [0031](0031-permission-requests.md#plan-mode-and-exitplanmode) (PLX-243); a worker's todo tools include Claude Code's task tools since PLX-248, and every run keeps its session's own task list since PLX-251 (both under [Claude Code](#claude-code)); a normal thread whose client answers permission requests runs without it in every mode since [0034](0034-threads-are-full-claude-code.md); a Project's children run without it since [0042](0042-project-children-are-threads.md), and Codex's `codex exec` worker is gone since PLX-396
- Date: 2026-09-25
- Issue: #137

## Context

M3 runs the first real workers: a vendor CLI in a git worktree with the `workspace-write` policy (0004). Until now that policy was Claude Code's `--permission-mode acceptEdits` alone, which is not a sandbox (#137):

- The read-only commands (`cat`, `grep`, `git log`, ...) run on any path. Every other command would prompt, and `-p` denies it, so a worker couldn't run `cargo test` or `npm test`.
- Worker runs loaded the project's settings. A repository's `env` block could redirect the credentials a run is billed to, or send an API key's traffic to another host (#134). Its hooks ran, and `-p` connected its `.mcp.json` servers without asking [3].

Codex and Cursor each have their own sandbox, and #156's runner needs one contract across all three. This record sets the contract and the flags that enforce it. Evidence is from the vendors' docs, read as raw Markdown on 2026-09-25, and from local experiments that need no vendor account (Evidence below). No real Claude run was made.

Ryan decided three tradeoffs on #137, and they are part of this record: worker commands get network access, workers get web search and web fetch, and reads are limited by a denylist rather than by denying the whole home folder.

## Decision

### The contract

A worker is a vendor CLI running headless in its own worktree (#154). The same limits apply to every backend:

| | A worker may | A worker may not |
| --- | --- | --- |
| Write | Its worktree; the project's shared context folder (0005); its own temp folder, which plxd makes for each CLI and removes when it exits ([below](#the-runs-temp-folder)) | Anything else. This includes the worktree's `.git` file and the repository's git folder, so plxd makes every commit (0004); another run's temp folder and the `/tmp/claude-<uid>` every Claude Code session shares; and the paths Claude Code's sandbox would always allow (`/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`) |
| Read | The whole disk | plxd's data folder, except its own worktree and context folder; every other run's temp folder; `/tmp/claude-<uid>`; every path in `UNREADABLE_IN_HOME` and this OS's `UNREADABLE_IN_HOME_ON_THIS_OS` (`daemon/src/backend/sandbox.rs`); and on Linux, the user's runtime folder. Those lists cover keys and the Keychain folder; cloud, container, and infrastructure credentials; git and git-host credentials, including Copilot's token; package-registry and database credentials; password managers (`pass`, 1Password, Bitwarden); shell and REPL histories, including `~/.zsh_sessions`; browser profiles and cookies (Safari, Chrome, Firefox, Arc, Brave, Edge); and the agent CLIs' own folders |
| Execute | Any command, inside the vendor's OS sandbox (Seatbelt on macOS, bubblewrap and seccomp on Linux) | Anything outside it: no unsandboxed retries, no hooks, no MCP servers, no repository-supplied settings |
| Network | Any public host, from commands and from the web search and fetch tools (Ryan, #137) | This Mac's loopback and unspecified addresses (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, `[::]`), until #168. Not this Mac's interface addresses: see the threat model |

`WorkerSandbox` (`daemon/src/backend/sandbox.rs`) carries the paths. Every backend refuses a `workspace-write` run in any of these cases, with an error that names the problem:

- it has no sandbox, or its sandbox has nothing unreadable;
- a sandbox path, its cwd, or its account's configuration folder is relative or not UTF-8;
- any of those paths holds `*`, `?`, `[`, or `]`. The vendors read those as wildcards, so a deny rule for a folder such as `~/src/app[old]/.git` would not match it and would fail open [4][13].

### The run's temp folder

A vendor CLI's default temp is shared. Claude Code's is `/tmp/claude-<uid>`, the same folder for every Parallax run and every interactive session of the user, and its sandbox let a worker read and write it (PLX-122): background task output of other sessions sat there, and pnpm quietly made a 249 MB package store there that every later worker reused. So each worker's CLI gets its own folder (PLX-130):

- **Where.** `/tmp/parallax-<hash>/<6 random characters>`, 0700. `<hash>` is the socket fallback's (0023), so every plxd has its own root, and a sweep can't reach another plxd's live runs. `/tmp` is shared, so the root must be a real folder that this user owns with mode 0700; anything else there refuses the worker and names the folder. When `/tmp` can't be written at all, as inside a worker's sandbox running plxd's own tests, the root is `parallax-<hash>` in `$TMPDIR` instead.
- **Why so short.** Claude Code 2.1.283 gives a command `$CLAUDE_CODE_TMPDIR/claude-<uid>` as its `TMPDIR` only when that path fits in 44 bytes, and the shared `/tmp/claude-<uid>` otherwise. The data folder, and macOS's per-user `DARWIN_USER_TEMP_DIR` (49 bytes on its own), are too long. `/tmp/parallax-xxxxxxxx/xxxxxx/claude-<uid>` is at most 43 bytes for any 32-bit uid. It also keeps PLX-128's socket tests under `$TMPDIR` when they run in a worker. Linux's `$XDG_RUNTIME_DIR` was rejected: it is in memory, and PLX-107 wants it unreadable.
- **When.** The runner makes the folder before the CLI starts, a resumed run's too, and removes it when the run's CLI has exited, however it ended: done, failed, cancelled, deleted, or plxd stopping. A failed start removes it at once. A root goes with the last folder in it. `serve` removes every run's folder and its roots at startup, under its instance lock, along with what a crash left in the data folder's `tmp/` (PLX-126's `CLAUDE_ENV_FILE`).
- **The sandbox.** `WorkerSandbox::temp` carries the folder, and its root and `/tmp/claude-<uid>` are in `unreadable`. A backend points the vendor's temp setting at the folder, so its commands' `TMPDIR` is the folder or one inside it. The CLI keeps files of its own there too, such as Claude Code's messaging socket, so commands may use only their `TMPDIR`.
- **Claude Code.** The CLI gets `CLAUDE_CODE_TMPDIR` set to the folder, spelled `/tmp/...` on macOS, 8 bytes shorter than its canonical `/private/tmp/...`; the settings use the canonical path. Commands get `<folder>/claude-<uid>`, which Claude Code's sandbox lets them write, and which the settings add to `allowRead`; the rest of the folder stays hidden. (Allowing reads of the whole folder instead made bubblewrap mount `claude-<uid>` read-only on Linux.) `denyWrite` takes back the paths the sandbox always allows, which a deny rule beats. A folder whose `…/claude-<uid>` would pass 44 bytes refuses the worker, so Claude Code never falls back to the shared one.
- **The CLI's own `TMPDIR` stays plxd's.** Claude Code keeps its sandbox's Linux proxy bridges (`claude-http-*.sock`, `claude-socks-*.sock`) there, and Node's compile cache. With `TMPDIR` in the run's folder, the bridges were hidden, and a command's `curl` failed with `Proxy CONNECT aborted` (PLX-107). Opening the folder to commands instead would let them write a compile cache that an unsandboxed process loads later.
- **`CLAUDE_ENV_FILE` stays in the data folder's `tmp/`.** Claude Code runs it before every command, so it must stay where no command can read or write it. Commands write `<folder>/claude-<uid>`.
- **Package caches.** A package manager whose cache folder a worker can't write may fall back to `$TMPDIR`, as pnpm did. That now lands in the run's folder and goes with it. Per-run caches on purpose are PLX-129's.

### Threat model

With network on, anything a worker's commands can read, they can send anywhere. So the read denylist, not the network, is what keeps secrets on the machine:

- **What stays in.** The paths in the list; plxd's data folder, which holds other projects' context, the store, and the log; and what other runs and other Claude Code sessions leave in their temp folders. Credentials in the environment stay in too: a worker's CLI inherits only an allowlist of plxd's environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `LC_*`, `TERM`, and the proxy and CA variables; 0014), so tokens such as `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY` that plxd was started with never reach it, and the sandbox unsets the two credentials Claude Code itself holds, an API key account's `ANTHROPIC_API_KEY` and `CLAUDE_CODE_MESSAGING_TOKEN`, for every command (`sandbox.credentials`, below).
- **What can leave.** The worktree's own source, which the vendor's model sees anyway, and any secret the list doesn't name. That includes `.env` files in other projects and credentials a tool keeps somewhere we didn't list. It also includes another account's configuration folder, if one lives outside the data folder: only the run's own account's is denied. The vendors have no built-in list [1], so new entries go in `UNREADABLE_IN_HOME`.
- **What comes in.** Fetched pages, search results, and downloaded packages can carry prompt injection or malicious code. They run inside the same sandbox as everything else, so their reach is the same as the agent's own.
- **This Mac's own services** (databases, Docker's published ports, dev servers) are a larger target than any one remote host, so its loopback and unspecified addresses are denied to commands and to WebFetch alike. The sandbox's proxy canonicalizes other spellings of loopback (`127.1`, `[::ffff:127.0.0.1]`) and refuses names that resolve to this Mac, but it doesn't check IP literals [13]. So `0.0.0.0` and `[::]` are listed explicitly.
- **Gap: this Mac's interface addresses (Claude workers).** A service bound to `0.0.0.0` also listens on the Mac's LAN address, such as its Wi-Fi IP, and a worker that uses that literal address reaches it. Parallax doesn't list those addresses, because they change with the network during a run. Other machines on the LAN are reachable too, since network access is on. #168 decides whether to enumerate the Mac's addresses at run start or to accept the gap. Codex workers don't have it: Codex's proxy refuses private addresses, this Mac's and the LAN's alike (see [Codex](#codex)).

### Claude Code

Claude Code sandboxes Bash with Seatbelt on macOS. Its sandbox restricts writes to the working directories and the session temp folder, reads by `denyRead` rules, and network by a proxy with a domain allowlist [1]. A worker runs:

```sh
claude -p --output-format stream-json --verbose --input-format stream-json \
  --restricted \
  --tools Read,Edit,Write,Glob,Grep,NotebookEdit,Bash,WebFetch,WebSearch,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate[,ExitPlanMode] \
  --strict-mcp-config \
  --permission-mode acceptEdits|plan \
  --settings '<worker_settings>' \
  --add-dir <shared context folder> \
  [--model <m>] [--effort <e>] [--resume <id>]
```

`worker_settings` (`daemon/src/backend/claude.rs`) is:

```json
{
  "disableAllHooks": true,
  "permissions": {
    "allow": ["Bash", "WebFetch(domain:*)", "WebSearch"],
    "deny": ["WebFetch(domain:localhost)", "WebFetch(domain:127.0.0.1)", "WebFetch(domain:[::1])",
             "WebFetch(domain:0.0.0.0)", "WebFetch(domain:[::])"]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "network": {
      "strictAllowlist": true,
      "deniedDomains": ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"],
      "allowLocalBinding": false
    },
    "filesystem": {
      "denyRead": ["<unreadable paths>", "<the account's CLAUDE_CONFIG_DIR, if any>"],
      "allowRead": ["<worktree>", "<shared context folder>", "<git paths>", "<run's temp folder>/claude-<uid>"],
      "denyWrite": ["<worktree>/.git", "<repository git folder>",
                    "/tmp/claude", "/private/tmp/claude", "~/.npm/_logs", "~/.claude/debug"]
    }
  },
  "env": {"CLAUDE_CODE_TASK_LIST_ID": ""}
}
```

- **`--restricted`** loads only managed settings and `--settings`. It skips the user, project, and local settings files, so a repository can't add allow rules, directories, hooks, or an `env` block. It also confines the file tools to the working directories, and it removes the command tools and WebFetch unless `--tools` names them [2]. It needs Claude Code 2.1.248 or later (`WORKER_MIN_VERSION`). We chose it over `--setting-sources user`, which would still merge the user's own sandbox arrays and allow rules into a worker's [1].
- **`--tools`** is an explicit list. `Bash` is on it and in `permissions.allow`, so it stays allowed if managed settings force permission mode `default`, where Claude Code 2.1.283 ignores `autoAllowBashIfSandboxed` and would deny Bash before the sandbox runs (PLX-110, PLX-112). The OS boundary holds whatever the command string says [1]. Argument patterns such as `Bash(npm test *)` are fragile by the vendor's own account [3], and the sandbox makes them unnecessary. The list leaves out `Agent`, `Skill`, `Monitor`, and every MCP tool. Leaving out `Skill` and `Agent` also means a repository's skills and subagents can't be invoked. A worker in Plan whose client answers permission requests also gets `ExitPlanMode`, which hands its plan to the app and runs nothing ([0031](0031-permission-requests.md#plan-mode-and-exitplanmode), PLX-243). Every other worker's list is exactly the one above.
- **The todo tools and the task list (PLX-248).** `TodoWrite` and Claude Code's four task tools, `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`, keep the agent's plan, which the app shows as its plan card. Claude Code 2.1.283 offers one set or the other, never both: the task tools, unless `CLAUDE_CODE_ENABLE_TASKS` is `false`, which brings `TodoWrite` back. It offers either set only to a built-in list of older models (Claude 3.x, Opus 4.0 to 4.7, Sonnet 4.0 to 4.6, Haiku 4.5), or when `--tools` or `--allowedTools` names one of the tools, or with `CLAUDE_CODE_ENABLE_TODO_TOOLS`. A worker's `--tools` names both sets, so it gets one on any model. Before PLX-248 it named only `TodoWrite`, which 2.1.283 turns off, so a worker had no todo tool at all. A coordinator, and a worker in Bypass Permissions, have no `--tools` list, so they name the same five tools in `--allowedTools`, which turns them on in the same way ([0027](0027-claude-permission-modes.md#the-todo-tools), PLX-249).
  - **Where the list lives.** The task tools run in the CLI's own process, not through Bash. They write `<configuration folder>/tasks/<session id>/<id>.json`, with a `.lock` and a `.highwatermark` that keeps ids from being reused, so in `~/.claude` or the account's `CLAUDE_CONFIG_DIR`, outside the worktree. That is where the CLI already keeps the session's transcript, and PLX-244's plan file. The list is the session's, so it lasts across turns and `--resume`. A delete removes the task's file.
  - **The list stays the session's (PLX-251).** 2.1.283 takes the list's name from `CLAUDE_CODE_TASK_LIST_ID` when it is set and not empty, before the session id. Every session with the same value then shares one list, other threads and the user's own Claude Code sessions included, so a run could read, change, or delete their tasks, and it has network access to send them out. The CLI turns the name into letters, digits, `-`, and `_` before it builds the path, so it can't reach outside `tasks/`. plxd's own environment can't pass the variable: the agent environment is an allowlist ([0014](0014-agent-runs.md)), and `SCRUBBED_VARS` drops it too. The CLI also copies into its own process the `env` of, in order: its global config (`.claude.json` in the configuration folder), which even `--restricted` reads, so it reaches every run; the user's, the project's, and the local settings, which reach a coordinator and a worker in Bypass Permissions ([0027](0027-claude-permission-modes.md)); `--settings`; and managed settings. So every run's `--settings` sets the variable empty, which 2.1.283 treats as unset, and that beats all but managed settings. The CLI keeps only the last `--settings`, so each run gets one: a worker's and a plain no-write run's hold it next to their other settings, and a coordinator's and a bypass worker's hold only it. Managed settings still pick the list for every run. That is the administrator's choice, as with the rest of managed settings: nothing a run is given can override it, and plxd can't read every managed source (server-managed settings, `policyHelper`, MDM) to refuse it.
  - **The sandbox holds.** `--restricted` doesn't confine these writes, since they are the CLI's own and not a file tool's, but they reach only the session's own list. The configuration folder is in `denyRead` (`.claude` in `UNREADABLE_IN_HOME`, and the account's `CLAUDE_CONFIG_DIR`) and isn't writable by commands, so a worker's command can neither read the list, its own or another session's, nor forge one. The files hold only what the model passed the tools. `TodoWrite` keeps its list in memory only.
- **Network.** The sandbox takes its allowlist from `allowedDomains` and from `WebFetch(domain:...)` allow rules, and it honors a bare `*` in those rules [1]. So `WebFetch(domain:*)` opens every host to commands and approves WebFetch; `WebSearch` approves search. `strictAllowlist` makes any host outside the list, which is only `deniedDomains`, fail instead of prompting. `deniedDomains` wins over the allowlist, but it binds sandboxed commands only; WebFetch runs in-process and follows permission rules [4]. So each denied host is also a `WebFetch(domain:...)` deny rule, which beats the `*` allow for the tool [3].
- **`failIfUnavailable`** makes a run fail when the sandbox can't start, instead of running commands unsandboxed. **`allowUnsandboxedCommands: false`** ignores `dangerouslyDisableSandbox`, the model's escape hatch [1][4].
- **`--strict-mcp-config`** with no `--mcp-config` connects no MCP servers, including `.mcp.json` [2]. plxd's own MCP tools join in M4.
- **`acceptEdits`**, or **`plan`** when a run asks for the `plan` permission (PLX-97). [0027](0027-claude-permission-modes.md) adds `auto` and `default` (Manual), in the same sandbox, and `bypassPermissions`, which Claude Code refuses under `--restricted`, so a worker in it runs without this sandbox. Plan mode is narrower: its file tools refuse to write, and it still runs commands in the same sandbox, with the same `--settings`. Claude Code 2.1.283 has plan mode check each command with its auto-mode classifier, a model call on the run's account, instead of `autoAllowBashIfSandboxed`. That is not a read-only boundary, only the sandbox is. `acceptEdits` approves the file tools inside the working directories. Writes to the permission system's protected paths (`.git`, `.claude`, `.vscode`, `.husky`, `.mcp.json`, shell startup files, ...) still prompt, and `-p` denies them [5]. That covers the Edit and Write tools only. The sandbox's own protected paths are a shorter list, and `.husky` isn't on it [1]. So a Claude worker's Bash can write `.husky/_/post-commit`, which git would run, outside any sandbox, when plxd commits. #166 is needed for Claude workers too.
- **Temp.** The CLI runs with `CLAUDE_CODE_TMPDIR` set to the run's own folder, so its commands' `TMPDIR` is `<folder>/claude-<uid>`. The paths Claude Code 2.1.283's sandbox lets every command write whatever the settings say (`/tmp/claude` in both spellings, `~/.npm/_logs`, `~/.claude/debug`) are in `denyWrite`, which beats them. See [The run's temp folder](#the-runs-temp-folder).
- **`denyWrite` on git metadata.** In a linked worktree the sandbox would otherwise let commands write the repository's shared git folder, for `git commit` [1]. That would let a worker move any branch, including the user's. plxd commits for every backend instead.
- **Second checks on `system/init`.** A worker whose `system/init` lists a tool outside `WORKER_TOOLS` (and `ExitPlanMode`, for a worker that has it) fails with `policyViolation`, as a no-write run does with anything outside its read tools. So does one whose `claude_code_version` is missing or below `WORKER_MIN_VERSION`, and one whose `permissionMode` is missing or isn't the mode it asked for: `acceptEdits` (`DEFAULT_PERMISSION_MODE`, PLX-118), or the run's other mode (PLX-97, 0027). Claude Code writes `init` at the start of each turn, before its first API request, so plxd kills the CLI before any tool runs.
- **No `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` for workers.** On Linux, Claude Code 2.1.283 answers the flag by merging its CI hardening profile into each command's sandbox: writes open to all of `/home`, `/root`, `/tmp`, `/var`, `/opt`, `/run`, and `/mnt`, and `denyWrite` entries outside those folders are dropped (PLX-20). So plxd sets the flag only for no-write runs other than a coordinator, which have no Bash to widen [14], and drops it from what every run inherits (`SCRUBBED_VARS`), so plxd's own environment can't pass it to a worker. For a worker, `sandbox.credentials.envVars` unsets `ANTHROPIC_API_KEY` and `CLAUDE_CODE_MESSAGING_TOKEN` before each command instead [1]. Managed settings still load under `--restricted`, and their `env` block overrides both plxd's environment and `--settings`. So on Linux, plxd refuses a worker when managed settings set the flag (step 2 of the check under [Claude Code on Linux](#claude-code-on-linux), PLX-112). With the flag on, Claude Code 2.1.283 also forces the permission mode to `default`, whatever `--permission-mode` says. So on every OS, a worker whose own `system/init` reports another mode fails with `policyViolation` (PLX-118). That backs up step 2 from inside the worker's own process, and it covers macOS, where nothing else checks the flag. Those no-write runs aren't checked this way: plxd sets the flag for them, so they always report `default` (PLX-121). A coordinator runs without it and is checked like a worker ([0027](0027-claude-permission-modes.md)).
- **`CLAUDE_CONFIG_DIR` in Bash.** A worker's commands see it. That is harmless, because the folder is in `denyRead`.

**#134, the project `env` gap.** For workers it is closed: `--restricted` reads no project or user settings file, so no repository `env` block reaches the CLI. The existing checks (`apiKeySource` in `system/init`, `modelUsage[*].provider` in `result`) stay as a second line. Managed settings, the `env` of Claude Code's global config, which `--restricted` still reads (PLX-251; what else it can set is PLX-254), and plxd's scrubbed environment are the only remaining sources.

**What a repository can still change for a Claude worker.** Only its `CLAUDE.md`, which is instructions and not configuration: it still loads. Everything else a repository supplies is either not loaded or is used only through a tool the worker doesn't have.

### Claude Code on Linux

On Linux and WSL2, Claude Code sandboxes Bash with bubblewrap and relays its proxy traffic with `socat` [1]. A Linux worker runs the same command with the same `worker_settings` as on macOS. plxd never sets `enableWeakerNestedSandbox`, which bind-mounts the host's `/proc` instead of a fresh one. It never sets `allowAllUnixSockets` either, which would drop the filter below.

- **Reads.** `UNREADABLE_IN_HOME` holds the paths every OS shares, and `UNREADABLE_IN_HOME_ON_THIS_OS` adds Linux's:
  - GNOME Keyring, KWallet, and NSS's `~/.pki`
  - 1Password and Bitwarden
  - Chrome, Chromium, Brave, Edge, and Firefox, with their snap and flatpak folders, since Ubuntu ships Firefox as a snap. Firefox 147 and later, and Thunderbird, keep new profiles in `~/.config/mozilla` instead of `~/.mozilla`, so both are listed
  - the Cursor and Claude apps under `~/.config`

  plxd's data folder, `~/.local/share/parallax` (0023), is denied as on macOS. So is the user's runtime folder, which is outside the home folder (PLX-107). It can hold credentials: rootless Podman, Buildah, and Skopeo keep registry logins in `$XDG_RUNTIME_DIR/containers/auth.json` by default. The seccomp filter below blocks the sockets there, but not the files.
  - **The whole folder, not named files in it.** A list of files would miss the next tool. Claude Code 2.1.283's sandbox keeps nothing a command needs there, as long as the temp folder is outside it. Its proxy bridges (`claude-http-*.sock`, `claude-socks-*.sock`) and its session temp folder are in the temp folder. Its cross-session messaging socket goes in `$XDG_RUNTIME_DIR/cc-socks` when the variable is set, but Claude Code binds it in its own process, outside bwrap. Its own hardened profiles deny `/run/user` to commands too [13].
  - **Which folders.** `WorkerSandbox::for_worktree` denies plxd's `$XDG_RUNTIME_DIR`, and `/run/user/<uid>` and `/run/containers/<uid>` whether or not the variable is set. A worker doesn't inherit the variable (0014), so its tools use their own fallbacks. Most use `/run/user/<uid>`. Podman, Buildah, and Skopeo keep registry logins in `/run/containers/<uid>/auth.json` [16]. A value that isn't absolute is ignored, as the XDG Base Directory spec says. An absolute one that isn't UTF-8 is kept, so the run is refused, as with any other unusable path. Claude Code's sandbox skips a denied path that doesn't exist.
  - **A temp folder inside a denied path is refused.** If the worker's `TMPDIR` (or `/tmp`, when it is unset) is inside any unreadable path, the deny hides the proxy bridges, and commands silently lose the network. So plxd refuses the run and names `TMPDIR`. Allowing the temp folder instead is no fix: when `TMPDIR` is the runtime folder itself, the sandbox drops the deny.
- **The seccomp filter is required.** Without it, a sandboxed command can connect to any Unix socket. That includes the D-Bus session bus that serves the Secret Service, `ssh-agent`, and `docker.sock`. On macOS, Seatbelt blocks them. `failIfUnavailable` doesn't cover the filter, because Claude Code treats it as optional, so plxd checks it itself.
- **Where the filter comes from.** Since 2.1.92, Claude Code ships the filter's helper, `apply-seccomp`, itself [15].
  - The native build compiles the helper into the `claude` binary, and the npm package now installs the native build too.
  - It runs every sandboxed command inside bwrap as `ARGV0=apply-seccomp /proc/self/fd/3 <shell> -c <command>`, where fd 3 is its own binary. That is what the 2.1.283 linux-x64 build does: `seccomp: {applyPath: "/proc/self/fd/3", argv0: "apply-seccomp"}` whenever it runs as a standalone executable [13].
  - `npm install -g @anthropic-ai/sandbox-runtime`, which Claude's docs still suggest, is only a fallback for a build without the helper. So plxd doesn't look for that package: a native Claude never reads it.
- **How plxd checks** (`backend::claude::linux_sandbox::check_host`). Before each Claude worker starts or resumes, after the version check, with no cache:
  1. `bwrap` and `socat` must resolve on the agents' `PATH`, where Claude Code looks for them.
  2. `claude --restricted sandbox status` must show that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is off (PLX-112).
     - Its `autoAllowBashIfSandboxedSource` is `"unsupported"` on Linux exactly when the flag is on. The other values in 2.1.283 are `default`, `settings`, and `policy`.
     - The check fails closed. It accepts only a run that exits 0 and prints `statusVersion` 3 with one of those three values. It refuses everything else: the flag, a non-zero exit, unreadable output, another `statusVersion`, or an unknown value.
     - The command runs with the environment a worker gets, scrubbed the same way (`SCRUBBED_PREFIXES`, `SCRUBBED_VARS`). `--restricted` makes it load the settings a worker loads.
     - Tested: the flag in `/etc/claude-code/managed-settings.json` and in a `/etc/claude-code/managed-settings.d/` drop-in. Assumed, not tested: server-managed settings, a `policyHelper`, and, on WSL, the Windows machine's managed settings. They need an organization or a Windows host. Claude Code's schema says they make up the same managed tier.
     - The command is hidden, but its output is versioned. Version 3, with this field, arrived in 2.1.275, so a Linux worker needs Claude Code 2.1.275 or later.
     - It runs in a separate process from the worker, and can disagree with it (Evidence). The worker's own `permissionMode` check on `system/init` backs it up (PLX-118).
  3. plxd listens on a Unix socket in a temp folder. bwrap runs `socat` to connect to it, with the namespaces Claude's sandbox uses: `--unshare-user --unshare-pid --proc /proc --cap-drop ALL`. The connect must succeed. If bwrap fails and `kernel.apparmor_restrict_unprivileged_userns` is 1, the error names AppArmor.
  4. The same bwrap runs the detected `claude` as `ARGV0=apply-seccomp`, which runs the same connect. The connect must be refused.

  Each failure is `workerUnavailable` and names what is wrong: bubblewrap, socat, the scrub flag, the AppArmor profile, or the filter. The check runs the same binary and helper the worker will use, so it can't pass on a file Claude Code doesn't load. It can't catch a later Claude Code that stops running its helper. `WORKER_MIN_VERSION` and `daemon/tests/sandbox.rs` cover that. CI runs the test against a pinned Claude Code on Linux.
- **Setup.** Install Claude Code 2.1.275 or later, `bubblewrap`, and `socat`. On Ubuntu 24.04 and later, also add the AppArmor profile for `/usr/bin/bwrap` from Claude's docs [1]. WSL1 isn't supported. Nor is plxd running as root: Claude's sandbox adds `CAP_SETFCAP` for uid 0 and the check doesn't, so the check refuses.

### Codex

Codex sandboxes commands with Seatbelt on macOS. Its `:workspace` permission profile writes the workspace roots and the temp folders (`$TMPDIR` and `/tmp`), and it protects `.git` (including the folder a `.git` file points to) and `.codex` [6][7]. Permission profiles, which are in beta, can also deny reads and turn the network on [7]. A worker runs (PLX-38, `daemon/src/backend/codex.rs`), in its worktree, with the prompt on stdin:

```sh
codex exec [resume] --json --ignore-user-config --ignore-rules \
  -c 'default_permissions="parallax_worker"' \
  -c 'permissions={parallax_worker={extends=":workspace", workspace_roots={"<context>"=true},
        filesystem={"<unreadable path>"="deny", ..., "<worktree>/.git"="read", "<git folder>"="read",
          "<zdotdir>"="read"},
        network={enabled=true, domains={"*"="allow"}}}}' \
  -c 'features={network_proxy=true, hooks=false, apps=false, plugins=false, remote_plugin=false,
        multi_agent=false, skill_mcp_dependency_install=false, shell_snapshot=false}' \
  -c 'projects={"<worktree>"={trust_level="untrusted"}}' \
  -c 'approval_policy="never"' -c 'web_search="live"' -c 'allow_login_shell=false' \
  -c 'shell_environment_policy={ignore_default_excludes=false, set={ZDOTDIR="<zdotdir>"}}' \
  [-c 'model_reasoning_effort="<effort>"'] [-m <model>] [<thread id>] -
```

- **Each `-c` sets one top-level key** to an inline TOML table, so no path is part of a dotted key, where a `.` or `=` in it would split wrong. A value that doesn't parse as TOML is taken as a string, and Codex then refuses to start, so a mistake fails closed.
- **The profile wins over `sandbox_mode`.** `default_permissions` on the command line selects permission profiles even if a system or managed config sets `sandbox_mode` (`resolve_permission_config_syntax` at `rust-v0.157.1`). plxd passes no `-s`. More specific entries win over broader ones, so the worktree (a workspace root, write) and the git paths (`read`) reopen inside the denied data folder.
- **Network.** `network.enabled` with `network_proxy` sends commands through Codex's proxy, and Seatbelt allows nothing else. The `*` rule reaches every public host. The proxy's local-network guard (`allow_local_binding = false`) refuses loopback and private addresses, and names that resolve to them. That includes this Mac's own LAN address, so the interface-address gap in the threat model doesn't apply to Codex workers. `web_search="live"` is Codex's hosted search, which runs outside the proxy on OpenAI's side [6].
- **No hooks, MCP servers, or repository settings.** `--ignore-user-config` skips the user's `config.toml`. User hooks then count as untrusted, because their trust hashes live there. The untrusted worktree skips the repository's `.codex/` config, hooks, and rules. `--ignore-rules` skips execpolicy rules. `hooks=false` turns the hooks engine off anyway, and `apps=false` and `plugins=false` keep ChatGPT's connectors and plugins, which are MCP servers, out. `multi_agent=false` removes subagents, as Claude's `Agent` tool is left out. Managed configuration (`/etc/codex`, MDM, cloud requirements) still applies: it is the administrator's. `approval_policy="never"` makes exec deny every escalation, so nothing runs outside the sandbox.
- **Fallback (0012).** Exec reports a failed turn only as a message, so plxd reads it: a 401 or an expired login is `notSignedIn`; a usage limit, a quota, or a plain 429 that outlasted Codex's retries is `rateLimited`. A plan that doesn't include Codex ("upgrade to Plus") stays `vendorError`, so the user sees it rather than the run moving to a paid key.
- **Second check.** Exec reports no tool list, so a worker whose output shows an `mcp_tool_call` or `collab_tool_call` item is killed at once and fails with `policyViolation`.
- **The environment.** `shell_environment_policy.ignore_default_excludes=false` keeps variables named `*KEY*`, `*SECRET*`, or `*TOKEN*` out of commands, including an API key account's `CODEX_API_KEY`. Shell snapshots are off, because a snapshot restored a `*KEY*` variable that the policy had removed (Evidence). Inherited `OPENAI_*` and `CODEX_*` variables never reach the CLI. A second account's `CODEX_HOME` is denied, as `~/.codex` is.
- **Version.** Codex older than `codex::WORKER_MIN_VERSION` (0.157.1, the version checked here) is refused before a worker starts, since one that doesn't know permission profiles would ignore them rather than fail. Detection reads it from `codex --version`.
- **Gap: threads with no repo.** A scratch repository's git folder is inside the data folder. Reading its files works, but git `lstat`s every parent folder, and a profile can't grant metadata alone, so `git status` fails in those threads. The worker still edits files, and plxd commits (PLX-134).
- **`PATH` (PLX-141).** Codex runs each command with the user's shell from the password database, as `-lc` unless `allow_login_shell` is off, and a zsh startup file that sets `PATH` outright, such as nix-darwin's `/etc/zshenv`, replaces plxd's. The shell snapshot that would restore it is off (above), and without one Codex adds nothing to the command. So each worker gets a `ZDOTDIR` folder in the data folder's `tmp/`. zsh reads its `.zshenv` right after `/etc/zshenv`, and it unsets `ZDOTDIR`, runs the user's `~/.zshenv`, and puts plxd's `PATH` back in front, as Claude's env file does (0014). `allow_login_shell=false` makes every command `-c`, so no `.zprofile` or `.zlogin` runs after it; Claude workers get the same startup files. The folder is `read` in the profile, because the sandboxed zsh reads it, so a worker's commands can read it: it holds only the `PATH` they already have. They can't write it or read another run's. plxd deletes it when the run ends, or at the next `serve` start after a crash (PLX-130). bash reads no startup files for `-c`.
- **Gap: temp.** A Codex worker gets the denies of [the run's temp folder](#the-runs-temp-folder): every other run's folder and `/tmp/claude-<uid>`, whose `deny` entries win over `:workspace`'s `/tmp` (checked with `codex sandbox` 0.157.1). But its commands still write the shared `$TMPDIR` and `/tmp`, not their run's folder (PLX-145).
- **Gap: the Keychain.** With network on, Codex's Seatbelt profile allows `mach-lookup` of `com.apple.SecurityServer` for TLS, as Claude's runtime does. The login keychain file is unreadable, which is the same open item as Claude's.
- **Gap: the credential source.** Exec doesn't say which credentials it used, unlike Claude's `apiKeySource`. A subscription run bills whatever `codex login` stored; if that is an API key, Parallax can't tell yet (PLX-136).
- **Other OSes.** Only macOS was checked, so the backend reports `worker_sandbox: false` on Linux (PLX-133) and Windows (PLX-24), and those workers fail with `workerUnavailable`.
- **Refused until PLX-145 (PLX-153).** Because of the temp gap, the backend reports `worker_sandbox: false` on macOS too, so plxd refuses every Codex worker with `workerUnavailable`, naming PLX-145, before creating anything. Detection, sign-in, and usage are unchanged, and PLX-145 turns workers back on.
- `.git` is read-only, so plxd commits (0004).

### Cursor (for #123, still gated on #35)

`agent -p --output-format stream-json --trust --workspace <worktree> --add-dir <context> --sandbox enabled`, never `--force`, `--yolo`, or `--approve-mcps` [10][11]. `agent sandbox run` shows the policy: `workspace_readwrite`, reads bounded only by `system`, network denied by default. #123 has to settle five open items:

- **Reads.** The sandbox's flags can't deny reads (Evidence). #123 must find a way to hide the denylist, or record the gap and have Ryan accept it.
- **`--add-dir`.** It appears in `agent --help` for 2026.09.10 but not in the published parameters reference [10], which lists only `sandbox run --allow-paths`. #123 must confirm it.
- **Network.** It is set only by `sandbox.networkAccess` in the user's global `~/.cursor/cli-config.json` [11]. #123 must turn it on for workers without editing the user's own config, and must also not inherit a different value from it.
- **Project permissions.** With `--trust`, a repository's `.cursor/cli.json` can set `permissions.allow` [11]. #123 must say whether that can widen anything the sandbox doesn't already hold.
- **Web tools.** Whether web search and fetch are separate tools, and how to allow them headless.

### Tests and builds

A worker runs a project's tests with its shell tool, inside the vendor sandbox, like any other command. Build output goes in the worktree (`target/`, `node_modules/`, `dist/`), and toolchains and package caches under the home folder are read. In local experiments (Evidence), `cargo test --offline` with dependencies already in `~/.cargo` and `npm test` both passed under Codex's sandbox, including this repository's own `parallax-protocol` suite (56 tests, built from scratch in the sandbox).

What doesn't work in v1:

- **Installing dependencies, partly.** Commands can reach the registries now. But package managers write their caches under the home folder (`~/.npm`, `~/.cargo/registry`, `~/Library/Caches/pip`), and workers can't write there. Making those caches writable would let one worker poison packages for every later project. #167 decides between two ways out: point the caches at the run's temp folder, or run a setup step before the worker starts.
- **Tests that bind localhost or use Unix sockets.** All three sandboxes block both by default, and so do plxd's own server tests. #168 decides the settings (Claude `allowLocalBinding` and `allowUnixSockets`, Codex `--allow-unix-socket`, ...).
- **Docker, Apple Events, and the Keychain.** The `security` command couldn't reach the Keychain under Codex's and Cursor's sandboxes (Evidence). Claude's is untested. Its runtime's macOS profile allows Mach lookups of the Keychain services (`com.apple.SecurityServer`, `com.apple.securityd.xpc`) [13]. `denyRead` on `~/Library/Keychains` probably holds, but that is unverified. #124's checklist covers it.

### No OS layer of Parallax's own around the CLI, in v1

Wrapping the whole CLI in a Parallax `sandbox-exec` profile was tried and rejected:

- **The vendors' sandboxes stop working.** Under any restrictive outer Seatbelt profile, even one that only denies one read, a nested `sandbox_apply` fails with `Operation not permitted` (Evidence). Claude Code would then refuse to start under `failIfUnavailable`, and Codex's commands would fail, so Parallax would be replacing the vendor sandbox rather than adding to it.
- **It can't filter the network by host.** Seatbelt filters by address and port, so an outer profile couldn't keep localhost out while letting everything else through by name.
- **It would have to allow the vendors' state writes.** Session files, `~/.claude`, `~/.codex`, and token refreshes in the Keychain all need write access, which opens exactly the files a sandboxed command must not touch.

A separate macOS user was rejected too. The user's own signed-in CLI and its Keychain entries belong to the user's account (0004); a second user needs admin setup, its own vendor login, and `safe.directory` exceptions for the repository.

Parallax's own profile does have one use: commands plxd runs itself, such as a setup step if #167 picks one. Nothing nests inside those.

### What #156's runner does

#156's comment spells out the exact values:

1. Starts a worker only on a backend that implements this record: Claude, Codex on macOS once PLX-145 lands (PLX-38, PLX-153), and Cursor once #123 does.
2. Before starting a Claude or Codex worker, checks the detected version (#114) against its backend's `WORKER_MIN_VERSION`, and refuses with an error that names both versions. For Claude, the `system/init` check backs this up.
3. Passes `sandbox: Some(WorkerSandbox::for_worktree(home, data_dir, worktree, git_common_dir, context_dir))`, with every path canonical. Seatbelt matches real paths, and `/var` and `/tmp` are symlinks on macOS.
4. Commits the worktree's changes itself, with the git folder pinned and hooks off (#166), for every backend including Claude. `--no-verify` skips only `pre-commit` and `commit-msg` [12]. A worker can write files that git hooks run, such as `.husky/*` under `core.hooksPath`: Claude through Bash, and Codex and Cursor through any command. Cursor's sandbox also leaves the worktree's `.git` file writable, and that file says which repository git uses.

## Deferred

- Localhost and Unix sockets for tests, and this Mac's interface addresses (#168); dependency caches or a setup step (#167); and a check against a real Claude login (#124).
- Denying other accounts' configuration folders, once #114's successors give plxd a list of them.

## Consequences

- Workers can build, test, search, and fetch. JavaScript projects in a fresh worktree still need #167 before `npm install` works.
- A worker's own shell can't commit, or reach this Mac's services through its loopback or unspecified addresses, and an agent that expects to will see its command fail. Its prompt (#156) should say so.
- With network on, the denylist is the whole of the secrecy boundary. It can't cover every secret, and a gap in it is a leak, not just a read.
- The worker contract depends on vendor flags that change often: `--restricted` is weeks old, and Codex's permission profiles are in beta. Each adapter pins a tested CLI version (0004), and CI's argv tests pin the flags.
- Reviewing the diff is the last gate. A worker can change files that run later outside any sandbox, such as `package.json` scripts, `Makefile`, `.husky/*`, or `.vscode/tasks.json`. The Edit tool refuses some of these, but a command doesn't.

## Evidence

Local experiments on macOS 27.0 with Codex CLI 0.154.0 (`codex sandbox -P <profile>`), Cursor CLI 2026.09.10 (`agent sandbox run`), and `sandbox-exec`. None needs a vendor login. A probe script tried each operation from a simulated linked worktree whose `.git` file points to a separate git folder, with the context folder, the git folder, and a "secret" all outside the worktree and outside `/tmp`. The experiments ran with each vendor's default network setting (off), before Ryan chose network access, so the HTTPS row shows those defaults, not v1. Claude Code has no column here, because its sandbox runs only inside a session. The fake-API test after the table covers it.

| Operation | Codex `:workspace` | Codex `parallax_worker` profile | Cursor sandbox | Parallax `sandbox-exec` profile |
| --- | --- | --- | --- | --- |
| Write the worktree | allowed | allowed | allowed | allowed |
| Write the context folder | denied (not a root) | allowed | allowed (`--allow-paths`) | allowed |
| Write `$TMPDIR` / `/tmp` | allowed / allowed | allowed / allowed | denied / allowed | allowed / denied |
| Write elsewhere, or through a symlink in the worktree | denied | denied | denied | denied |
| Write the worktree's `.git` file | denied | denied | **allowed** | denied |
| Write the repository's git folder | denied | denied | denied | denied |
| Read a file outside the roots | allowed | denied (`deny` rule) | allowed | denied |
| Read it through a hard link made in the worktree | denied | denied | denied | denied |
| HTTPS to example.com (default network setting) | denied | denied | denied | denied |
| Bind 127.0.0.1 / a Unix socket in the worktree | denied / denied | denied / denied | denied / denied | allowed / allowed |
| Search the Keychain with `security` | denied | denied | denied | allowed |
| Start a nested `sandbox-exec` | denied | denied | denied | denied |

Nesting: `sandbox-exec` inside `sandbox-exec` works only when the outer profile is `(allow default)` with nothing denied. With a single `deny` of writes, reads, or network, the inner `sandbox_apply` fails with `Operation not permitted` (exit 71). `codex sandbox` inside Parallax's profile failed the same way.

**Codex (PLX-38).** On 2026-09-28, with codex-cli 0.157.1 on macOS 27.0, `codex sandbox -P parallax_worker` ran a probe with a worker's exact profile from a linked worktree. The worktree and context folder were inside a denied "data folder", and the tree was outside `/tmp` and `$TMPDIR`:

- **Allowed:** writing the worktree, the context folder, `$TMPDIR`, and `/tmp`; reading the worktree and context folder; `git status` and `git log` in a worktree of a repository outside the data folder; HTTPS to a public host.
- **Refused:** writing anywhere else, through a symlink in the worktree, to the `.git` file or the git folder, and `git commit`; reading a denied `.ssh`, `.codex`, and another project's context, and listing the data folder; hard-linking a denied file into the worktree; HTTP to `127.0.0.1`, `localhost`, `127.1`, `[::1]`, `0.0.0.0`, `[::ffff:127.0.0.1]`, and the Mac's LAN address, through the proxy or around it; connecting to a Unix socket; opening the login keychain.

Real `codex exec --json` runs on a ChatGPT login with the backend's flags then confirmed the rest:

- A repository `.codex/config.toml` naming an MCP server and a `notify` program, and a `.codex/hooks.json`, each writing a marker file outside the sandbox: no marker appeared.
- A `curl` to `127.0.0.1` got the proxy's 403. Asked to read a denied file, write outside the worktree, and `apply_patch` outside it, the model declined all three, citing the permission profile Codex describes to it, and nothing was written.
- A `PLX_PROBE_API_KEY` variable reached commands through the shell snapshot, and not once snapshots were off.
- `PATH` (PLX-141, on a nix-darwin Mac whose `/etc/zshenv` sets it outright): through a `plxd` built with the `ZDOTDIR` folder, a worker's command ran as `/bin/zsh -c`, found a tool that only plxd's `PATH` had, found `cargo` in `~/.cargo/bin`, and had plxd's entries first with nix-darwin's after. `*KEY*`, `*TOKEN*`, and `*SECRET*` variables still didn't reach it. Under `codex sandbox -P`, the command could read its own folder but not write it, create files in it, read another run's, or list the data folder's `tmp/`.
- A worker ran through `plxd` end to end: plxd committed its file, and `agent/send` resumed the thread.

The backend's fixtures are those runs.

**Claude Code, against a fake API (PLX-20).** `daemon/tests/sandbox.rs` runs Claude Code with a worker's exact arguments against a fake Messages API on 127.0.0.1. So it needs no login and sends nothing to Anthropic. The fake asks for one Bash call that runs a script in the worktree, and Claude's permission checks can't see into a script.

- **macOS.** On 2026-09-28, with Claude Code 2.1.283 on macOS 27.0, Seatbelt refused:
  - reads of `~/.ssh`, and of another project's context folder;
  - writes to the home folder, to a folder outside the data folder, and to the worktree's `.git` file.

  Writes to the worktree and the context folder went through. With `.ssh` dropped from the denylist, the test failed.
- **Linux.** CI runs the same test on x86_64 and arm64, and on 2026-09-28 it also passed in an Ubuntu 24.04 arm64 container with Claude Code 2.1.283. There it also checks that a Unix-socket connect is refused, and that a registry login in a runtime folder that the sandbox denies can't be read. The unit tests in `sandbox.rs` cover which folders `for_worktree` denies (PLX-107). The same day, in the container, the read was also refused in the real `/run/user/<uid>`, with Claude Code given `XDG_RUNTIME_DIR` too: it made its `cc-socks` folder there and still ran the command. With the runtime folder dropped from the denylist, the test failed.
- **The run's temp folder (PLX-130).** Before it, a worker's `TMPDIR` on macOS was `/tmp/claude-501`, and a probe read and wrote a file another session had left there, and wrote `~/.npm/_logs` and `~/.claude/debug`. On 2026-09-28, with Claude Code 2.1.283, `a_worker_s_temp_is_its_own` passed on macOS 27.0 and in an Ubuntu 24.04 arm64 container. The probe's `$TMPDIR` was `<run folder>/claude-<uid>`, and writable. It couldn't read another run's folder or a file in `/tmp/claude-<uid>`, and nothing it wrote reached the run folder itself, another run's folder, `/tmp/claude-<uid>`, `/tmp/claude`, `~/.npm/_logs`, or `~/.claude/debug`. On Linux, a write under a hidden folder lands in the tmpfs that hides it, which only that one command sees, so the test checks the disk. With the `denyWrite` rules dropped, the last three were written. With a `…/claude-<uid>` of 49 bytes, Claude Code gave commands `/tmp/claude-501` instead.
- **The environment.** The test gives Claude Code a worker's environment as plxd does, without `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. With the flag set, the Linux run failed: the probe wrote to the home folder, to `/tmp`, and to `/var/tmp` (PLX-20). With the flag set only in `/etc/claude-code/managed-settings.json`, the probe also wrote to the home folder. Setting the flag to `0` in the worker's `--settings` `env` changed nothing (PLX-112). `daemon/tests/worker_permission.rs` checks, against the same fake API, that a worker's Bash runs and doesn't see `ANTHROPIC_API_KEY` (PLX-110).
- **Managed settings.** Claude Code 2.1.283 reads the flag from its own environment only, after it applies every settings `env` block, with managed settings applied last. `claude --restricted sandbox status` reported scrub mode for the flag in `managed-settings.json` and in a drop-in file, but not in the user's own settings. `linux_sandbox`'s tests run a real Claude Code and check three things: the host check accepts it with the flag off; it accepts it with the flag only in plxd's own environment, which the check drops; and the status is refused with the flag in Claude Code's own environment. That last case is where a managed `env` block puts the flag. CI runs as a normal user, so it can't write `/etc/claude-code`. 2.1.283 also ignores `CLAUDE_CODE_MANAGED_SETTINGS_PATH` and `CLAUDE_CODE_REMOTE_SETTINGS_PATH` there. So the managed-file runs were manual, in the container (PLX-112). Server-managed settings, `policyHelper`, and WSL's inherited settings were not tried, because they need an organization or a Windows host. That they reach the check the same way is an assumption.
- **The check's process and the worker's (PLX-118).** The PLX-112 review suspected that `sandbox status` could miss server-managed settings, because Claude Code sets `startupAwaited` only when the command is the root one. In the 2.1.283 binary, that root-command test sets `startupAwaited` only for the policy-limits load. Whether start-up waits for server-managed settings doesn't depend on the command, so that disagreement is ruled out. Start-up waits only when a policy forces a refresh, behind a cloud gateway, and in some `policyHelper` and cached-remote cases. Otherwise both commands start from the copy cached on disk and fetch in the background. Other disagreements remain possible, untested for want of an organization:
  - a background fetch that lands after the short check has exited but before the worker reads the flag;
  - a second account's configuration folder, which holds its own cache (PLX-117);
  - an API key account's key, which the check doesn't get, so an organization's settings tied to that key may not reach it.

  So plxd also checks the worker's own process. Claude Code reads the flag once and latches it. That one value both switches on the scrub sandbox and forces the permission mode to `default`, with the stderr warning "Permission mode forced to default". On 2026-09-28, with 2.1.283 against a dead local API, a worker's `system/init` reported `acceptEdits` with the flag off and `default` with it on. That held on macOS 27.0 and in an Ubuntu 24.04 arm64 container, with the flag in the environment, in `/etc/claude-code/managed-settings.json`, and in a `managed-settings.d` drop-in. With the flag in `managed-settings.json`, plxd's own backend killed such a worker at `init` with `policyViolation`. `linux_sandbox`'s tests run a worker through plxd with the pinned Claude Code, with the flag off and with it in Claude Code's own environment.

**The task tools (PLX-248).** On 2026-10-01, Claude Code 2.1.283 for Linux x64, the npm package whose binary has CI's pinned SHA-256, was run by hand as a worker against a fake Messages API, with `--restricted`, `--strict-mcp-config`, a worker's `--settings`, and `--model claude-opus-5-5`, outside the built-in list:

| `--tools` | Result |
| --- | --- |
| The list before PLX-248, with `TodoWrite` | `system/init` lists no todo tool; `TaskCreate` fails with "No such tool available" |
| With the four task tools | `system/init` lists them and not `TodoWrite`; `TaskCreate` answers `Task #1 created successfully: Add tests`, and the CLI writes `~/.claude/tasks/<session id>/1.json` |
| The same, with `CLAUDE_CODE_ENABLE_TASKS=false` | `system/init` lists `TodoWrite` and not the task tools |
| The same, resumed with `--resume` | `TaskList` lists the first process's task, and the next `TaskCreate` gets the next id |

Sandboxed Bash couldn't start there, because the container ran as root, which plxd doesn't support (Setup, above). So `daemon/tests/permission_requests.rs` runs a worker through plxd's backend with the pinned Claude Code on CI's Linux legs: its init passes plxd's check, `TaskCreate` and `TaskUpdate` answer as above, the list is in the configuration folder and not the worktree, and a script the worker runs can't read it. The first run of that test found an empty `.claude` folder in the worktree. It isn't the task tools': after any sandboxed command on Linux, Claude Code 2.1.283's sandbox leaves the empty mount point it binds there to keep commands from creating its settings files. Git doesn't track an empty folder, so plxd's commit doesn't carry it. `daemon/src/backend/claude/fixtures/worker-tasks.jsonl` is that hand run's transcript.

**The task list's variable (PLX-251).** On 2026-10-01, the same Claude Code was run by hand against a fake Messages API that asked for `TaskCreate`, on an API key, with `CLAUDE_CODE_TASK_LIST_ID` set to a value in one place at a time. Runs without `--restricted` load the settings files a coordinator and a bypass worker load; runs with it, and with `--tools` naming the task tools, load a worker's. Where the CLI wrote `1.json`:

| Where the variable was set | Without plxd's `--settings` | With `--settings '{"env":{"CLAUDE_CODE_TASK_LIST_ID":""}}'` |
| --- | --- | --- |
| The CLI's environment | `tasks/<value>` | `tasks/<session id>` |
| The user's `settings.json` | `tasks/<value>` | `tasks/<session id>` |
| The project's `.claude/settings.json` | `tasks/<value>` | `tasks/<session id>` |
| The local `.claude/settings.local.json` | `tasks/<value>` | Not run alone |
| The global config, `.claude.json` | `tasks/<value>` | `tasks/<session id>` |
| The global config, with `--restricted` | `tasks/<value>` | `tasks/<session id>` |
| The user's or the project's settings, with `--restricted` | `tasks/<session id>`: not read | Not run |
| All four files at once, with and without `--restricted` | `tasks/<value>`, without | `tasks/<session id>` |
| `/etc/claude-code/managed-settings.json`, with and without `--restricted` | Not run | `tasks/<value>` |

With two `--settings`, the empty `env` first and `{"disableAllHooks":true}` last, the user's value won: the CLI keeps only the last. 2.1.248 (`WORKER_MIN_VERSION`) and 2.1.287, the newest on npm that day, pick the list with the same code, and gave the same results with all four files at once. The managed runs bind-mounted a copy of `/etc` that adds `claude-code/managed-settings.json`, in a private mount namespace, so the container's own `/etc` stayed untouched. `daemon/tests/permission_requests.rs` puts a value in the global config and the user's settings for a worker, and in those and the project's and the local settings for a coordinator and a bypass worker, and checks on CI's Linux legs that each still writes `tasks/<session id>`.

## Sources

Read on 2026-09-25, as raw Markdown (`.md` appended to each page URL).

1. Claude Code, sandboxing (filesystem and network isolation, protected paths, git worktrees, `WebFetch(domain:...)` wildcards, `failIfUnavailable`, `allowUnsandboxedCommands`, security limitations): https://code.claude.com/docs/en/sandboxing
2. Claude Code CLI reference (`--restricted`, `--tools`, `--add-dir`, `--strict-mcp-config`, `--settings`): https://code.claude.com/docs/en/cli-reference
3. Claude Code permissions (Bash rule limits, working directories, what runs before you trust a folder): https://code.claude.com/docs/en/permissions
4. Claude Code settings reference (`sandbox.*` including path prefixes and wildcards, `sandbox.network.deniedDomains`, `permissions.*`, `disableAllHooks`): https://code.claude.com/docs/en/settings-reference
5. Claude Code permission modes (`acceptEdits`, protected paths): https://code.claude.com/docs/en/permission-modes
6. Codex, agent approvals and security (network, `network_proxy`, local destinations, web search, protected paths in writable roots, `codex sandbox`): https://learn.chatgpt.com/docs/agent-approvals-security
7. Codex permission profiles: https://learn.chatgpt.com/docs/permissions
8. Codex CLI 0.154.0 `codex exec --help` (`--ignore-user-config`, `--ignore-rules`, `--add-dir`)
9. Codex configuration reference (`projects.<path>.trust_level`, `sandbox_workspace_write.*`, `shell_environment_policy.*`): https://learn.chatgpt.com/docs/config-file/config-reference
10. Cursor CLI parameters (`--sandbox`, `agent sandbox run`): https://cursor.com/docs/cli/reference/parameters
11. Cursor CLI configuration (`sandbox.mode`, `sandbox.networkAccess`, project `.cursor/cli.json`): https://cursor.com/docs/cli/reference/configuration
12. Git, `git commit --no-verify` and githooks: https://git-scm.com/docs/git-commit, https://git-scm.com/docs/githooks
13. sandbox-runtime, the engine behind Claude Code's sandbox: its macOS profile (Mach lookups it allows), host canonicalization and the resolved-address guard (which skips IP literals), and glob characters in paths: https://github.com/anthropic-experimental/sandbox-runtime (`src/sandbox/macos-sandbox-utils.ts`, `parent-proxy.ts`, `resolved-address-guard.ts`, `sandbox-utils.ts`). For Linux, read on 2026-09-28 at `ddbeb74`: its bubblewrap arguments, its dependency checks, and the `argv0` mode of its seccomp config (`linux-sandbox-utils.ts`, `generate-seccomp-filter.ts`, `sandbox-config.ts`, `vendor/seccomp-src/`). How Claude Code 2.1.283 sets that config was read from the strings in its linux-x64 binary.
14. Claude Code environment variables (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`): https://code.claude.com/docs/en/env-vars
15. Claude Code changelog, 2.1.92: "Linux sandbox now ships the `apply-seccomp` helper in both npm and native builds": https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
16. containers/image, the library behind Podman, Buildah, and Skopeo: `getPathToAuthWithOS` uses `$XDG_RUNTIME_DIR/containers/auth.json`, or `/run/containers/<uid>/auth.json` (`defaultPerUIDPathFormat`) when the variable is empty. Read on 2026-09-28 at `551121d`: https://github.com/containers/container-libs/blob/551121da77392eb93f4324563b8e67c0678831b2/image/pkg/docker/config/config.go
