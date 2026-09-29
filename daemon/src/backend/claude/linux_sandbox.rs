//! Checks that a Linux host can run Claude Code's worker sandbox, seccomp filter included, before
//! a worker starts (0013's Linux section).
//!
//! On Linux, Claude Code sandboxes each command with bubblewrap, relays its network through
//! `socat`, and blocks Unix sockets with a seccomp filter. `failIfUnavailable` covers a missing
//! `bwrap` or `socat`, but not the filter, which Claude Code treats as optional. Without it a
//! command can reach any Unix socket, including the D-Bus session bus that serves the Secret
//! Service, and `docker.sock`. Since 2.1.92 the filter ships inside Claude Code: its native build
//! runs every sandboxed command through its own binary as `ARGV0=apply-seccomp`. So
//! [`check_host`] probes that same helper, inside the namespaces Claude's sandbox uses.
//!
//! [`check_host`] also refuses a Claude Code whose managed settings turn on
//! `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, which widens every command's writes on Linux (RYA-112).

use std::os::unix::net::UnixListener;
use std::path::Path;

use serde_json::Value;

use super::WORKER_MIN_VERSION;
use crate::backend::process::Launcher;
use crate::detect::{PROBE_TIMEOUT, Ran, resolve, run};

/// The namespaces Claude Code's sandbox puts each command in (sandbox-runtime's bubblewrap
/// arguments): a new session, user, and PID namespace with no capabilities, and a fresh `/proc`.
/// The probe leaves out its network namespace and mount rules, which it doesn't need.
const BWRAP_ARGS: &[&str] = &[
    "--new-session",
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--cap-drop",
    "ALL",
    "--dev-bind",
    "/",
    "/",
    "--proc",
    "/proc",
];

/// `socat` (`$1`) connects to the Unix socket `$2`, and the shell exits with [`CONNECTED`] or
/// [`REFUSED`], codes that neither bwrap nor the helper uses.
const CONNECT: &str = r#""$1" -u OPEN:/dev/null "UNIX-CONNECT:$2" 2>/dev/null && exit 98; exit 97"#;
const CONNECTED: i32 = 98;
const REFUSED: i32 = 97;

/// The switch that keeps unprivileged programs from creating user namespaces, which Ubuntu turns
/// on from 24.04.
const APPARMOR_USERNS: &str = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/// The `claude sandbox status` field that is `"unsupported"` on Linux exactly when
/// `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is on: the flag turns off Bash auto-allow.
const SCRUB_FIELD: &str = "autoAllowBashIfSandboxedSource";

/// The first Claude Code whose `sandbox status` has [`SCRUB_FIELD`].
const STATUS_MIN_VERSION: &str = "2.1.275";

/// Checks that Claude Code's sandbox works here with its seccomp filter, for workers that run
/// `claude` through `launcher`:
///
/// 1. `bwrap` and `socat` resolve on the launcher's `PATH`, where Claude Code looks for them.
/// 2. `claude`'s settings don't turn on `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` ([`check_scrub_flag`]).
/// 3. Inside bwrap alone, `socat` connects to a Unix socket wispd listens on. If it can't, bwrap
///    can't sandbox here, as on Ubuntu 24.04 and later without a profile for it.
/// 4. Inside bwrap and `claude`'s own filter, the same connect is refused.
///
/// # Errors
///
/// What is missing or broken, and the fix, as a message for `workerUnavailable`.
pub async fn check_host(launcher: &Launcher, claude: &Path) -> Result<(), String> {
    let bwrap = resolve(launcher, "bwrap").ok_or(
        "bubblewrap (bwrap) isn't installed, and Claude Code's worker sandbox needs it on Linux; \
         install the bubblewrap package",
    )?;
    let socat = resolve(launcher, "socat").ok_or(
        "socat isn't installed, and Claude Code's worker sandbox needs it on Linux; install the \
         socat package",
    )?;
    check_scrub_flag(launcher, text(claude)?).await?;
    let dir = tempfile::tempdir()
        .map_err(|error| format!("could not make a folder to check the worker sandbox: {error}"))?;
    let socket = dir.path().join("probe.sock");
    let _listener = UnixListener::bind(&socket)
        .map_err(|error| format!("could not listen on a socket to check the sandbox: {error}"))?;
    let (bwrap, socat, socket, claude) =
        (text(&bwrap)?, text(&socat)?, text(&socket)?, text(claude)?);
    let connect = ["/bin/sh", "-c", CONNECT, "sh", socat, socket];

    let alone = sandboxed(launcher, bwrap, &[], &connect).await?;
    match alone.exit_code {
        Some(CONNECTED) => {}
        Some(REFUSED) => {
            return Err(
                "socat can't connect to a Unix socket even outside Claude Code's seccomp filter, \
                 so wispd can't check the filter"
                    .into(),
            );
        }
        _ => return Err(bwrap_problem(&alone)),
    }

    let helper = [&[claude][..], &connect].concat();
    let filtered = sandboxed(
        launcher,
        bwrap,
        &["--setenv", "ARGV0", "apply-seccomp"],
        &helper,
    )
    .await?;
    match filtered.exit_code {
        Some(REFUSED) => Ok(()),
        Some(CONNECTED) => Err(format!(
            "Claude Code's seccomp filter let a sandboxed command connect to a Unix socket, which \
             would open the D-Bus session bus and docker.sock to workers; update Claude Code to \
             {WORKER_MIN_VERSION} or later"
        )),
        _ => Err(format!(
            "Claude Code's seccomp filter (its apply-seccomp helper) could not run: {}; Claude \
             Code {WORKER_MIN_VERSION} or later has it built in on x86_64 and arm64",
            first_line(&filtered)
        )),
    }
}

