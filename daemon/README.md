# plxd

Parallax's host daemon. Each user on a macOS, Linux, or Windows host runs their own, and it keeps projects and agents running in the background. Clients reach it through `plxd attach`, either on the same machine or on a host over SSH.

Build it with `cargo build --release -p plxd`. On Linux that needs a C compiler for the bundled SQLite, such as Debian's `build-essential`, and on Windows the Visual Studio C++ build tools. `plxd --version` prints the first line of `plxd.version` beside the executable, which the app's package step writes (0030), or `Cargo.toml`'s placeholder when there is none.

The decisions behind it:

- [0007](../docs/decisions/0007-editor-plxd-protocol.md): the protocol and transport.
- [0009](../docs/decisions/0009-plxd-data-folder-and-project-host.md): the data folder and `serve`.
- [0010](../docs/decisions/0010-plxd-attach.md): `attach`.
- [0023](../docs/decisions/0023-cross-platform.md): what differs on each OS.
- [0056](../docs/decisions/0056-parallax-connect.md): Parallax Connect, `dial`, and `connect`.

## Commands

| Command | What it does |
| --- | --- |
| `plxd serve` | Serves the protocol on this user's Unix socket, or named pipe on Windows, until SIGTERM or SIGINT (Ctrl-C or Ctrl-Break on Windows) |
| `plxd attach` | Connects stdin and stdout to that socket or pipe, and starts plxd first if nothing is listening |
| `plxd dial <ADDR>` | Connects stdin and stdout to another device's plxd over Tailscale: `ADDR` is its Tailscale IP, with port 7340 unless one is given |
| `plxd connect on`, `off` | Turns Parallax Connect on or off in the data folder's settings. A running `serve` follows within 10 seconds |
| `plxd service install`, `uninstall`, `status` | macOS and Linux: manage the service that keeps `serve` running, a LaunchAgent (#61) or a systemd user unit (PLX-18) |

`serve`, `attach`, and `connect` take `--data-dir` (or `PLXD_DATA_DIR`) to use a data folder other than the default: `~/.parallax` (`%USERPROFILE%\.parallax` on Windows), or the older OS folder (`~/Library/Application Support/parallax`, `$XDG_DATA_HOME/parallax` or `~/.local/share/parallax`, `%LOCALAPPDATA%\parallax`) when `~/.parallax` doesn't exist and that one does. The socket is `plxd.sock` in that folder. When that path is too long for a Unix socket, it moves to a per-user folder: the one `getconf DARWIN_USER_TEMP_DIR` prints on macOS, and `$XDG_RUNTIME_DIR` on Linux. On Windows, `serve` listens on the named pipe `\\.\pipe\plxd-<hash>` instead, where `<hash>` is the first 16 hex digits of the SHA-256 of the data folder's path. Its ACL admits only your user, and each end checks that the other runs as your user. `attach` also takes `--connect-timeout <seconds>`, which defaults to 10 and can be at most 86400, a day.

`attach` passes bytes through unchanged and prints nothing else on stdout. You can send a request by hand:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"shell","version":"0"},"capabilities":{}}}' |
  plxd attach
