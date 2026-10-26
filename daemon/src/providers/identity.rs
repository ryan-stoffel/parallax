//! Read-only account metadata from each instance's CLI, with its own configuration home.

use std::ffi::OsString;

use parallax_protocol::{ProviderInstance, ProviderKind};
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
        }
        ProviderKind::Codex => match codex_account(launcher, spec).await {
            Some(account) => apply_codex(found, &account),
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
async fn codex_account(launcher: &Launcher, mut spec: ProcessSpec) -> Option<Value> {
    spec.args = vec!["app-server".into()];
    spec.stdin = StdinMode::Piped;
    let mut process = launcher.spawn(&spec).ok()?;
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
        while let Some(output) = process.next().await {
            let Output::Line(bytes) = output else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if value.get("id").and_then(Value::as_i64) == Some(1) {
                return value.pointer("/result/account").cloned();
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    drop(process);
    result
}

#[cfg(test)]
mod tests {
    use super::{Found, apply_claude, apply_codex};
    use serde_json::json;

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
            "read -r initialize\nread -r initialized\nread -r account\n",
            "printf '{\"id\":0,\"result\":{}}\\n'\n",
            "printf '{\"id\":1,\"result\":{\"account\":{\"email\":\"%s@example.com\",\"planType\":\"pro\"}}}\\n' \"$CODEX_HOME\"\n",
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
        }
    }
}