/// Refuses a `claude` whose settings turn on `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. On Linux the flag
/// merges Claude Code's CI profile into every command's sandbox, which lets commands write all of
/// `/home`, `/tmp`, `/var`, `/opt`, `/run`, `/mnt`, and `/root` (0013). wispd never sets it for a
/// worker, but managed settings can, and their `env` beats both the worker's environment and its
/// `--settings`. So wispd asks Claude Code itself, which covers every managed source it loads.
/// `--restricted` makes it read the same settings a worker does.
async fn check_scrub_flag(launcher: &Launcher, claude: &str) -> Result<(), String> {
    let args = ["--restricted", "sandbox", "status"];
    let ran = run(launcher, claude, &args, PROBE_TIMEOUT)
        .await
        .map_err(|error| format!("checking Claude Code's sandbox settings failed: {error}"))?;
    let status: Value = serde_json::from_str(ran.stdout.trim()).unwrap_or_default();
    match status[SCRUB_FIELD].as_str() {
        Some("unsupported") => Err(
            "Claude Code's managed settings turn on CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which on \
             Linux lets a worker's commands write all of /home, /tmp, /var, /opt, /run, /mnt, and \
             /root; remove it from the managed settings' env"
                .into(),
        ),
        Some(_) => Ok(()),
        None => Err(format!(
            "`claude sandbox status` doesn't say whether Claude Code's settings turn on \
             CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which would widen a worker's sandbox; update Claude \
             Code to {STATUS_MIN_VERSION} or later"
        )),
    }
}

/// Runs `command` in bwrap with [`BWRAP_ARGS`] and then `options`.
async fn sandboxed(
    launcher: &Launcher,
    bwrap: &str,
    options: &[&str],
    command: &[&str],
) -> Result<Ran, String> {
    let args = [BWRAP_ARGS, options, &["--"], command].concat();
    run(launcher, bwrap, &args, PROBE_TIMEOUT)
        .await
        .map_err(|error| format!("checking Claude Code's worker sandbox failed: {error}"))
}

/// Why bwrap couldn't run a command, from how it failed.
fn bwrap_problem(ran: &Ran) -> String {
    let apparmor = std::fs::read_to_string(APPARMOR_USERNS).is_ok_and(|value| value.trim() == "1");
    if apparmor {
        return "AppArmor keeps bubblewrap from creating the user namespaces Claude Code's worker \
                sandbox needs (kernel.apparmor_restrict_unprivileged_userns is 1); add an AppArmor \
                profile for bwrap, as Claude Code's sandboxing docs describe"
            .into();
    }
    format!(
        "bubblewrap can't create Claude Code's worker sandbox here: {}",
        first_line(ran)
    )
}

fn first_line(ran: &Ran) -> String {
    match ran
        .stderr_tail
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
    {
        Some(line) => line.to_owned(),
        None => match ran.exit_code {
            Some(code) => format!("it exited with code {code} and no message"),
            None => "it was killed by a signal".to_owned(),
        },
    }
}

