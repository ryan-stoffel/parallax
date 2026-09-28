# CI entry points

Workflows call these scripts instead of running cargo or pnpm themselves, so a local run is the same as a CI run. Each script finds the repo root on its own, so it runs from any directory.

| Script | What it does | Called by |
| --- | --- | --- |
| `check-rust` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build`, and `cargo test` on the workspace, with `--locked`. The tests include the protocol sample checks and the generated TypeScript staleness check. | `ci.yml`, `rust` job on macOS arm64, Linux x86_64 and arm64, and Windows x86_64 and arm64 |
| `check-app` | In `apps/desktop/`: `pnpm install --frozen-lockfile`, `pnpm check` (format, lint, type-check), `pnpm test`, and `pnpm build`. | `ci.yml`, `app` job on macOS, Linux, and Windows |
| `launch-app` | Launches the app `check-app` built, with a check preloaded into its main process (`electron -r`), and fails unless the window loads, `window.wisp` answers over IPC, and React renders, with no renderer console errors (CSP violations included), then checks the app quits with exit 0. Gives up after 60 seconds. Downloads Electron's binary on first run. On Linux with no `DISPLAY` it runs under `xvfb-run`. | `ci.yml`, `app` job on macOS, Linux, and Windows |
| `e2e-app` | Builds `wispd` with `--features fake-backend` and the app, then runs `pnpm e2e`: Playwright launches the built app against that `wispd` (`WISPD_PATH`) in a temporary data folder, with `WISPD_FAKE_BACKEND` naming the script its workers play, and checks connecting, starting a thread, its output, and Stop. | `ci.yml`, `e2e` job on macOS |
| `ssh-localhost` | Sets up key-based ssh to localhost with a throwaway key and its own sshd, and writes whether ssh is ready to a status file. Skips cleanly where it can't run. | `ci.yml`, `rust` job on macOS arm64 and Linux x86_64 and arm64 |
| `ssh-localhost.ps1` | The same for Windows, through the image's own OpenSSH server (the `sshd` service) on port 22, whose sessions run in a job object as they do on a Windows host. | `ci.yml`, `rust` job on Windows x86_64 and arm64 |
| `check-ssh-attach` | Runs `wispd attach` through a real `ssh localhost` (#95) and checks the handshake answer, the ssh exit, and that `serve` outlives the session. Skips when ssh isn't ready, unless `WISP_E2E_REQUIRE_SSH=1`. `WISP_E2E_SSH` picks the ssh client. | `ci.yml`, `rust` job on every OS |

## Requirements

- Rust: rustup. `rust-toolchain.toml` pins the toolchain and its components. In CI, run `rustup toolchain install` with no arguments as its own step before `check-rust`.
- Node, any recent version, for `check-ssh-attach`. GitHub's macOS and Linux runners have it. On Linux, `ssh-localhost` needs `openssh-server`, which the workflow installs when the image lacks it.
- Node 24 and pnpm through corepack (`corepack enable`) for `check-app`. In CI, `setup-node` reads `apps/desktop/.node-version` and the pnpm store is cached per OS on the lockfile's hash, so a warm run skips the downloads.
- `launch-app` runs after `check-app`. `pnpm install` doesn't fetch Electron's binary; requiring `electron` does, into `$electron_config_cache` (CI caches that directory per OS on the Electron version) or Electron's default cache. On Linux it needs `xvfb-run` when there is no display, and a working Chromium sandbox: on Ubuntu 24.04 and later, AppArmor blocks it until `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, which the workflow runs. The check keeps the sandbox on rather than pass `--no-sandbox`.
- `e2e-app` needs rustup for `wispd` and Node 24 with pnpm for the app; Electron's binary arrives as it does for `launch-app`. Release builds refuse the `fake-backend` feature, and a `wispd` built without it refuses to start while `WISPD_FAKE_BACKEND` is set.
- On Windows the scripts run in Git Bash, the workflow's default shell, except `ssh-localhost.ps1`, which runs in PowerShell 7. If the image lacks rustup, the workflow installs it first. `.gitattributes` keeps checkouts LF so they pass the formatter.

## Protocol samples

Every message in `crates/wisp-protocol/samples/v<N>/` must still decode, so a change that is not additive fails `check-rust`. The rules for adding samples are in the crate's docs.

## Protocol types

The app's TypeScript protocol types, `apps/desktop/src/protocol/generated/protocol.ts`, are generated from `wisp-protocol` and committed. After changing a protocol type, run `cargo run -p wisp-protocol --bin generate-typescript` and commit the result. A test in `cargo test` regenerates the file in memory, so `check-rust` fails while the committed copy is stale.
