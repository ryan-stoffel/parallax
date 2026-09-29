# 0013: The worker sandbox

- Status: accepted; the Linux sandbox is under [Claude Code on Linux](#claude-code-on-linux) (RYA-20), and the refusal of Claude workers on native Windows is in [0023](0023-cross-platform.md)
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
| Write | Its worktree; the project's shared context folder (0005); its temp folder | Anything else. This includes the worktree's `.git` file and the repository's git folder, so wispd makes every commit (0004) |
| Read | The whole disk | wispd's data folder, except its own worktree and context folder, and every path in `UNREADABLE_IN_HOME` and this OS's `UNREADABLE_IN_HOME_ON_THIS_OS` (`daemon/src/backend/sandbox.rs`). Those lists cover keys and the Keychain folder; cloud, container, and infrastructure credentials; git and git-host credentials, including Copilot's token; package-registry and database credentials; password managers (`pass`, 1Password, Bitwarden); shell and REPL histories, including `~/.zsh_sessions`; browser profiles and cookies (Safari, Chrome, Firefox, Arc, Brave, Edge); and the agent CLIs' own folders |
| Execute | Any command, inside the vendor's OS sandbox (Seatbelt on macOS, bubblewrap and seccomp on Linux) | Anything outside it: no unsandboxed retries, no hooks, no MCP servers, no repository-supplied settings |
| Network | Any public host, from commands and from the web search and fetch tools (Ryan, #137) | This Mac's loopback and unspecified addresses (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, `[::]`), until #168. Not this Mac's interface addresses: see the threat model |

`WorkerSandbox` (`daemon/src/backend/sandbox.rs`) carries the paths. Every backend refuses a `workspace-write` run in any of these cases, with an error that names the problem:

- it has no sandbox, or its sandbox has nothing unreadable;
- a sandbox path, its cwd, or its account's configuration folder is relative or not UTF-8;
- any of those paths holds `*`, `?`, `[`, or `]`. The vendors read those as wildcards, so a deny rule for a folder such as `~/src/app[old]/.git` would not match it and would fail open [4][13].

### Threat model

With network on, anything a worker's commands can read, they can send anywhere. So the read denylist, not the network, is what keeps secrets on the machine:

- **What stays in.** The paths in the list, and wispd's data folder, which holds other projects' context, the store, and the log. Credentials in the environment stay in too: a worker's CLI inherits only an allowlist of wispd's environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `LC_*`, `TERM`, and the proxy and CA variables; 0014), so tokens such as `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY` that wispd was started with never reach it, and the sandbox unsets the two credentials Claude Code itself holds, an API key account's `ANTHROPIC_API_KEY` and `CLAUDE_CODE_MESSAGING_TOKEN`, for every command (`sandbox.credentials`, below).
- **What can leave.** The worktree's own source, which the vendor's model sees anyway, and any secret the list doesn't name. That includes `.env` files in other projects and credentials a tool keeps somewhere we didn't list. It also includes another account's configuration folder, if one lives outside the data folder: only the run's own account's is denied. The vendors have no built-in list [1], so new entries go in `UNREADABLE_IN_HOME`.
- **What comes in.** Fetched pages, search results, and downloaded packages can carry prompt injection or malicious code. They run inside the same sandbox as everything else, so their reach is the same as the agent's own.
- **This Mac's own services** (databases, Docker's published ports, dev servers) are a larger target than any one remote host, so its loopback and unspecified addresses are denied to commands and to WebFetch alike. The sandbox's proxy canonicalizes other spellings of loopback (`127.1`, `[::ffff:127.0.0.1]`) and refuses names that resolve to this Mac, but it doesn't check IP literals [13]. So `0.0.0.0` and `[::]` are listed explicitly.
- **Gap: this Mac's interface addresses.** A service bound to `0.0.0.0` also listens on the Mac's LAN address, such as its Wi-Fi IP, and a worker that uses that literal address reaches it. wisp doesn't list those addresses, because they change with the network during a run. Other machines on the LAN are reachable too, since network access is on. #168 decides whether to enumerate the Mac's addresses at run start or to accept the gap.

### Claude Code

