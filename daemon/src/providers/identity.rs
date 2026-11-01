//! Read-only account metadata from each instance's CLI, with its own configuration home.

use std::ffi::OsString;

use parallax_protocol::{ProviderInstance, ProviderKind, ProviderModel};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::Found;
use crate::backend::process::{Launcher, Output, ProcessSpec, StdinMode};
use crate::detect;

/// Probe only public CLI metadata. Credentials remain in the vendor's own files.
pub(super) async fn probe(
    launcher: &Launcher,
    instance: &ProviderInstance,
    program: &str,
    env: Vec<(OsString, OsString)>,
    found: &mut Found,
) {
    // A built-in detector may have read the default home, rather than this instance's home.
    found.signed_in = None;
    found.account = None;
    found.plan = None;
    let mut spec = detect::probe_spec(program);
    spec.inject = env.into_iter().collect();
    match instance.kind {
        ProviderKind::Claude => {
            spec.args = vec!["auth".into(), "status".into()];
            match detect::run_spec(launcher, &spec, b"", detect::PROBE_TIMEOUT).await {
                Ok(ran) => apply_claude(found, &ran.stdout, ran.exit_code),
                Err(note) => found.note = Some(note),
            }
            if let Some(models) = claude_models(launcher, spec).await {
                found.models = models;
            }
        }
        ProviderKind::Codex => match codex_account(launcher, spec).await {
            Some((account, models)) => {
                apply_codex(found, &account);
                found.models = models;
            }
            None => {
                found.note = Some("couldn't read this Codex account's sign-in status".into());
            }
        },
        _ => {}
    }
}

fn text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

