//! `providerUpdates` (PLX-746): `providers/updates` compares each installed Claude Code and Codex
//! with the latest release of where it came from, and `providers/upgrade` runs the CLI's own
//! `update`, which knows whether npm or its native installer put it there, or `brew upgrade` for a
//! Homebrew install, since `claude update` only prints that command (PLX-762). A Homebrew install
//! is compared with its cask or formula, not npm, whose releases Homebrew's lag (PLX-783).

use std::path::{Path, PathBuf};
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

/// Held while a CLI upgrades: two `brew upgrade`s at once fail on Homebrew's lock, and two of one
/// CLI's own `update` race on its install.
static UPGRADING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `providers/updates`: each installed CLI in [`PACKAGES`] whose latest release is newer. A CLI
/// whose version or latest release plxd can't read is left out.
pub(crate) async fn updates(
    context: &Context,
    _: ProvidersUpdatesParams,
) -> Result<ProvidersUpdatesResult, ErrorObject> {
    let checks = PACKAGES.map(|(cli, package)| async move {
        let found = context.daemon.cli_detector.get(cli).await;
        let version = found.version.filter(|_| found.installed)?;
        let (url, pointer) = match found.path.as_deref().and_then(installed_by_brew) {
            Some(brew) => (brew.api_url(), brew.version_at()),
            None => (
                format!("https://registry.npmjs.org/{package}/latest"),
                "/version",
            ),
        };
        let latest = latest(context, &url, pointer).await?;
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
/// output saying why. Upgrades run one at a time; one whose CLI another moved while it waited
/// answers with that version.
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
    let asked = detector.get(params.cli).await.version;
    let _upgrading = UPGRADING.lock().await;
    let found = detector.refresh_one(params.cli).await;
    if found.version.is_some() && found.version != asked {
        return Ok(ProvidersUpgradeResult {
            version: found.version,
        });
    }
    let Some(path) = found.path else {
        return Err(ErrorObject::invalid_params(
            "That CLI isn't installed on this host.",
        ));
    };
    let brew = installed_by_brew(&path);
    let (program, args) = match &brew {
        Some(brew) => brew.upgrade(),
        None => (path, vec!["update".to_owned()]),
    };
    let command = format!("{program} {}", args.join(" "));
    let mut spec = probe_spec(&program);
    spec.args = args.into_iter().map(Into::into).collect();
    if brew.is_some() {
        // brew rereads its API every 450 s by default, so it may not know the release
        // `providers/updates` read from the live API yet. A full `brew update` isn't needed.
        spec.scrub.push("HOMEBREW_NO_AUTO_UPDATE".into());
        spec.inject.set("HOMEBREW_API_AUTO_UPDATE_SECS", "0");
    }
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

/// The Homebrew cask or formula a CLI was installed as.
#[derive(Debug, PartialEq, Eq)]
struct Homebrew {
    /// The `brew` of the prefix it's in.
    brew: PathBuf,
    cask: bool,
    package: String,
}

impl Homebrew {
    /// Its page in Homebrew's JSON API, which `brew upgrade` reads too.
    fn api_url(&self) -> String {
        let kind = if self.cask { "cask" } else { "formula" };
        format!("https://formulae.brew.sh/api/{kind}/{}.json", self.package)
    }

    /// Where the API page has the version `brew upgrade` installs.
    fn version_at(&self) -> &'static str {
        if self.cask {
            "/version"
        } else {
            "/versions/stable"
        }
    }

    /// The `brew upgrade` command for it.
    fn upgrade(&self) -> (String, Vec<String>) {
        // Homebrew skips `version :latest` and auto-updating casks (`claude-code@latest`) without
        // `--greedy`, reporting a warning and exit 0.
        let kind: &[&str] = if self.cask {
            &["--cask", "--greedy"]
        } else {
            &["--formula"]
        };
        let args = ["upgrade"]
            .into_iter()
            .chain(kind.iter().copied())
            .chain([self.package.as_str()])
            .map(str::to_owned)
            .collect();
        (self.brew.display().to_string(), args)
    }
}

/// The Homebrew package the CLI at `path` belongs to, when its resolved path is in one.
fn installed_by_brew(path: &str) -> Option<Homebrew> {
    homebrew(&std::fs::canonicalize(path).ok()?)
}

/// The Homebrew package that `real`, a CLI's resolved path, belongs to:
/// `<prefix>/Caskroom/<cask>/...` or `<prefix>/Cellar/<formula>/...`.
fn homebrew(real: &Path) -> Option<Homebrew> {
    let parts: Vec<_> = real.iter().collect();
    let at = parts
        .iter()
        .position(|part| *part == "Caskroom" || *part == "Cellar")?;
    Some(Homebrew {
        brew: parts[..at].iter().collect::<PathBuf>().join("bin/brew"),
        cask: parts[at] == "Caskroom",
        package: parts.get(at + 1)?.to_str()?.to_owned(),
    })
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

/// The version at JSON `pointer` in the document at `url`, an npm or Homebrew package's latest
/// release, read with `curl` so plxd needs no HTTP client.
async fn latest(context: &Context, url: &str, pointer: &str) -> Option<String> {
    let args = ["-fsS", "--proto", "=https", "--max-time", "15", url];
    let launcher = context.daemon.cli_detector.launcher();
    let ran = detect::run(launcher, "curl", &args, REGISTRY_TIMEOUT)
        .await
        .ok()?;
    (ran.exit_code == Some(0))
        .then(|| version_in(&ran.stdout, pointer))
        .flatten()
}

/// The version at `pointer` in a JSON document. A cask's may carry a build after a comma.
fn version_in(body: &str, pointer: &str) -> Option<String> {
    let body: Value = serde_json::from_str(body).ok()?;
    let version = body.pointer(pointer)?.as_str()?;
    Some(version.split(',').next()?.to_owned())
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

    use super::{Homebrew, homebrew};

    #[test]
    fn a_homebrew_install_upgrades_and_checks_through_its_brew() {
        let cask = homebrew(Path::new(
            "/opt/homebrew/Caskroom/claude-code@latest/2.1.295/claude",
        ))
        .unwrap();
        assert_eq!(
            cask,
            Homebrew {
                brew: "/opt/homebrew/bin/brew".into(),
                cask: true,
                package: "claude-code@latest".to_owned(),
            }
        );
        let (brew, args) = cask.upgrade();
        assert_eq!(Path::new(&brew), Path::new("/opt/homebrew/bin/brew"));
        assert_eq!(
            args,
            ["upgrade", "--cask", "--greedy", "claude-code@latest"]
        );
        assert_eq!(
            cask.api_url(),
            "https://formulae.brew.sh/api/cask/claude-code@latest.json"
        );
        assert_eq!(cask.version_at(), "/version");

        let formula = homebrew(Path::new(
            "/home/linuxbrew/.linuxbrew/Cellar/codex/0.162.1/bin/codex",
        ))
        .unwrap();
        let (brew, args) = formula.upgrade();
        assert_eq!(
            Path::new(&brew),
            Path::new("/home/linuxbrew/.linuxbrew/bin/brew")
        );
        assert_eq!(args, ["upgrade", "--formula", "codex"]);
        assert_eq!(
            formula.api_url(),
            "https://formulae.brew.sh/api/formula/codex.json"
        );
        assert_eq!(formula.version_at(), "/versions/stable");

        assert!(homebrew(Path::new("/Users/r/.local/share/claude/versions/2.1.295")).is_none());
    }
}
