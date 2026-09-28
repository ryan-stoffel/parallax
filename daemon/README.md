# wispd

wisp's host daemon. Each user on a macOS, Linux, or Windows host runs their own, and it keeps projects and agents running in the background. Clients reach it through `wispd attach`, either on the same machine or on a host over SSH.

Build it with `cargo build --release -p wispd`. On Linux that needs a C compiler for the bundled SQLite, such as Debian's `build-essential`, and on Windows the Visual Studio C++ build tools. `WISP_VERSION`, if set at compile time, is what `wispd --version` prints (`daemon/src/lib.rs` reads it with `option_env!`); otherwise it prints `Cargo.toml`'s placeholder.

The decisions behind it:

- [0007](../docs/decisions/0007-editor-wispd-protocol.md): the protocol and transport.
- [0009](../docs/decisions/0009-wispd-data-folder-and-project-host.md): the data folder and `serve`.
- [0010](../docs/decisions/0010-wispd-attach.md): `attach`.
- [0023](../docs/decisions/0023-cross-platform.md): what differs on each OS.

## Commands

| Command | What it does |
| --- | --- |
| `wispd serve` | Serves the protocol on this user's Unix socket, or named pipe on Windows, until SIGTERM or SIGINT (Ctrl-C or Ctrl-Break on Windows) |
| `wispd attach` | Connects stdin and stdout to that socket or pipe, and starts wispd first if nothing is listening |
| `wispd service install`, `uninstall`, `status` | macOS and Linux: manage the service that keeps `serve` running, a LaunchAgent (#61) or a systemd user unit (RYA-18) |

Both commands take `--data-dir` (or `WISPD_DATA_DIR`) to use a data folder other than the default: `~/Library/Application Support/wisp` on macOS, `$XDG_DATA_HOME/wisp` on Linux, or `~/.local/share/wisp` when `XDG_DATA_HOME` is unset, and `%LOCALAPPDATA%\wisp` on Windows. The socket is `wispd.sock` in that folder. When that path is too long for a Unix socket, it moves to a per-user folder: the one `getconf DARWIN_USER_TEMP_DIR` prints on macOS, and `$XDG_RUNTIME_DIR` on Linux. On Windows, `serve` listens on the named pipe `\\.\pipe\wispd-<hash>` instead, where `<hash>` is the first 16 hex digits of the SHA-256 of the data folder's path. Its ACL admits only your user, and each end checks that the other runs as your user. `attach` also takes `--connect-timeout <seconds>`, which defaults to 10 and can be at most 86400, a day.

`attach` passes bytes through unchanged and prints nothing else on stdout. You can send a request by hand:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"shell","version":"0"},"capabilities":{}}}' |
  wispd attach
