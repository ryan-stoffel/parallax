//! Claude Code's and Codex's usage for `usage/daily`, from ccusage (0039), which reads their
//! session logs (`~/.claude/projects`, `~/.codex/sessions`) and prices them.

use std::time::Duration;

use jiff::civil::Date;
use parallax_protocol::{CliKind, UsageDay};
use serde::Deserialize;

use crate::backend::claude::usd_micros;
use crate::backend::process::Launcher;
use crate::detect::{resolve, run};

/// How long ccusage may run. The first `npx` run downloads it, which takes a while.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Every Claude Code and Codex session's usage since `since`, by local day in `time_zone`, from
/// `ccusage` on the launcher's `PATH`, else `npx -y ccusage@20`. `Err` is why, for people.
pub(super) async fn daily(
    launcher: &Launcher,
    since: Date,
    time_zone: &str,
) -> Result<Vec<UsageDay>, String> {
    let since = since.strftime("%Y%m%d").to_string();
    let args = [
        "daily",
        "--json",
        "--by-agent",
        "--since",
        &since,
        "-z",
        time_zone,
    ];
    let ran = if resolve(launcher, "ccusage").is_some() {
        run(launcher, "ccusage", &args, TIMEOUT).await
    } else if resolve(launcher, "npx").is_some() {
        let args: Vec<&str> = ["-y", "ccusage@20"].into_iter().chain(args).collect();
        run(launcher, "npx", &args, TIMEOUT).await
    } else {
        return Err(
            "Install Node.js or ccusage on this host to see Claude Code and Codex usage."
                .to_owned(),
        );
    };
    let ran = ran.map_err(|error| format!("ccusage {error}."))?;
    if ran.exit_code != Some(0) {
        let why = ran.stderr_tail.trim().lines().last().unwrap_or("no output");
        return Err(format!("ccusage failed: {why}"));
    }
    parse(&ran.stdout).ok_or_else(|| "ccusage answered with output plxd can't read.".to_owned())
}

#[derive(Deserialize)]
struct Report {
    daily: Vec<ReportDay>,
}

#[derive(Deserialize)]
struct ReportDay {
    period: Date,
    #[serde(default)]
    agents: Vec<Agent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    agent: String,
    #[serde(default)]
    model_breakdowns: Vec<Breakdown>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Breakdown {
    model_name: String,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    cost: Option<f64>,
}

/// `ccusage daily --json --by-agent`'s report as rows, Claude Code's and Codex's only: Cursor
/// comes from its own API, and plxd runs no other agent. `None` if it isn't that report.
fn parse(stdout: &str) -> Option<Vec<UsageDay>> {
    // Past anything a wrapper such as npx printed first.
    let report: Report = serde_json::from_str(&stdout[stdout.find('{')?..]).ok()?;
    let mut days = Vec::new();
    for day in report.daily {
        for agent in day.agents {
            let agent_kind = match agent.agent.as_str() {
                "claude" => CliKind::Claude,
                "codex" => CliKind::Codex,
                _ => continue,
            };
            days.extend(agent.model_breakdowns.into_iter().map(|model| UsageDay {
                date: day.period,
                agent: agent_kind,
                model: model.model_name,
                input_tokens: model.input_tokens,
                output_tokens: model.output_tokens,
                cache_read_tokens: model.cache_read_tokens,
                cache_write_tokens: model.cache_creation_tokens,
                cost_usd_micros: model.cost.and_then(usd_micros),
            }));
        }
    }
    Some(days)
}

#[cfg(test)]
mod tests {
    use jiff::civil::date;
    use parallax_protocol::{CliKind, UsageDay};

    use super::parse;

    #[test]
    fn a_report_becomes_a_row_per_day_agent_and_model_and_skips_other_agents() {
        let stdout = r#"npm warn exec The following package was not found
{
  "daily": [
    {
      "period": "2026-09-30",
      "agent": "all",
      "agents": [
        {
          "agent": "claude",
          "modelBreakdowns": [
            { "modelName": "claude-opus-5-5", "inputTokens": 7, "outputTokens": 2, "cacheReadTokens": 600, "cacheCreationTokens": 15, "cost": 2.5 }
          ]
        },
        {
          "agent": "codex",
          "modelBreakdowns": [
            { "modelName": "gpt-6-sol", "inputTokens": 621, "outputTokens": 58, "cacheReadTokens": 8190, "cacheCreationTokens": 0 }
          ]
        },
        { "agent": "opencode", "modelBreakdowns": [{ "modelName": "x", "cost": 1 }] }
      ]
    }
  ],
  "totals": { "totalCost": 3.5 }
}"#;
        assert_eq!(
            parse(stdout).unwrap(),
            [
                UsageDay {
                    date: date(2026, 9, 30),
                    agent: CliKind::Claude,
                    model: "claude-opus-5-5".to_owned(),
                    input_tokens: 7,
                    output_tokens: 2,
                    cache_read_tokens: 600,
                    cache_write_tokens: 15,
                    cost_usd_micros: Some(2_500_000),
                },
                UsageDay {
                    date: date(2026, 9, 30),
                    agent: CliKind::Codex,
                    model: "gpt-6-sol".to_owned(),
                    input_tokens: 621,
                    output_tokens: 58,
                    cache_read_tokens: 8190,
                    cache_write_tokens: 0,
                    cost_usd_micros: None,
                },
            ]
        );
        assert!(parse("Error: no data").is_none());
    }
}
