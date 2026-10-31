//! An orchestrator's `land` tool (PLX-410, decision 0045): queues a finished child to land on the
//! orchestrator's integration branch, through `land/queue`. And `checks_propose` (PLX-411):
//! proposes the orchestrator's checks command, which the user confirms, through
//! `orchestrator/update`. Only an orchestrator gets them.

use parallax_protocol::methods::{AgentList, LandQueue, OrchestratorUpdate};
use parallax_protocol::{
    AgentListParams, LandQueueParams, LandingStatus, OrchestratorUpdateParams, RunId, ScopeId,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{object, parse, pretty, tool};

/// The tools an orchestrator gets from this module.
pub const TOOLS: &[&str] = &["land", "checks_propose"];

/// [`TOOLS`] for an orchestrator, and none for anyone else.
#[must_use]
pub fn tools(orchestrator: bool) -> &'static [&'static str] {
    if orchestrator { TOOLS } else { &[] }
}

/// The definitions of [`tools`], in its order.
#[must_use]
pub fn definitions(orchestrator: bool) -> Vec<Value> {
    if !orchestrator {
        return Vec::new();
    }
    vec![
        tool(
            "land",
            "Queue a finished child whose review passed to land on the orchestrator's integration branch, as one squashed commit titled with its task's first line. It waits for the user's approval unless the orchestrator lands automatically. If it conflicts, Parallax sends it back to merge the branch and queues it again, and you hear how it went. Never land an exploration child.",
            object(
                json!({
                    "runId": {"type": "string", "description": "The child's run id, from thread_list or thread_launch."},
                }),
                &["runId"],
            ),
            false,
        ),
        tool(
            "checks_propose",
            "Propose the orchestrator's checks: one shell command, run from the repository's root after each landing, that exits 0 when the integration branch is healthy, such as `cargo test --workspace && npm test`. Find it once, from AGENTS.md, CI config, and package scripts. The user confirms or edits it before it ever runs. Red checks take the child's work off the branch and send it the output.",
            object(
                json!({
                    "command": {"type": "string", "description": "The command, for `sh -c` (`cmd /C` on Windows). At most 4,096 bytes."},
                }),
                &["command"],
            ),
            false,
        ),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LandArgs {
    run_id: RunId,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeArgs {
    command: String,
}

/// `checks_propose`: proposes `project`'s checks command, the caller's Orchestrator when it is its
/// orchestrator. It never runs until the user confirms it.
pub(super) async fn propose(
    binding: &Binding,
    project: Option<ScopeId>,
    arguments: Value,
) -> Result<String, String> {
    let project = project.ok_or("only an orchestrator proposes its checks")?;
    let ProposeArgs { command } = parse(arguments)?;
    if command.trim().is_empty() {
        return Err("command must not be empty".to_owned());
    }
    let plxd = &binding.plxd;
    let project = plxd
        .call::<OrchestratorUpdate>(OrchestratorUpdateParams {
            orchestrator: project,
            name: None,
            icon: None,
            permission: None,
            autonomy: None,
            base_branch: None,
            auto_land: None,
            checks: None,
            proposed_checks: Some(command),
            computer: None,
            max_children: None,
            allow_api_keys: None,
        })
        .await?
        .orchestrator;
    Ok(pretty(&json!({
        "proposed": project.proposed_checks,
        "current": project.checks,
        "note": "The user confirms or edits it before it runs.",
    })))
}

/// `land`: queues the child `runId` of `project`, the caller's Orchestrator when it is its
/// orchestrator.
pub(super) async fn call(
    binding: &Binding,
    project: Option<ScopeId>,
    arguments: Value,
) -> Result<String, String> {
    let project = project.ok_or("only an orchestrator lands its children")?;
    let LandArgs { run_id } = parse(arguments)?;
    let plxd = &binding.plxd;
    let runs = plxd
        .call::<AgentList>(AgentListParams {
            project: Some(project),
        })
        .await?
        .runs;
    if !runs.iter().any(|run| run.id == run_id) {
        return Err(format!(
            "run {run_id} isn't one of your orchestrator's runs"
        ));
    }
    let landing = plxd
        .call::<LandQueue>(LandQueueParams { run_id })
        .await?
        .landing;
    let note = match landing.status {
        LandingStatus::Waiting => "It lands once the user approves it.",
        LandingStatus::Queued => "It lands in its turn.",
        LandingStatus::SentBack => {
            "It was sent back, and Parallax queues it again when its turn ends."
        }
        _ => "",
    };
    Ok(pretty(
        &json!({"runId": run_id, "status": landing.status, "note": note}),
    ))
}