```

When its input ends, `attach` keeps printing until wispd has answered everything it was sent, and then exits. The same command works through `ssh <host> wispd attach`.

If wispd isn't running, `attach` starts it through the service (the LaunchAgent on macOS, the systemd user unit on Linux) when one is installed and serves the same data folder. The service under the default label serves only the default data folder, so `wispd service install --data-dir <other>` needs `--label` as well. Otherwise it starts `wispd serve` in the background, in its own session. That `serve` keeps running after `attach` exits or the SSH connection drops, and `attach` never stops it.

### Exit codes

| Code | `serve` | `attach` |
| --- | --- | --- |
| 0 | Stopped cleanly | The connection ended |
| 1 | Couldn't start, or failed | Failed after connecting |
| 2 | Usage error | Usage error |
| 3 | Another `serve` already runs for this data folder | |
| 4 | | Never reached wispd |

`attach` writes the reason to stderr, along with the path of wispd's log, `logs/wispd.log` in the data folder.

## Using a Mac as a host over SSH

A client on your laptop runs this command, where `<host>` is anything `ssh` accepts:

```sh
ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ControlPath=none -- <host> wispd attach
```

It uses your own ssh config, keys, and agent (0007). For that command to work, the host needs:

1. **`wispd` installed**, built as above and copied into a folder such as Homebrew's `bin`: `/opt/homebrew/bin` on Apple silicon, `/usr/local/bin` on Intel.
2. **`wispd` on the `PATH` of a non-interactive SSH command.** sshd runs `wispd attach` through your login shell as `zsh -c`, which reads `~/.zshenv` but not `~/.zprofile` or `~/.zshrc`. The `PATH` it starts with is `/usr/bin:/bin:/usr/sbin:/sbin`, so Homebrew's `bin` folder is missing. Fix it on the host. The examples use Apple silicon's `/opt/homebrew/bin`; on an Intel host, use `/usr/local/bin` instead.
   - Add Homebrew to `PATH` in `~/.zshenv`, the file zsh reads for every command:

     ```sh
     export PATH="/opt/homebrew/bin:$PATH"
     ```

   `SetEnv PATH=...` for the host in the laptop's `~/.ssh/config`, or `ssh -o SetEnv=...`, works only if the host's sshd lists `PATH` in `AcceptEnv`. macOS's sshd accepts only `LANG` and `LC_*`, so it drops `PATH`. Changing that means editing the host's sshd configuration, which affects every login, so prefer the fix above.

   To check, run `ssh <host> 'command -v wispd'`.
3. **Quiet shell startup files.** Over SSH, stdout carries the protocol, so anything the host's shell prints while it starts a non-interactive command gets mixed into it. For zsh, that output comes from `~/.zshenv`.
   - Keep output behind a check for an interactive shell, such as `[[ -o interactive ]]` in zsh.
4. **A key that logs in without prompts.** `BatchMode=yes` turns every prompt into an error. Run `ssh <host>` once in a terminal to accept the host key and unlock your key. Hosts that require interactive two-factor login aren't supported.
5. **The LaunchAgent, which is recommended** (#61). Without it, `attach` starts `wispd serve` itself.
   - A `serve` started that way inherits the SSH session's environment (#96).
   - A process started from SSH may not reach the Keychain, which the subscription CLIs use (0004).
   - The LaunchAgent runs wispd in your GUI session instead, and `attach` starts it with `launchctl kickstart` whenever it's installed.

## Using a Linux host over SSH

The client runs the same `ssh ... <host> wispd attach` command, and the host needs the same things as a Mac, apart from Homebrew and the LaunchAgent:

1. **`wispd` on the `PATH` of a non-interactive SSH command.** sshd runs `wispd attach` with the `PATH` from `/etc/environment` or its built-in default, which on Debian and Ubuntu includes `/usr/local/bin` but not `~/.local/bin`. `~/.profile` adds `~/.local/bin` only for login shells, which a command over SSH isn't.
   - Simplest: install `wispd` into `/usr/local/bin`.
   - Or keep it in `~/.local/bin` and add it in the file your shell reads for SSH commands. bash reads `~/.bashrc`, but Debian's and Ubuntu's default one returns early for non-interactive shells, so put the line above that check. zsh reads `~/.zshenv`.

     ```sh
     export PATH="$HOME/.local/bin:$PATH"
     ```

   To check, run `ssh <host> 'command -v wispd'`.
2. **Quiet shell startup files and a key that logs in without prompts**, as on a Mac.
3. **The systemd user unit, which is recommended** (RYA-18). `wispd service install` writes `~/.config/systemd/user/io.github.ryan-stoffel.wisp.wispd.service`, enables it, and starts it. `uninstall` and `status` work as on a Mac, and `attach` starts wispd with `systemctl --user start` whenever the unit is installed.
   - **Turn on linger**, once. Without it, systemd stops your user services when your last session ends and starts them again at your next login. With it, the unit starts at boot and keeps running while nobody is logged in:

     ```sh
     loginctl enable-linger
     ```

     Some distros only let root do that, with `sudo loginctl enable-linger $USER`. To check, run `loginctl show-user $USER --property=Linger`.
   - `systemctl --user` needs your user manager, which `pam_systemd` starts for an SSH login. Where it can't be reached, such as on a host without systemd, `attach` says so on stderr and starts `serve` itself.
   - The unit's `serve` appends its output to `logs/wispd.log` in the data folder, as on a Mac. That needs systemd 240 or later; an older one sends it to the journal, `journalctl --user --unit io.github.ryan-stoffel.wisp.wispd`.

Without the unit, `attach` starts `serve` itself, in its own session, and it keeps running after the SSH session ends. Where logind sets `KillUserProcesses=yes`, it stops when you log out. For now, a Linux host also can't store API keys (RYA-19) or run workers (RYA-20): key accounts fail with `keychainUnavailable`, and `agent/start` for a worker fails with `workerUnavailable`. Subscriptions and no-write runs work.

## Using a Windows host over SSH

The client runs the same `ssh ... <host> wispd attach` command against Windows' own OpenSSH server (Settings > System > Optional features > OpenSSH Server). The host needs:

1. **`wispd.exe` on the `PATH`** of an SSH command, which runs through `cmd.exe`. The user or system `PATH` in Settings works; to check, run `ssh <host> where wispd`.
2. **A key that logs in without prompts.** For an administrator, Windows' sshd reads keys from `C:\ProgramData\ssh\administrators_authorized_keys`, not `~/.ssh/authorized_keys`.

Windows has no service yet (a scheduled task is RYA-22), so `attach` always starts `serve` itself, with no console and broken away from the SSH session's job, which Windows' sshd kills when the session ends. If the job doesn't allow that, `attach` warns that `serve` will stop with the session. `wispd.lock` stays in the data folder after `serve` stops, and a second `serve`'s exit-3 error can't name the running one's pid, because Windows' lock keeps other processes from reading the file. A Windows host can't store API keys yet (RYA-23), and Claude Code has no sandbox on native Windows, so workers are refused with `workerUnavailable`; run `wispd` in WSL2 for those (RYA-24). Subscriptions and no-write runs work. Agent CLIs run in a job object, so cancelling one closes its stdin and, after a grace period, ends everything it started.

wispd listens only on its Unix socket or named pipe, never on a network port. SSH, with your own keys and config, is the only way in from another machine.

## Testing `attach` over ssh on your machine

`cargo test -p wispd` tests `attach` through pipes, which are what ssh hands it. #95 adds a CI test through a real `ssh localhost`. To run one locally, you need these first:

- An sshd: on a Mac, Remote Login turned on in System Settings > General > Sharing; on Linux, `openssh-server`.
- A key authorized for your own account.
- localhost's host key accepted once.

Then run this from the repo root:

```sh
cargo build -p wispd
dir=$(mktemp -d /tmp/wispd-ssh.XXXXXX)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"ssh-test","version":"0"},"capabilities":{}}}' |
  ssh -T -o BatchMode=yes -o ControlPath=none -- localhost "WISPD_DATA_DIR=$dir $PWD/target/debug/wispd attach"
echo "exit: $?"
```

A successful answer with `"protocol":1` means the handshake went through ssh. The command exits 0 once wispd has answered, and the `serve` it started keeps running. Stop it with `kill "$(cat "$dir/wispd.lock")"`.
