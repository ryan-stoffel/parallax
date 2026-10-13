//! `providerUpdates` (PLX-746): `providers/updates` compares each installed Claude Code and Codex
//! with its npm package's latest release, and `providers/upgrade` runs the CLI's own `update`,
//! which knows whether npm, Homebrew, or its native installer put it there.

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

/// `providers/upgrade`: runs `<cli> update`, then probes the CLI again for its version.
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
    let Some(path) = detector.get(params.cli).await.path else {
        return Err(ErrorObject::invalid_params(
            "That CLI isn't installed on this host.",
        ));
    };
    let mut spec = probe_spec(&path);
    spec.args = vec!["update".into()];
    let ran = detect::run_spec(detector.launcher(), &spec, b"", UPGRADE_TIMEOUT)
        .await
        .map_err(|error| ErrorObject::internal_error(format!("{path} update {error}")))?;
    if ran.exit_code != Some(0) {
        let why = ran.stderr_tail.trim();
        let why = if why.is_empty() {
            ran.stdout.trim()
        } else {
            why
        };
        return Err(ErrorObject::internal_error(format!(
            "{path} update failed: {why}"
        )));
    }
    Ok(ProvidersUpgradeResult {
        version: detector.refresh_one(params.cli).await.version,
    })
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
    use super::{newer, version_in};

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
}