fn apply_claude(found: &mut Found, stdout: &str, exit_code: Option<i32>) {
    let value = serde_json::from_str::<Value>(stdout).unwrap_or(Value::Null);
    found.signed_in = ["loggedIn", "signedIn", "authenticated", "isAuthenticated"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
        .or(match exit_code {
            Some(0) => Some(true),
            Some(1) => Some(false),
            _ => None,
        });
    let signed_in = found.signed_in == Some(true);
    found.account = signed_in
        .then(|| text(&value, &["email", "subscriptionType", "plan", "tier"]))
        .flatten();
    found.plan = signed_in
        .then(|| text(&value, &["subscriptionType", "plan", "tier"]))
        .flatten();
}

fn apply_codex(found: &mut Found, account: &Value) {
    found.signed_in = match account {
        Value::Object(_) => Some(true),
        Value::Null => Some(false),
        _ => None,
    };
    found.account = text(account, &["email", "planType"]);
    found.plan = text(account, &["planType"]);
}

/// The app-server stays alive after replying, so stop it as soon as account/read answers.
async fn codex_account(
    launcher: &Launcher,
    mut spec: ProcessSpec,
) -> Option<(Value, Vec<ProviderModel>)> {
    spec.args = vec!["app-server".into()];
    spec.stdin = StdinMode::Piped;
    let mut process = launcher.spawn(&spec).ok()?;
    let mut account = None;
    let mut models = Vec::new();
    let result = tokio::time::timeout(detect::PROBE_TIMEOUT, async {
        let mut stdin = process.take_stdin()?;
        stdin
            .write_all(concat!(
                r#"{"id":0,"method":"initialize","params":{"clientInfo":{"name":"plxd","version":"0"}}}"#,
                "\n",
                r#"{"method":"initialized"}"#,
                "\n",
                r#"{"id":1,"method":"account/read","params":{}}"#,
                "\n",
            ).as_bytes())
            .await
            .ok()?;
        let mut models_done = false;
        stdin.write_all(b"{\"id\":2,\"method\":\"model/list\",\"params\":{\"limit\":100}}\n").await.ok()?;
        while let Some(output) = process.next().await {
            let Output::Line(bytes) = output else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if value.get("id").and_then(Value::as_i64) == Some(1) {
                account = value.pointer("/result/account").cloned();
                if account.is_some() && models_done {
                    return Some((account.take()?, std::mem::take(&mut models)));
                }
            }
            if value.get("id").and_then(Value::as_i64) == Some(2) {
                models.extend(codex_models(&value["result"]["data"]));
                if let Some(next) = value.pointer("/result/nextCursor").and_then(Value::as_str) {
                    let request = serde_json::json!({"id":2,"method":"model/list","params":{"limit":100,"cursor":next}});
                    stdin.write_all(format!("{request}\n").as_bytes()).await.ok()?;
                } else {
                    models_done = true;
                    if let Some(account) = account.take() { return Some((account, std::mem::take(&mut models))); }
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    drop(process);
    result.or_else(|| account.map(|account| (account, models)))
}

/// Claude's initialization lists supported models without sending a prompt or running tools.
async fn claude_models(launcher: &Launcher, mut spec: ProcessSpec) -> Option<Vec<ProviderModel>> {
    spec.args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    spec.stdin = StdinMode::Piped;
    let mut process = launcher.spawn(&spec).ok()?;
    let result = tokio::time::timeout(detect::PROBE_TIMEOUT, async {
        let mut stdin = process.take_stdin()?;
        stdin.write_all(b"{\"type\":\"control_request\",\"request_id\":\"models\",\"request\":{\"subtype\":\"initialize\"}}\n").await.ok()?;
        while let Some(output) = process.next().await {
            let Output::Line(bytes) = output else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if value.pointer("/response/request_id").and_then(Value::as_str) == Some("models") {
                return Some(claude_model_list(&value["response"]["response"]["models"]));
            }
        }
        None
    }).await.ok().flatten();
    drop(process);
    result
}

fn claude_model_list(value: &Value) -> Vec<ProviderModel> {
    let mut seen = std::collections::HashSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["value"] != "default")
        .filter_map(|m| {
            let id = text(m, &["resolvedModel", "value"])?;
            if !seen.insert(id.clone()) {
                return None;
            }
            Some(ProviderModel {
                name: text(m, &["displayName"]).unwrap_or_else(|| id.clone()),
                id,
            })
        })
        .collect()
}

fn codex_models(value: &Value) -> Vec<ProviderModel> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["hidden"] != true)
        .filter_map(|m| {
            let id = text(m, &["model", "id"])?;
            Some(ProviderModel {
                name: text(m, &["displayName"]).unwrap_or_else(|| id.clone()),
                id,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{Found, apply_claude, apply_codex};
    use serde_json::json;

    #[test]
    fn current_model_lists_keep_upstream_names_and_resolved_ids() {
        let claude = super::claude_model_list(&json!([
            {"value":"default","resolvedModel":"claude-current","displayName":"Default"},
            {"value":"opus","resolvedModel":"claude-current","displayName":"Opus current"},
            {"value":"claude-current","displayName":"Duplicate"},
            {"value":"new-alias","resolvedModel":"claude-new","displayName":"New upstream"}
        ]));
        assert_eq!(
            claude
                .iter()
                .map(|m| (m.id.as_str(), m.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("claude-current", "Opus current"),
                ("claude-new", "New upstream")
            ]
        );
        let codex = super::codex_models(&json!([
            {"model":"new-id","displayName":"New Codex name","hidden":false},
            {"model":"hidden-id","displayName":"Hidden","hidden":true}
        ]));
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].id, "new-id");
        assert_eq!(codex[0].name, "New Codex name");
    }

    #[test]
    fn identities_prefer_email_and_clear_when_signed_out() {
        let mut found = Found::default();
        apply_claude(
            &mut found,
            r#"{"loggedIn":true,"email":"personal@example.com","subscriptionType":"max"}"#,
            Some(0),
        );
        assert_eq!(found.account.as_deref(), Some("personal@example.com"));
        assert_eq!(found.plan.as_deref(), Some("max"));
        apply_claude(&mut found, r#"{"loggedIn":false}"#, Some(0));
        assert_eq!(found.signed_in, Some(false));
        assert_eq!(found.account, None);
        assert_eq!(found.plan, None);

        apply_codex(
            &mut found,
            &json!({"email":"work@example.com","planType":"pro"}),
        );
        assert_eq!(found.account.as_deref(), Some("work@example.com"));
        assert_eq!(found.plan.as_deref(), Some("pro"));
        apply_codex(&mut found, &json!({"planType":"pro"}));
        assert_eq!(found.account.as_deref(), Some("pro"));
        apply_codex(&mut found, &serde_json::Value::Null);
        assert_eq!(found.signed_in, Some(false));
        assert_eq!(found.account, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probes_use_each_accounts_home_instead_of_the_launchers_home() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        use crate::backend::process::{Environment, Launcher};
        use crate::paths::DataDir;
        use parallax_protocol::ProviderInstance;

        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("codex");
        fs::write(&program, concat!(
            "#!/bin/sh\n",
            "read -r initialize\nread -r initialized\nread -r account\nread -r models\n",
            "printf '{\"id\":0,\"result\":{}}\\n'\n",
            "printf '{\"id\":1,\"result\":{\"account\":{\"email\":\"%s@example.com\",\"planType\":\"pro\"}}}\\n' \"$CODEX_HOME\"\n",
            "printf '{\"id\":2,\"result\":{\"data\":[{\"id\":\"discovered\",\"displayName\":\"Discovered\"}],\"nextCursor\":\"page-2\"}}\\n'\n",
            "read -r page\n",
            "printf '{\"id\":2,\"result\":{\"data\":[{\"model\":\"second-page\",\"displayName\":\"Second Page\"}],\"nextCursor\":null}}\\n'\n",
            "read -r wait\n",
        )).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let mut base = Environment::empty();
        base.set("CODEX_HOME", "wrong");
        let launcher = Launcher::new(DataDir::new(dir.path().join("data")).unwrap(), base);
        let instance: ProviderInstance = serde_json::from_value(json!({
            "id":"account", "kind":"codex", "name":"Account", "enabled":true,
        }))
        .unwrap();
        for home in ["personal", "work"] {
            let mut found = Found::default();
            super::probe(
                &launcher,
                &instance,
                program.to_str().unwrap(),
                vec![("CODEX_HOME".into(), home.into())],
                &mut found,
            )
            .await;
            assert_eq!(found.signed_in, Some(true));
            assert_eq!(found.account, Some(format!("{home}@example.com")));
            assert_eq!(
                found
                    .models
                    .iter()
                    .map(|m| m.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["discovered", "second-page"]
            );
        }
    }
}