```

When its input ends, `attach` keeps printing until plxd has answered everything it was sent, and then exits. The same command works through `ssh <host> plxd attach`.

If plxd isn't running, `attach` starts it through the service (the LaunchAgent on macOS, the systemd user unit on Linux) when one is installed and serves the same data folder. The service under the default label serves only the default data folder, so `plxd service install --data-dir <other>` needs `--label` as well. Otherwise it starts `plxd serve` in the background, in its own session. That `serve` keeps running after `attach` exits or the SSH connection drops, and `attach` never stops it.

### Exit codes

| Code | `serve` | `attach` and `dial` |
| --- | --- | --- |
| 0 | Stopped cleanly | The connection ended |
| 1 | Couldn't start, or failed | Failed after connecting |
| 2 | Usage error | Usage error |
| 3 | Another `serve` already runs for this data folder | |
| 4 | | Never reached plxd |

`attach` writes the reason to stderr, along with the path of plxd's log, `logs/plxd.log` in the data folder.

## Using a Mac as a host over SSH

A client on your laptop runs this command, where `<host>` is anything `ssh` accepts:

```sh
ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=~/.ssh/parallax-%C -- <host> plxd attach
```

On Windows it is `-o ControlPath=none` instead of the two `Control` options, since its OpenSSH has no ControlMaster (0007).

It uses your own ssh config, keys, and agent (0007). For that command to work, the host needs:

1. **`plxd` installed**, built as above and copied into a folder such as Homebrew's `bin`: `/opt/homebrew/bin` on Apple silicon, `/usr/local/bin` on Intel.
2. **`plxd` on the `PATH` of a non-interactive SSH command.** sshd runs `plxd attach` through your login shell as `zsh -c`, which reads `~/.zshenv` but not `~/.zprofile` or `~/.zshrc`. The `PATH` it starts with is `/usr/bin:/bin:/usr/sbin:/sbin`, so Homebrew's `bin` folder is missing. Fix it on the host. The examples use Apple silicon's `/opt/homebrew/bin`; on an Intel host, use `/usr/local/bin` instead.
   - Add Homebrew to `PATH` in `~/.zshenv`, the file zsh reads for every command:

     ```sh
     export PATH="/opt/homebrew/bin:$PATH"
     ```

   `SetEnv PATH=...` for the host in the laptop's `~/.ssh/config`, or `ssh -o SetEnv=...`, works only if the host's sshd lists `PATH` in `AcceptEnv`. macOS's sshd accepts only `LANG` and `LC_*`, so it drops `PATH`. Changing that means editing the host's sshd configuration, which affects every login, so prefer the fix above.

   To check, run `ssh <host> 'command -v plxd'`.
3. **Quiet shell startup files.** Over SSH, stdout carries the protocol, so anything the host's shell prints while it starts a non-interactive command gets mixed into it. For zsh, that output comes from `~/.zshenv`.
   - Keep output behind a check for an interactive shell, such as `[[ -o interactive ]]` in zsh.
4. **A key that logs in without prompts.** `BatchMode=yes` turns every prompt into an error. Run `ssh <host>` once in a terminal to accept the host key and unlock your key. Hosts that require interactive two-factor login aren't supported.
5. **The LaunchAgent, which is recommended** (#61). Without it, `attach` starts `plxd serve` itself.
   - A `serve` started that way inherits the SSH session's environment (#96).
   - A process started from SSH may not reach the Keychain, which the subscription CLIs use (0004).
   - The LaunchAgent runs plxd in your GUI session instead, and `attach` starts it with `launchctl kickstart` whenever it's installed.

## Using a Linux host over SSH

The client runs the same `ssh ... <host> plxd attach` command, and the host needs the same things as a Mac, apart from Homebrew and the LaunchAgent:

1. **`plxd` on the `PATH` of a non-interactive SSH command.** sshd runs `plxd attach` with the `PATH` from `/etc/environment` or its built-in default, which on Debian and Ubuntu includes `/usr/local/bin` but not `~/.local/bin`. `~/.profile` adds `~/.local/bin` only for login shells, which a command over SSH isn't.
   - Simplest: install `plxd` into `/usr/local/bin`.
   - Or keep it in `~/.local/bin` and add it in the file your shell reads for SSH commands. bash reads `~/.bashrc`, but Debian's and Ubuntu's default one returns early for non-interactive shells, so put the line above that check. zsh reads `~/.zshenv`.

     ```sh
     export PATH="$HOME/.local/bin:$PATH"
     ```

   To check, run `ssh <host> 'command -v plxd'`.
2. **Quiet shell startup files and a key that logs in without prompts**, as on a Mac.
3. **The systemd user unit, which is recommended** (PLX-18). `plxd service install` writes `~/.config/systemd/user/io.github.ryan-stoffel.parallax.plxd.service`, enables it, and starts it. `uninstall` and `status` work as on a Mac, and `attach` starts plxd with `systemctl --user start` whenever the unit is installed.
   - **Turn on linger**, once. Without it, systemd stops your user services when your last session ends and starts them again at your next login. With it, the unit starts at boot and keeps running while nobody is logged in:

     ```sh
     loginctl enable-linger
     ```

     Some distros only let root do that, with `sudo loginctl enable-linger $USER`. To check, run `loginctl show-user $USER --property=Linger`.
   - `systemctl --user` needs your user manager, which `pam_systemd` starts for an SSH login. Where it can't be reached, such as on a host without systemd, `attach` says so on stderr and starts `serve` itself.
   - The unit's `serve` appends its output to `logs/plxd.log` in the data folder, as on a Mac. That needs systemd 240 or later; an older one sends it to the journal, `journalctl --user --unit io.github.ryan-stoffel.parallax.plxd`.
   - The unit's `serve` gets the user manager's environment, not your shell's. If agent CLIs live on npm or nvm paths, add them to `PATH` in a `.conf` file in `~/.config/environment.d/`.

Without the unit, `attach` starts `serve` itself, in its own session, and it keeps running after the SSH session ends. Where logind sets `KillUserProcesses=yes`, it stops when you log out. Subscriptions and no-write runs work.

### API keys on Linux

Key accounts go in the Secret Service, the D-Bus API that GNOME Keyring and KeePassXC provide, as one item per account labeled "Parallax API key" in the default collection. `serve` needs an unlocked Secret Service on your session bus:

- On a desktop, the keyring your login unlocks works, including for a `serve` started over SSH while you're logged in.
- A headless host has none. Install one, such as `gnome-keyring`, and unlock it, or key accounts fail with `keychainUnavailable` and a message that says so. plxd never falls back to storing keys in a file. Subscriptions don't need it, because the vendor CLIs keep their own logins.

To check a host by hand, run `cargo test -p plxd --test secret_service_manual -- --ignored` on it. The test uses a throwaway service name and cleans up after itself.

Workers on Linux need `bubblewrap` and `socat`, and on Ubuntu 24.04 and later an AppArmor profile that lets `bwrap` create user namespaces ([0013](../docs/decisions/0013-worker-sandbox.md#claude-code-on-linux)). plxd checks for them before each worker starts, including Claude Code's seccomp filter, and `agent/start` fails with `workerUnavailable` naming whatever is missing.

## Using a Windows host over SSH

The client runs the same `ssh ... <host> plxd attach` command against Windows' own OpenSSH server (Settings > System > Optional features > OpenSSH Server). The host needs:

1. **`plxd.exe` on the `PATH`** of an SSH command, which runs through `cmd.exe`. The user or system `PATH` in Settings works; to check, run `ssh <host> where plxd`.
2. **A key that logs in without prompts.** For an administrator, Windows' sshd reads keys from `C:\ProgramData\ssh\administrators_authorized_keys`, not `~/.ssh/authorized_keys`.

Windows has no service yet (a scheduled task is PLX-22), so `attach` always starts `serve` itself, with no console and broken away from the SSH session's job, which Windows' sshd kills when the session ends. If the job doesn't allow that, `attach` warns that `serve` will stop with the session. `plxd.lock` stays in the data folder after `serve` stops, and a second `serve`'s exit-3 error can't name the running one's pid, because Windows' lock keeps other processes from reading the file. A Windows host can't store API keys yet (PLX-23), and Claude Code has no sandbox on native Windows, so workers are refused with `workerUnavailable`; run `plxd` in WSL2 for those (PLX-24). Subscriptions and no-write runs work. Agent CLIs run in a job object, so cancelling one closes its stdin and, after a grace period, ends everything it started.

plxd listens on its Unix socket or named pipe, and on a network port only while Parallax Connect is on (below). Otherwise SSH, with your own keys and config, is the only way in from another machine.

## Parallax Connect

While the host setting `connect` is on (`plxd connect on`, or `host/settings/set` from the app), `serve` listens on TCP port 7340 of this node's Tailscale IPv4, and nowhere else ([0056](../docs/decisions/0056-parallax-connect.md)). It checks the setting and Tailscale every 10 seconds, so a Tailscale that starts late or a new address binds or closes the listener. It finds the `tailscale` CLI on `PATH`, or where Tailscale's installer puts it. Before reading from a connection, it runs `tailscale whois` on the peer and serves only another node of this node's Tailscale user; anything else, including tagged nodes, shared nodes, and this node's own address, is closed and logged. Another device reaches it with `plxd dial <its Tailscale IP>`, which exits 4 like `attach` when it never connects.

## Testing `attach` over ssh on your machine

`cargo test -p plxd` tests `attach` through pipes, which are what ssh hands it. #95 adds a CI test through a real `ssh localhost`. To run one locally, you need these first:

- An sshd: on a Mac, Remote Login turned on in System Settings > General > Sharing; on Linux, `openssh-server`.
- A key authorized for your own account.
- localhost's host key accepted once.

Then run this from the repo root:

```sh
cargo build -p plxd
dir=$(mktemp -d /tmp/plxd-ssh.XXXXXX)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"ssh-test","version":"0"},"capabilities":{}}}' |
  ssh -T -o BatchMode=yes -o ControlMaster=no -o ControlPath=~/.ssh/parallax-%C -- localhost "PLXD_DATA_DIR=$dir $PWD/target/debug/plxd attach"
echo "exit: $?"
```

A successful answer with `"protocol":1` means the handshake went through ssh. The command exits 0 once plxd has answered, and the `serve` it started keeps running. Stop it with `kill "$(cat "$dir/plxd.lock")"`.
