//! `agent/wait` (PLX-451) on the fake CLI: one connection waits while another cancels a run, and
//! the wait ends when its connection stops reading.

use std::time::{Duration, Instant};

use parallax_protocol::methods::{AgentStart, AgentWait};
use parallax_protocol::{AgentStatus, AgentWaitParams, AgentWaitResult, RunId};
use plxd::backend::fake::Step;

use crate::agents::{Conn, Host, fake, init, start_params, text, until, updated_to};
use crate::support::{Client, temp_dir};

/// How soon a wait that has to end early must answer: far under its own 60 s timeout.
const PROMPTLY: Duration = Duration::from_secs(3);

/// A host whose runs work until cancelled, `count` runs running on it, and a client.
async fn hanging_runs(count: usize) -> (Host, Conn, Vec<RunId>) {
    let host = Host::start(
        temp_dir(),
        fake(vec![init("wait-1"), text("Working"), Step::Hang]),
    );
    let (mut client, project) = host.orchestrator_client().await;
    let mut runs = Vec::new();
    for _ in 0..count {
        let params = start_params(project.id, "Work until cancelled");
        runs.push(params.run_id);
        client.call::<AgentStart>(params).await.unwrap();
        until(&mut client, updated_to(AgentStatus::Running)).await;
    }
    (host, client, runs)
}

fn wait_params(run_ids: Vec<RunId>, until: &str, timeout_ms: u32) -> AgentWaitParams {
    AgentWaitParams {
        run_ids,
        until: serde_json::from_value(until.into()).unwrap(),
        timeout_ms,
    }
}

async fn answer(waiter: &mut Client) -> AgentWaitResult {
    waiter.response().await.into_result().unwrap()
}

fn statuses(result: &AgentWaitResult) -> Vec<AgentStatus> {
    result.runs.iter().map(|run| run.status).collect()
}

/// A client that closes its side gets its pending wait answered at once, as timed out, instead
/// of the connection staying open until the wait's own timeout.
#[tokio::test]
async fn closing_the_client_ends_a_pending_wait() {
    let (host, _client, runs) = hanging_runs(1).await;
    let mut waiter = Client::ready(&host.server.socket).await;
    waiter
        .send::<AgentWait>(wait_params(runs, "all", 60_000))
        .await;
    waiter.stays_quiet(Duration::from_millis(200)).await;

    let closed = Instant::now();
    waiter.close_write().await;
    let result = answer(&mut waiter).await;
    assert!(closed.elapsed() < PROMPTLY, "{:?}", closed.elapsed());
    assert!(result.timed_out);
    assert_eq!(statuses(&result), [AgentStatus::Running]);
    assert!(waiter.closes_within(PROMPTLY).await);
}
