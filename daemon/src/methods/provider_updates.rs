//! `providerUpdates` (PLX-746): `providers/updates` compares each installed Claude Code and Codex
//! with its npm package's latest release, and `providers/upgrade` runs the CLI's own `update`,
//! which knows whether npm or its native installer put it there, or `brew upgrade` for a Homebrew
//! install, since `claude update` only prints that command (PLX-762).

use std::path::Path;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    CliKind, ProviderUpdate, ProvidersUpdatesParams, ProvidersUpdatesResult,
    ProvidersUpgradeParams, ProvidersUpgradeResult,
};
use serde_json::Value;

use super::Context;
use crate::detect::{self, probe_spec};
use crate::self_update::{compare, parse_version};

/// The CLIs plxd updates, and the npm package each one's releases are published as.
const PACKAGES: [(CliKind, &str); 2] = [
    (CliKind::Claude, "@anthropic-ai/claude-code"),
    (CliKind::Codex, "@openai/codex"),
];

/// How long the registry may take to answer.
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a CLI's own `update` may take, download included.
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(600);

/// `providers/updates`: each installed CLI in [`PACKAGES`] whose latest release is newer. A CLI
/// whose version or latest release plxd can't read is left out.
pub(crate) async fn updates(
    context: &Context,
    _: ProvidersUpdatesParams,
) -> Result<ProvidersUpdatesResult, ErrorObject> {
    let checks = PACKAGES.map(|(cli, package)| async move {
        let found = context.daemon.cli_detector.get(cli).await;
        let version = found.version.filter(|_| found.installed)?;
        let latest = latest(context, package).await?;
        newer(&version, &latest).then_some(ProviderUpdate {
            cli,
            version,
            latest,
        })
    });
    let found = futures_util::future::join_all(checks).await;
    Ok(ProvidersUpdatesResult {
        updates: found.into_iter().flatten().collect(),
    })
}

/// `providers/upgrade`: runs `<cli> update`, or `brew upgrade` for a Homebrew install, then probes
/// the CLI again for its version. A version that didn't change is an error, with the command's
/// output saying why.
pub(crate) async fn upgrade(
    context: &Context,
    params: ProvidersUpgradeParams,
) -> Result<ProvidersUpgradeResult, ErrorObject> {
    let detector = &context.daemon.cli_detector;
    if !PACKAGES.iter().any(|(cli, _)| *cli == params.cli) {
        return Err(ErrorObject::invalid_params(
            "plxd updates only Claude Code and Codex.",
        ));
    }
    let found = detector.get(params.cli).await;
    let Some(path) = found.path else {
        return Err(ErrorObject::invalid_params(
            "That CLI isn't installed on this host.",
        ));
    };
    let (program, args) = std::fs::canonicalize(&path)
        .ok()
        .and_then(|real| brew_upgrade(&real))
        .unwrap_or_else(|| (path, vec!["update".to_owned()]));
    let command = format!("{program} {}", args.join(" "));
    let mut spec = probe_spec(&program);
    spec.args = args.into_iter().map(Into::into).collect();
    let ran = detect::run_spec(detector.launcher(), &spec, b"", UPGRADE_TIMEOUT)
        .await
        .map_err(|error| ErrorObject::internal_error(format!("{command} {error}")))?;
    if ran.exit_code != Some(0) {
        return Err(ErrorObject::internal_error(format!(
            "{command} failed: {}",
            output(&ran)
        )));
    }
    let version = detector.refresh_one(params.cli).await.version;
    if let Some(before) = found.version
        && version.as_ref() == Some(&before)
    {
        return Err(ErrorObject::internal_error(format!(
            "{command} left it at {before}: {}",
            output(&ran)
        )));
    }
    Ok(ProvidersUpgradeResult { version })
}

/// The `brew upgrade` command for the Homebrew package that `real`, a CLI's resolved path, belongs
/// to: `<prefix>/Caskroom/<cask>/...` or `<prefix>/Cellar/<formula>/...`.
fn brew_upgrade(real: &Path) -> Option<(String, Vec<String>)> {
    let parts: Vec<_> = real.iter().collect();
    let at = parts
        .iter()
        .position(|part| *part == "Caskroom" || *part == "Cellar")?;
    let kind = if parts[at] == "Caskroom" {
        "--cask"
    } else {
        "--formula"
    };
    let package = parts.get(at + 1)?.to_str()?;
    let brew = parts[..at]
        .iter()
        .collect::<std::path::PathBuf>()
        .join("bin/brew");
    let args = ["upgrade", kind, package].map(str::to_owned).to_vec();
    Some((brew.to_str()?.to_owned(), args))
}

/// What a command said: its stderr, or its stdout when stderr is empty.
fn output(ran: &detect::Ran) -> &str {
    let why = ran.stderr_tail.trim();
    if why.is_empty() {
        ran.stdout.trim()
    } else {
        why
    }
}

/// The latest release of npm `package`, read with `curl` so plxd needs no HTTP client.
async fn latest(context: &Context, package: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let args = [
        "-fsS",
        "--proto",
        "=https",
        "--max-time",
        "15",
        url.as_str(),
    ];
    let launcher = context.daemon.cli_detector.launcher();
    let ran = detect::run(launcher, "curl", &args, REGISTRY_TIMEOUT)
        .await
        .ok()?;
    (ran.exit_code == Some(0))
        .then(|| version_in(&ran.stdout))
        .flatten()
}

/// The `version` of an npm registry document.
fn version_in(body: &str) -> Option<String> {
    let body: Value = serde_json::from_str(body).ok()?;
    Some(body.get("version")?.as_str()?.to_owned())
}

/// Whether `latest` is a newer release than `version`.
fn newer(version: &str, latest: &str) -> bool {
    match (parse_version(version), parse_version(latest)) {
        (Some(version), Some(latest)) => compare(&latest, &version).is_gt(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{brew_upgrade, newer, version_in};

    #[test]
    fn a_newer_release_is_an_update() {
        assert!(newer("2.1.295", "2.1.300"));
        assert!(newer("0.162.0", "0.163.0"));
        assert!(!newer("2.1.300", "2.1.300"));
        assert!(!newer("2.1.301", "2.1.300"));
        assert!(!newer("unknown", "2.1.300"));
    }

    #[test]
    fn the_registry_names_the_version() {
        let body = r#"{"name":"@openai/codex","version":"0.163.0","bin":{}}"#;
        assert_eq!(version_in(body).as_deref(), Some("0.163.0"));
        assert_eq!(version_in("Not Found"), None);
    }

    #[test]
    fn a_homebrew_install_upgrades_through_its_brew() {
        let cask = Path::new("/opt/homebrew/Caskroom/claude-code@latest/2.1.295/claude");
        let (brew, args) = brew_upgrade(cask).unwrap();
        assert_eq!(Path::new(&brew), Path::new("/opt/homebrew/bin/brew"));
        assert_eq!(args, ["upgrade", "--cask", "claude-code@latest"]);

        let formula = Path::new("/home/linuxbrew/.linuxbrew/Cellar/codex/0.162.1/bin/codex");
        let (brew, args) = brew_upgrade(formula).unwrap();
        assert_eq!(
            Path::new(&brew),
            Path::new("/home/linuxbrew/.linuxbrew/bin/brew")
        );
        assert_eq!(args, ["upgrade", "--formula", "codex"]);

        assert!(brew_upgrade(Path::new("/Users/r/.local/share/claude/versions/2.1.295")).is_none());
    }
}