fn text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("{} isn't valid UTF-8", path.display()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::check_host;
    use crate::backend::process::{Environment, Launcher};
    use crate::paths::DataDir;

    /// A launcher whose environment is only `vars`, with `HOME` in `root`.
    fn launcher(root: &Path, vars: &[(&str, &str)]) -> Launcher {
        let mut env = Environment::empty();
        env.set("HOME", root);
        for (name, value) in vars {
            env.set(name, value);
        }
        Launcher::new(DataDir::new(root.join("data")).unwrap(), env)
    }

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn a_missing_bwrap_or_socat_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let claude = script(&bin, "claude", "exit 0");
        let only = launcher(dir.path(), &[("PATH", bin.to_str().unwrap())]);

        let error = check_host(&only, &claude).await.unwrap_err();
        assert!(
            error.contains("bubblewrap (bwrap) isn't installed"),
            "{error}"
        );

        script(&bin, "bwrap", "exit 0");
        let error = check_host(&only, &claude).await.unwrap_err();
        assert!(error.contains("socat isn't installed"), "{error}");
    }

    #[tokio::test]
    async fn a_claude_in_scrub_mode_or_without_its_status_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        script(&bin, "bwrap", "exit 0");
        script(&bin, "socat", "exit 0");
        let only = launcher(dir.path(), &[("PATH", bin.to_str().unwrap())]);

        // Part of what Claude Code 2.1.283 prints when managed settings turn the flag on.
        let scrubbed = script(
            &bin,
            "claude",
            r#"echo '{"statusVersion":3,"autoAllowBashIfSandboxedSource":"unsupported"}'"#,
        );
        let error = check_host(&only, &scrubbed).await.unwrap_err();
        assert!(
            error.contains("managed settings turn on CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"),
            "{error}"
        );

        // Claude Code 2.1.274 and older don't report the field.
        let old = script(
            &bin,
            "old-claude",
            r#"echo '{"statusVersion":2,"enabledSource":"off"}'"#,
        );
        let error = check_host(&only, &old).await.unwrap_err();
        assert!(error.contains("update Claude Code to 2.1.275"), "{error}");
    }

    /// The real bwrap and socat, which CI installs along with the Claude Code it names in
    /// `WISP_SANDBOX_CLAUDE` (0013).
    fn installed() -> Option<(tempfile::TempDir, Launcher, PathBuf)> {
        let claude = PathBuf::from(std::env::var_os("WISP_SANDBOX_CLAUDE")?);
        let dir = tempfile::tempdir().unwrap();
        let launcher = launcher(dir.path(), &[("PATH", INSTALLED_PATH)]);
        Some((dir, launcher, claude))
    }

    const INSTALLED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

    /// A fake `claude`'s answer to `--restricted sandbox status` with the scrub flag off.
    const STATUS_OK: &str = r#"if [ "$1" = --restricted ]; then
    echo '{"autoAllowBashIfSandboxedSource":"default"}'; exit 0
fi"#;

    #[tokio::test]
    async fn claude_code_s_own_filter_passes_the_check() {
        let Some((_dir, launcher, claude)) = installed() else {
            return;
        };
        check_host(&launcher, &claude).await.unwrap();
    }

    #[tokio::test]
    async fn a_claude_without_the_filter_is_refused() {
        let Some((dir, launcher, _)) = installed() else {
            return;
        };
        // Runs the command it is given with no filter, as a build without the helper would.
        let unfiltered = script(dir.path(), "claude", &format!("{STATUS_OK}\nexec \"$@\""));
        let error = check_host(&launcher, &unfiltered).await.unwrap_err();
        assert!(error.contains("let a sandboxed command connect"), "{error}");

        let broken = script(
            dir.path(),
            "broken-claude",
            &format!("{STATUS_OK}\necho 'no helper here' >&2; exit 1"),
        );
        let error = check_host(&launcher, &broken).await.unwrap_err();
        assert!(error.contains("could not run: no helper here"), "{error}");
    }

    #[tokio::test]
    async fn a_claude_with_the_scrub_flag_on_is_refused() {
        let Some((dir, _, claude)) = installed() else {
            return;
        };
        // Where a managed settings `env` block puts the flag: Claude Code's own environment.
        let scrubbed = launcher(
            dir.path(),
            &[
                ("PATH", INSTALLED_PATH),
                ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"),
            ],
        );
        let error = check_host(&scrubbed, &claude).await.unwrap_err();
        assert!(
            error.contains("managed settings turn on CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"),
            "{error}"
        );
    }
}
