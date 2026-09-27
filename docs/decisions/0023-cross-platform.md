# 0023: wisp on macOS, Windows, and Linux

- Status: accepted
- Date: 2026-09-27
- Issue: RYA-7

## Context

`docs/PLAN.md` lists Windows and Linux as non-goals, and `wispd` builds only on macOS. The desktop app (0022) targets all three OSes, and a host can be any of them. These parts of `daemon/` are macOS-only today:

- **Transport:** a Unix socket with `getpeereid`, and a `getconf DARWIN_USER_TEMP_DIR` fallback for long paths (0007).
- **Data folder:** `~/Library/Application Support/wisp`, with a `flock` lock (0009).
- **Starting `serve`:** `posix_spawn` with `POSIX_SPAWN_SETSID` and `POSIX_SPAWN_CLOEXEC_DEFAULT`, the second of which only Apple has (0010).
- **Service:** a LaunchAgent, driven with `launchctl` (0010).
- **Agent CLIs:** cancel sends signals to the CLI's process group (0014). Missing `PATH` entries are filled in with `/opt/homebrew/bin` and friends.
- **Secrets:** API keys go in the Keychain through `security-framework` (0004).
- **File watching:** `notify` with FSEvents (0005).
- **Worker sandbox:** Claude Code's Seatbelt sandbox, with a list of unreadable paths that only makes sense on macOS (0013).

This record gives each of these an answer per OS. RYA-17 to RYA-25, RYA-29, RYA-64, and RYA-66 build on it.

## Decision

Windows and Linux are supported, for the app and for `wispd`. This supersedes PLAN.md's non-goal. Each OS keeps 0007's model: one `wispd` per user, reached only through `wispd attach` on stdio, locally or over `ssh`.

### Per OS

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Data folder | `~/Library/Application Support/wisp` | `$XDG_DATA_HOME/wisp`, or `~/.local/share/wisp` | `%LOCALAPPDATA%\wisp` |
| `serve` listens on | `wispd.sock` in the data folder. Past 103 bytes: `$(getconf DARWIN_USER_TEMP_DIR)wispd-<hash>.sock` | `wispd.sock` in the data folder. Past 107 bytes: `$XDG_RUNTIME_DIR/wispd-<hash>.sock` | The named pipe `\\.\pipe\wispd-<hash>` |
| Only this user connects | 0700 folder, 0600 socket, `peer_cred` | Same as macOS | The pipe's DACL grants only the user's SID. Both ends check the other's SID |
| One `serve` per folder | `wispd.lock` with std's `File::try_lock` | Same | Same |
| `attach` detaches `serve` | `posix_spawn`, `SETSID`, `CLOEXEC_DEFAULT` | `posix_spawn`, `SETSID`, `posix_spawn_file_actions_addclosefrom_np(3)` | `CreateProcess` with `DETACHED_PROCESS`, `CREATE_NEW_PROCESS_GROUP`, `CREATE_BREAKAWAY_FROM_JOB`, and a handle list |
| Cancelling an agent CLI | Signal, then `SIGKILL` to its process group | Same | Close stdin, then terminate its job object |
| Keeps `serve` running | LaunchAgent in `gui/<uid>` | systemd user unit `<label>.service`, with `loginctl enable-linger` | Per-user scheduled task with a logon trigger |
| API keys | Keychain, through `security-framework` | Secret Service, through `keyring-core` and `zbus-secret-service-keyring-store` | Credential Manager, through `keyring-core` and `windows-native-keyring-store` |
| Context watcher | `notify`: FSEvents | `notify`: inotify | `notify`: `ReadDirectoryChangesW` |
| `PATH` fill-in (0014) | `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, system folders | `~/.local/bin`, `/usr/local/bin`, system folders | `%USERPROFILE%\.local\bin` |
| Claude workers | Seatbelt (0013) | bubblewrap, `socat`, and the seccomp filter | Refused natively. Run `wispd` in WSL2 |
| The app's `ssh` | `ssh` on `PATH` | `ssh` on `PATH` | `ssh.exe` on `PATH`, from Windows' OpenSSH Client |

`<hash>` is the first 8 hex digits of the SHA-256 of the data folder's path, as in 0007. The pipe name uses the first 16, since pipe names share one machine-wide namespace. `--data-dir` and `WISPD_DATA_DIR` still override the data folder on every OS (0009).

### Paths

- wispd reads the data folder's location from the environment, with no crate. `XDG_DATA_HOME` counts only when it is absolute, as the XDG spec says. A missing `HOME` or `LOCALAPPDATA` is a startup error.
- **Linux socket.** The socket stays in the data folder, as on macOS. The runtime folder is only the fallback for long paths, because `logind` deletes it at the last logout, while a `serve` that attach started keeps running. 0007's check that rebinds a missing socket every minute covers that folder too. Without `XDG_RUNTIME_DIR`, a path that is too long is an error.
- **Windows data folder.** wispd checks that the folder isn't a reparse point. It doesn't rewrite the ACL, because `%LOCALAPPDATA%` already grants only the user, SYSTEM, and Administrators.

### Windows transport

- **Named pipes, not AF_UNIX sockets.**
  - Windows has had AF_UNIX since Windows 10 1803, but neither tokio nor std supports it there, and it has no `SO_PEERCRED`.
  - tokio has named pipes built in (`tokio::net::windows::named_pipe`). A pipe also takes a real per-user ACL.
- **Server.**
  - `first_pipe_instance(true)` makes `serve` fail if someone else already created the name.
  - `reject_remote_clients(true)` keeps out SMB clients. It is tokio's default.
  - The security descriptor is `D:P(A;;GA;;;<user SID>)`, so only the user has access. Windows' default one gives Everyone read access.
  - Like `getpeereid` in 0007, `serve` checks the client's SID through `GetNamedPipeClientProcessId`.
- **Client.**
  - Any user can create a pipe under any name. So `attach` and `wispd mcp` check that the server's process runs as their own user (`GetNamedPipeServerProcessId`) before sending anything. A mismatch fails at once with exit 4.
  - `ERROR_FILE_NOT_FOUND` means no `serve` is running, so attach starts one, like `ENOENT` in 0010.
  - `ERROR_PIPE_BUSY` means retry within the connect timeout. Any other error fails at once.
- **Unsafe code.** tokio's security-attributes hook is `unsafe`, and std wraps none of these calls. They are the pipe's security descriptor, the two SID checks, the child's handle list, and job objects. All of them live in one Windows-only module that calls `windows-sys`. That module is the only place with `#[allow(unsafe_code)]`, and each call gets a `SAFETY` comment. The workspace lint stays `deny`.