Claude Code sandboxes Bash with Seatbelt on macOS. Its sandbox restricts writes to the working directories and the session temp folder, reads by `denyRead` rules, and network by a proxy with a domain allowlist [1]. A worker runs:

```sh
claude -p --output-format stream-json --verbose --input-format stream-json \
  --restricted \
  --tools Read,Edit,Write,Glob,Grep,NotebookEdit,Bash,WebFetch,WebSearch,TodoWrite \
  --strict-mcp-config \
  --permission-mode acceptEdits \
  --settings '<worker_settings>' \
  --add-dir <shared context folder> \
  [--model <m>] [--resume <id>]
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
      "allowRead": ["<worktree>", "<shared context folder>"],
      "denyWrite": ["<worktree>/.git", "<repository git folder>"]
    }
  }
}
```

- **`--restricted`** loads only managed settings and `--settings`. It skips the user, project, and local settings files, so a repository can't add allow rules, directories, hooks, or an `env` block. It also confines the file tools to the working directories, and it removes the command tools and WebFetch unless `--tools` names them [2]. It needs Claude Code 2.1.248 or later (`WORKER_MIN_VERSION`). We chose it over `--setting-sources user`, which would still merge the user's own sandbox arrays and allow rules into a worker's [1].
- **`--tools`** is an explicit list. `Bash` is on it and in `permissions.allow`, so it stays allowed if managed settings force permission mode `default`, where Claude Code 2.1.283 ignores `autoAllowBashIfSandboxed` and would deny Bash before the sandbox runs (RYA-110, RYA-112). The OS boundary holds whatever the command string says [1]. Argument patterns such as `Bash(npm test *)` are fragile by the vendor's own account [3], and the sandbox makes them unnecessary. The list leaves out `Agent`, `Skill`, `Monitor`, and every MCP tool. Leaving out `Skill` and `Agent` also means a repository's skills and subagents can't be invoked.
- **Network.** The sandbox takes its allowlist from `allowedDomains` and from `WebFetch(domain:...)` allow rules, and it honors a bare `*` in those rules [1]. So `WebFetch(domain:*)` opens every host to commands and approves WebFetch; `WebSearch` approves search. `strictAllowlist` makes any host outside the list, which is only `deniedDomains`, fail instead of prompting. `deniedDomains` wins over the allowlist, but it binds sandboxed commands only; WebFetch runs in-process and follows permission rules [4]. So each denied host is also a `WebFetch(domain:...)` deny rule, which beats the `*` allow for the tool [3].
- **`failIfUnavailable`** makes a run fail when the sandbox can't start, instead of running commands unsandboxed. **`allowUnsandboxedCommands: false`** ignores `dangerouslyDisableSandbox`, the model's escape hatch [1][4].
- **`--strict-mcp-config`** with no `--mcp-config` connects no MCP servers, including `.mcp.json` [2]. wispd's own MCP tools join in M4.
- **`acceptEdits`** approves the file tools inside the working directories. Writes to the permission system's protected paths (`.git`, `.claude`, `.vscode`, `.husky`, `.mcp.json`, shell startup files, ...) still prompt, and `-p` denies them [5]. That covers the Edit and Write tools only. The sandbox's own protected paths are a shorter list, and `.husky` isn't on it [1]. So a Claude worker's Bash can write `.husky/_/post-commit`, which git would run, outside any sandbox, when wispd commits. #166 is needed for Claude workers too.
- **`denyWrite` on git metadata.** In a linked worktree the sandbox would otherwise let commands write the repository's shared git folder, for `git commit` [1]. That would let a worker move any branch, including the user's. wispd commits for every backend instead.
- **Second checks on `system/init`.** A worker whose `system/init` lists a tool outside `WORKER_TOOLS` fails with `policyViolation`, as a no-write run does with anything outside its read tools. So does one whose `claude_code_version` is missing or below `WORKER_MIN_VERSION`.
- **No `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` for workers.** On Linux, Claude Code 2.1.283 answers the flag by merging its CI hardening profile into each command's sandbox: writes open to all of `/home`, `/root`, `/tmp`, `/var`, `/opt`, `/run`, and `/mnt`, and `denyWrite` entries outside those folders are dropped (RYA-20). So wispd sets the flag only for no-write runs, which have no Bash to widen [14]. For a worker, `sandbox.credentials.envVars` unsets `ANTHROPIC_API_KEY` and `CLAUDE_CODE_MESSAGING_TOKEN` before each command instead [1]. Managed settings still load under `--restricted`, and their `env` block overrides both wispd's environment and `--settings`. So on Linux, wispd refuses a worker when managed settings set the flag (step 2 of the check under [Claude Code on Linux](#claude-code-on-linux), RYA-112).
- **`CLAUDE_CONFIG_DIR` in Bash.** A worker's commands see it. That is harmless, because the folder is in `denyRead`.

**#134, the project `env` gap.** For workers it is closed: `--restricted` reads no project or user settings file, so no repository `env` block reaches the CLI. The existing checks (`apiKeySource` in `system/init`, `modelUsage[*].provider` in `result`) stay as a second line. Managed settings and wispd's scrubbed environment are the only remaining sources.

**What a repository can still change for a Claude worker.** Only its `CLAUDE.md`, which is instructions and not configuration: it still loads. Everything else a repository supplies is either not loaded or is used only through a tool the worker doesn't have.

### Claude Code on Linux

On Linux and WSL2, Claude Code sandboxes Bash with bubblewrap and relays its proxy traffic with `socat` [1]. A Linux worker runs the same command with the same `worker_settings` as on macOS. wispd never sets `enableWeakerNestedSandbox`, which bind-mounts the host's `/proc` instead of a fresh one. It never sets `allowAllUnixSockets` either, which would drop the filter below.

- **Reads.** `UNREADABLE_IN_HOME` holds the paths every OS shares, and `UNREADABLE_IN_HOME_ON_THIS_OS` adds Linux's:
  - GNOME Keyring, KWallet, and NSS's `~/.pki`
  - 1Password and Bitwarden
  - Chrome, Chromium, Brave, Edge, and Firefox, with their snap and flatpak folders, since Ubuntu ships Firefox as a snap. Firefox 147 and later, and Thunderbird, keep new profiles in `~/.config/mozilla` instead of `~/.mozilla`, so both are listed
  - the Cursor and Claude apps under `~/.config`

  wispd's data folder, `~/.local/share/wisp` (0023), is denied as on macOS. `$XDG_RUNTIME_DIR` is outside the home folder and isn't denied yet (RYA-107).
- **The seccomp filter is required.** Without it, a sandboxed command can connect to any Unix socket. That includes the D-Bus session bus that serves the Secret Service, `ssh-agent`, and `docker.sock`. On macOS, Seatbelt blocks them. `failIfUnavailable` doesn't cover the filter, because Claude Code treats it as optional, so wispd checks it itself.
- **Where the filter comes from.** Since 2.1.92, Claude Code ships the filter's helper, `apply-seccomp`, itself [15].
  - The native build compiles the helper into the `claude` binary, and the npm package now installs the native build too.
  - It runs every sandboxed command inside bwrap as `ARGV0=apply-seccomp /proc/self/fd/3 <shell> -c <command>`, where fd 3 is its own binary. That is what the 2.1.283 linux-x64 build does: `seccomp: {applyPath: "/proc/self/fd/3", argv0: "apply-seccomp"}` whenever it runs as a standalone executable [13].
  - `npm install -g @anthropic-ai/sandbox-runtime`, which Claude's docs still suggest, is only a fallback for a build without the helper. So wispd doesn't look for that package: a native Claude never reads it.
- **How wispd checks** (`backend::claude::linux_sandbox::check_host`). Before each Claude worker starts or resumes, after the version check, with no cache:
  1. `bwrap` and `socat` must resolve on the agents' `PATH`, where Claude Code looks for them.
  2. `claude --restricted sandbox status` must not report `autoAllowBashIfSandboxedSource: "unsupported"`. It reports that value on Linux exactly when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is on (RYA-112).
     - `--restricted` makes it read the same settings a worker does: managed settings, from every source Claude Code loads. On Linux those are `/etc/claude-code/managed-settings.json`, `/etc/claude-code/managed-settings.d/*.json`, server-managed settings, a `policyHelper`, and, on WSL, the Windows machine's managed settings.
     - The command is hidden, but its output is versioned (`statusVersion`). The field arrived in 2.1.275, so a Linux worker needs Claude Code 2.1.275 or later. An older one is refused.
  3. wispd listens on a Unix socket in a temp folder. bwrap runs `socat` to connect to it, with the namespaces Claude's sandbox uses: `--unshare-user --unshare-pid --proc /proc --cap-drop ALL`. The connect must succeed. If bwrap fails and `kernel.apparmor_restrict_unprivileged_userns` is 1, the error names AppArmor.
  4. The same bwrap runs the detected `claude` as `ARGV0=apply-seccomp`, which runs the same connect. The connect must be refused.

  Each failure is `workerUnavailable` and names what is wrong: bubblewrap, socat, the scrub flag, the AppArmor profile, or the filter. The check runs the same binary and helper the worker will use, so it can't pass on a file Claude Code doesn't load. It can't catch a later Claude Code that stops running its helper. `WORKER_MIN_VERSION` and `daemon/tests/sandbox.rs` cover that. CI runs the test against a pinned Claude Code on Linux.
- **Setup.** Install `bubblewrap` and `socat`. On Ubuntu 24.04 and later, also add the AppArmor profile for `/usr/bin/bwrap` from Claude's docs [1]. WSL1 isn't supported. Nor is wispd running as root: Claude's sandbox adds `CAP_SETFCAP` for uid 0 and the check doesn't, so the check refuses.

### Codex (for #122)

Codex sandboxes commands with Seatbelt. Its `:workspace` permission profile writes the workspace roots and the temp folders, and it protects `.git` (including the folder a `.git` file points to) and `.codex` [6][7]. Permission profiles, which are in beta, can also deny reads and turn the network on [7]. A worker runs:

```sh
codex exec --json -C <worktree> \
  --ignore-user-config --ignore-rules \
  -c 'default_permissions="wisp_worker"' \
  -c 'permissions.wisp_worker.extends=":workspace"' \
  -c 'permissions.wisp_worker.workspace_roots={"<shared context folder>"=true}' \
  -c 'permissions.wisp_worker.filesystem={"<unreadable path>"="deny", ...}' \
  -c 'permissions.wisp_worker.network.enabled=true' \
  -c 'permissions.wisp_worker.network.domains={"*"="allow"}' \
  -c 'features.network_proxy=true' \
  -c 'approval_policy="never"' \
  -c 'web_search="live"' \
  -c 'projects."<worktree>".trust_level="untrusted"' \
  -c 'shell_environment_policy.ignore_default_excludes=false'
```

- Profiles and `sandbox_mode` don't compose: passing `-s` or loading a `sandbox_mode` from any config disables the profile [7]. So #122 passes no `-s`, and `--ignore-user-config` keeps the user's `sandbox_mode` out. Auth still comes from `CODEX_HOME` [8].
- **Network.** `network.enabled` gives commands network access. `network_proxy` with a global `*` allow reaches every public host, and its default `allow_local_binding = false` keeps loopback and private addresses out. That matches Claude's localhost denial [6]. Without the proxy, access would be direct and unrestricted, localhost included. `web_search="live"` is Codex's search-and-browse [6].
- An untrusted project skips the repository's `.codex/` config, hooks, and rules [9]. `approval_policy="never"` is explicit, because an untrusted project otherwise asks for approval, and exec denies approval requests (0004). #122 must confirm that a `-c projects."<worktree>".trust_level` override still applies under `--ignore-user-config`.
- `.git` is read-only, so wispd commits (0004).
- If #122 finds that permission profiles misbehave on the version it pins, the fallback is `-s workspace-write --add-dir <context>` with `sandbox_workspace_write.network_access=true`. That fallback loses the read denials and the localhost denial, and #122 records the gap.

### Cursor (for #123, still gated on #35)

`agent -p --output-format stream-json --trust --workspace <worktree> --add-dir <context> --sandbox enabled`, never `--force`, `--yolo`, or `--approve-mcps` [10][11]. `agent sandbox run` shows the policy: `workspace_readwrite`, reads bounded only by `system`, network denied by default. #123 has to settle five open items:

- **Reads.** The sandbox's flags can't deny reads (Evidence). #123 must find a way to hide the denylist, or record the gap and have Ryan accept it.
- **`--add-dir`.** It appears in `agent --help` for 2026.09.10 but not in the published parameters reference [10], which lists only `sandbox run --allow-paths`. #123 must confirm it.
- **Network.** It is set only by `sandbox.networkAccess` in the user's global `~/.cursor/cli-config.json` [11]. #123 must turn it on for workers without editing the user's own config, and must also not inherit a different value from it.
- **Project permissions.** With `--trust`, a repository's `.cursor/cli.json` can set `permissions.allow` [11]. #123 must say whether that can widen anything the sandbox doesn't already hold.
- **Web tools.** Whether web search and fetch are separate tools, and how to allow them headless.

### Tests and builds

A worker runs a project's tests with its shell tool, inside the vendor sandbox, like any other command. Build output goes in the worktree (`target/`, `node_modules/`, `dist/`), and toolchains and package caches under the home folder are read. In local experiments (Evidence), `cargo test --offline` with dependencies already in `~/.cargo` and `npm test` both passed under Codex's sandbox, including this repository's own `wisp-protocol` suite (56 tests, built from scratch in the sandbox).

What doesn't work in v1:

- **Installing dependencies, partly.** Commands can reach the registries now. But package managers write their caches under the home folder (`~/.npm`, `~/.cargo/registry`, `~/Library/Caches/pip`), and workers can't write there. Making those caches writable would let one worker poison packages for every later project. #167 decides between two ways out: point the caches at the run's temp folder, or run a setup step before the worker starts.
- **Tests that bind localhost or use Unix sockets.** All three sandboxes block both by default, and so do wispd's own server tests. #168 decides the settings (Claude `allowLocalBinding` and `allowUnixSockets`, Codex `--allow-unix-socket`, ...).
- **Docker, Apple Events, and the Keychain.** The `security` command couldn't reach the Keychain under Codex's and Cursor's sandboxes (Evidence). Claude's is untested. Its runtime's macOS profile allows Mach lookups of the Keychain services (`com.apple.SecurityServer`, `com.apple.securityd.xpc`) [13]. `denyRead` on `~/Library/Keychains` probably holds, but that is unverified. #124's checklist covers it.

### No OS layer of wisp's own around the CLI, in v1

Wrapping the whole CLI in a wisp `sandbox-exec` profile was tried and rejected:

- **The vendors' sandboxes stop working.** Under any restrictive outer Seatbelt profile, even one that only denies one read, a nested `sandbox_apply` fails with `Operation not permitted` (Evidence). Claude Code would then refuse to start under `failIfUnavailable`, and Codex's commands would fail, so wisp would be replacing the vendor sandbox rather than adding to it.
- **It can't filter the network by host.** Seatbelt filters by address and port, so an outer profile couldn't keep localhost out while letting everything else through by name.
- **It would have to allow the vendors' state writes.** Session files, `~/.claude`, `~/.codex`, and token refreshes in the Keychain all need write access, which opens exactly the files a sandboxed command must not touch.

A separate macOS user was rejected too. The user's own signed-in CLI and its Keychain entries belong to the user's account (0004); a second user needs admin setup, its own vendor login, and `safe.directory` exceptions for the repository.

wisp's own profile does have one use: commands wispd runs itself, such as a setup step if #167 picks one. Nothing nests inside those.

### What #156's runner does

#156's comment spells out the exact values:

1. Starts a worker only on a backend that implements this record: Claude now, Codex and Cursor once #122 and #123 do.
2. Before starting a Claude worker, checks the detected version (#114) against `WORKER_MIN_VERSION`, and refuses with an error that names both versions. The `system/init` check backs this up.
3. Passes `sandbox: Some(WorkerSandbox::for_worktree(home, data_dir, worktree, git_common_dir, context_dir))`, with every path canonical. Seatbelt matches real paths, and `/var` and `/tmp` are symlinks on macOS.
4. Commits the worktree's changes itself, with the git folder pinned and hooks off (#166), for every backend including Claude. `--no-verify` skips only `pre-commit` and `commit-msg` [12]. A worker can write files that git hooks run, such as `.husky/*` under `core.hooksPath`: Claude through Bash, and Codex and Cursor through any command. Cursor's sandbox also leaves the worktree's `.git` file writable, and that file says which repository git uses.

## Deferred

- Localhost and Unix sockets for tests, and this Mac's interface addresses (#168); dependency caches or a setup step (#167); and a check against a real Claude login (#124).
- Denying other accounts' configuration folders, once #114's successors give wispd a list of them.
- On Linux, denying `$XDG_RUNTIME_DIR`, which is outside the home folder (RYA-107).

## Consequences

- Workers can build, test, search, and fetch. JavaScript projects in a fresh worktree still need #167 before `npm install` works.
- A worker's own shell can't commit, or reach this Mac's services through its loopback or unspecified addresses, and an agent that expects to will see its command fail. Its prompt (#156) should say so.
- With network on, the denylist is the whole of the secrecy boundary. It can't cover every secret, and a gap in it is a leak, not just a read.
- The worker contract depends on vendor flags that change often: `--restricted` is weeks old, and Codex's permission profiles are in beta. Each adapter pins a tested CLI version (0004), and CI's argv tests pin the flags.
- Reviewing the diff is the last gate. A worker can change files that run later outside any sandbox, such as `package.json` scripts, `Makefile`, `.husky/*`, or `.vscode/tasks.json`. The Edit tool refuses some of these, but a command doesn't.

## Evidence

Local experiments on macOS 27.0 with Codex CLI 0.154.0 (`codex sandbox -P <profile>`), Cursor CLI 2026.09.10 (`agent sandbox run`), and `sandbox-exec`. None needs a vendor login. A probe script tried each operation from a simulated linked worktree whose `.git` file points to a separate git folder, with the context folder, the git folder, and a "secret" all outside the worktree and outside `/tmp`. The experiments ran with each vendor's default network setting (off), before Ryan chose network access, so the HTTPS row shows those defaults, not v1. Claude Code has no column here, because its sandbox runs only inside a session. The fake-API test after the table covers it.

| Operation | Codex `:workspace` | Codex `wisp_worker` profile | Cursor sandbox | wisp `sandbox-exec` profile |
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

Nesting: `sandbox-exec` inside `sandbox-exec` works only when the outer profile is `(allow default)` with nothing denied. With a single `deny` of writes, reads, or network, the inner `sandbox_apply` fails with `Operation not permitted` (exit 71). `codex sandbox` inside wisp's profile failed the same way.

**Claude Code, against a fake API (RYA-20).** `daemon/tests/sandbox.rs` runs Claude Code with a worker's exact arguments against a fake Messages API on 127.0.0.1. So it needs no login and sends nothing to Anthropic. The fake asks for one Bash call that runs a script in the worktree, and Claude's permission checks can't see into a script.

- **macOS.** On 2026-09-28, with Claude Code 2.1.283 on macOS 27.0, Seatbelt refused:
  - reads of `~/.ssh`, and of another project's context folder;
  - writes to the home folder, to a folder outside the data folder, and to the worktree's `.git` file.

  Writes to the worktree and the context folder went through. With `.ssh` dropped from the denylist, the test failed.
- **Linux.** CI runs the same test on x86_64 and arm64, and on 2026-09-28 it also passed in an Ubuntu 24.04 arm64 container with Claude Code 2.1.283. There it also checks that a Unix-socket connect is refused.
- **The environment.** The test gives Claude Code a worker's environment as wispd does, without `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. With the flag set, the Linux run failed: the probe wrote to the home folder, to `/tmp`, and to `/var/tmp` (RYA-20). With the flag set only in `/etc/claude-code/managed-settings.json`, the probe also wrote to the home folder. Setting the flag to `0` in the worker's `--settings` `env` changed nothing (RYA-112). `daemon/tests/worker_permission.rs` checks, against the same fake API, that a worker's Bash runs and doesn't see `ANTHROPIC_API_KEY` (RYA-110).
- **Managed settings.** Claude Code 2.1.283 reads the flag from its own environment only, after it applies every settings `env` block, with managed settings applied last. `claude --restricted sandbox status` reported scrub mode for the flag in `managed-settings.json` and in a drop-in file, but not in the user's own settings. `linux_sandbox`'s tests check that the host check refuses a real Claude Code with the flag on and accepts it with the flag off (RYA-112). Server-managed settings, `policyHelper`, and WSL's inherited settings were not tried: they need an organization or a Windows host. They go through the same settings loader.

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