### Starting and stopping `serve`

- **Linux** uses 0010's `posix_spawn` with `POSIX_SPAWN_SETSID`. `POSIX_SPAWN_CLOEXEC_DEFAULT` doesn't exist there, so `posix_spawn_file_actions_addclosefrom_np(3)` (glibc 2.34) closes every descriptor above stdio instead (#86).
- **Windows.** Win32-OpenSSH puts each session in a job object and kills the job when the session ends. It has let processes break away from that job since v7.6.0.0p1.
  - attach starts `serve` with `CREATE_BREAKAWAY_FROM_JOB`, so `serve` outlives the session. If the job forbids breakaway, attach retries without the flag and warns that `serve` will end with the session.
  - `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` passes exactly three handles: stdin on `NUL`, and stdout and stderr on the log. This is #86 on Windows.
- **Shutdown on Windows.** `serve` treats Ctrl-C, Ctrl-Break, console close, logoff, and shutdown (`tokio::signal::windows`) as it treats SIGTERM.
- **Services.** Each one is named after 0010's label, and attach starts it the way 0010 uses `launchctl kickstart`:
  - **Linux:** a systemd user unit at `~/.config/systemd/user/<label>.service`, started with `systemctl --user start`. With linger, it runs with nobody logged in. Hosts without systemd rely on attach's detached `serve`.
  - **Windows:** a scheduled task named `<label>`. It is registered from XML with `schtasks /create /xml`, and runs with `LogonType` `InteractiveToken` and `RunLevel` `LeastPrivilege`.
    - Its logon trigger names the user (`LogonTrigger/UserId`). That lets a standard user create it without admin rights, where `schtasks /sc onlogon` needs them.
    - attach starts it with `schtasks /run`. It can't run while the user isn't logged on, so attach then starts `serve` itself, as on a Mac where nobody has logged in.
    - No console window may stay open. RYA-22 picks how to hide it.

### Secrets

- The `KeyStore` interface stays. macOS keeps `security-framework`, whose error codes wispd already maps (0004).
- Linux and Windows use `keyring-core` with one store crate each:
  - Linux uses the zbus store rather than the dbus one. zbus is pure Rust, so the Linux build links no `libdbus`.
  - Windows' store needs no unsafe code of ours.
- **Headless hosts** have the same problem on every OS. A key-authenticated SSH session can't unlock the store:
  - macOS: a locked Keychain (0004).
  - Linux: no unlocked Secret Service.
  - Windows: Win32-OpenSSH logs keys in with S4U, which has no DPAPI and so no Credential Manager.
  - In each case, key accounts fail with an error that names the fix: run `serve` from the service in a logged-in session, or install a Secret Service. There is never a plaintext fallback. Subscriptions are unaffected, because the vendor CLIs keep their own logins (0004).

### Worker sandbox

0013's contract doesn't change: every backend refuses a `workspace-write` run without its vendor's OS sandbox. `Capabilities::worker_sandbox` becomes per OS.

- **Linux: Claude Code.** It sandboxes Bash with bubblewrap, and routes network traffic through its proxy with `socat`. It supports Linux and WSL2, but not WSL1.
  - The same `worker_settings` apply, and wispd never sets `enableWeakerNestedSandbox`.
  - wispd also requires Claude Code's optional seccomp filter, from `@anthropic-ai/sandbox-runtime`. Without it, sandboxed commands can connect to any Unix socket. On Linux that includes the D-Bus session bus that serves the Secret Service, and `docker.sock`. On macOS, Seatbelt blocks these by default (0013).
  - A missing `bwrap`, `socat`, or filter fails `agent/start` with `workerUnavailable` naming it. So does an AppArmor policy that keeps `bwrap` from creating user namespaces (Ubuntu 24.04 and later).
  - `UNREADABLE_IN_HOME` becomes a list per OS. RYA-20 adds Linux's.
- **Linux: Codex.** It sandboxes with bubblewrap and seccomp, and its permission profiles work on Linux. RYA-38 uses the same profile as on macOS.
- **Windows: Claude Code.** It has no sandbox on native Windows and says to use WSL2. So the Claude backend reports `worker_sandbox: false` there. `workspace-write` runs fail with `workerUnavailable`, and the message names WSL2. No-write runs, such as the coordinator and normal threads, still run natively.
- **Windows: Codex.** It has a native sandbox, and its permission profiles, deny rules included, are supported on native Windows. Codex workers may run natively once RYA-38 and RYA-24 confirm that 0013's contract holds there. Until then they are refused too. Only the `elevated` sandbox mode counts, and it needs a one-time admin setup. The `unelevated` mode has no separate sandbox user and weaker network isolation.
- **WSL2 is how a Windows machine runs Claude workers.** `wispd` for Linux runs inside a WSL2 distro, with Linux's sandbox. The app reaches it as a host by running `wsl.exe --distribution <name> -- wispd attach` instead of `ssh`. That keeps 0022's rule that the main process owns every process and speaks over stdio. RYA-86 builds it.

### The app's `ssh` on Windows

- The main process runs `ssh` from `PATH` on every OS, and a setting can override the path.
- On Windows, that is `C:\Windows\System32\OpenSSH\ssh.exe`, from the OpenSSH Client optional feature (Windows 10 1809 and later). When it is missing, the app says to install that feature.
- 0022's command line doesn't change. RYA-26 checks that Windows' OpenSSH accepts `-o ControlPath=none`, and drops the option on Windows if it doesn't.
- Keys with a passphrase need the `ssh-agent` Windows service, which is disabled by default. The error for a key that needs a passphrase says so.

### OS and arch coverage

| Target | Rust target | PR CI (`ci.yml`) | Built on `develop` and released |
| --- | --- | --- | --- |
| macOS arm64 | `aarch64-apple-darwin` | `check-rust`, ssh attach check, app | Yes |
| Linux x86_64 | `x86_64-unknown-linux-gnu` | `check-rust`, ssh attach check, app | Yes |
| Linux arm64 | `aarch64-unknown-linux-gnu` | No | Yes |
| Windows x86_64 | `x86_64-pc-windows-msvc` | `check-rust`, app; the ssh attach check once the runner's `sshd` can be set up | Yes |
| Windows arm64 | `aarch64-pc-windows-msvc` | No | Yes |

- **PR CI** tests one arch per OS, to keep it fast. The arm64 builds for Linux and Windows run on GitHub's arm64 runners, with `wispd --version` and an attach handshake as a smoke check (RYA-29).
- **Linux binaries** are built on the oldest Ubuntu LTS runner GitHub offers, now 22.04, so they need glibc 2.35 or later. That covers Ubuntu 22.04, Debian 12, and RHEL 10. glibc keeps `posix_spawn_file_actions_addclosefrom_np`, which musl doesn't have.
- **macOS x86_64 isn't built.** 0006's reason still holds: macOS 27 runs only on Apple silicon. Adding it later is one more target on the macOS runner.
- **Windows** needs Windows 10 1809 or later, or Windows 11. That's the first version with the OpenSSH Client feature and ConPTY.
- **Releases** ship the app for these five targets. Each package bundles the local `wispd` and the others, for installs on remote hosts (RYA-66). Installer formats and signing are RYA-64's.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| AF_UNIX sockets on Windows, for one code path | Neither tokio nor std supports them on Windows, so wisp would need its own async wrapper. They also have no `SO_PEERCRED`. |
| `interprocess`, for sockets and pipes behind one API | The Unix side already runs on tokio's sockets. The Windows ACL still needs the same Win32 calls. |
| Socket in `$XDG_RUNTIME_DIR` by default on Linux | `logind` deletes that folder at the last logout, while a `serve` started over ssh keeps running. |
| A static musl build for Linux | musl lacks `posix_spawn_file_actions_addclosefrom_np`. A glibc 2.35 floor covers current LTS distros. |
| The `keyring` crate with every store | It pulls in stores wisp doesn't use. On macOS, it would swap working code for the same call with coarser errors. |
| `dirs` or `directories` for the data folder | Three environment variables, one per OS. |
| A Windows service (SCM) | Needs admin rights, and runs outside the user's logon, so Credential Manager can't be reached. |
| The `HKCU\...\Run` key | Runs only at an interactive logon, which the scheduled task also covers. It can't be started on demand the way attach needs. |
| On Windows, run `wispd` only inside WSL2 | Removes the native Windows work, but Windows users keep repositories on NTFS. Codex also has a native sandbox, and no-write runs need none. |
| On Windows, run Claude workers unsandboxed with a warning | Breaks 0013's contract. With network access on, anything a worker reads can leave the machine. |
| A wisp-owned Windows sandbox (AppContainer, restricted tokens) | A second sandbox to build and maintain. On macOS, an outer layer broke the vendor's own sandbox (0013). |

## Consequences

- **Supersedes** PLAN.md's non-goal of Windows and Linux (RYA-8 rewrites the plan). It also extends 0004's Keychain, 0007's transport, 0009's data folder, 0010's LaunchAgent and `posix_spawn`, 0013's sandbox, and 0014's `PATH` to three OSes. On macOS, their decisions stand as written, except that the lock moves from `rustix`'s `flock` to std's `File::try_lock`, which calls `flock` there.
- **RYA-17** (wispd on Linux) implements the Linux column, with the socket in the data folder by default. **RYA-18** installs the systemd user unit, and **RYA-19** adds the Secret Service store. **RYA-20** adds the Linux sandbox, including the seccomp-filter requirement.
- **RYA-21** (wispd on Windows) implements the Windows column: the pipe, the unsafe module, breakaway, and the handle list. It also covers `.cmd` shims: std's `Command` finds only `.exe` on `PATH`, and refuses batch-file arguments it can't escape. So the error for such a refusal suggests the vendor's native installer. RYA-21 also checks that `core.hooksPath=/dev/null` disables hooks under Git for Windows, or uses `NUL`.
- **RYA-22** registers the scheduled task, **RYA-23** adds the Credential Manager store, and **RYA-24** makes the native refusal and its WSL2 message.
- **RYA-86** reaches a WSL2 distro as a host from the Windows app. Until it lands, a Windows user who wants Claude workers adds the distro as an SSH host.
- **RYA-25** runs `check-rust` on three OSes. **RYA-29** builds the five targets, and **RYA-64** and **RYA-66** package them.
- **New dependencies:**
  - Linux: `keyring-core` and `zbus-secret-service-keyring-store`.
  - Windows: `keyring-core`, `windows-native-keyring-store`, and `windows-sys`, which tokio already pulls in there.
  - Each is a target-specific dependency, so the macOS build doesn't change. `nix` and `rustix` become Unix-only.
- **Headless hosts** can use subscriptions everywhere. They can't store API keys unless `serve` runs from the service in a logged-in session (macOS, Windows) or has a Secret Service (Linux).
- **Linux hosts need setup for workers.** Without `bubblewrap`, `socat`, and the seccomp filter, and on Ubuntu 24.04 and later an AppArmor profile for `bwrap`, a Linux host runs only no-write agents.
