//! `agent/wait` (PLX-451): waits for any or all runs to go idle, or for its timeout, on the fake
//! CLI. One connection waits while another cancels or deletes runs, and the wait ends when its
//! connection stops reading.

use std::time::{Duration, Instant};

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{AgentCancel, AgentStart, AgentWait, ThreadDelete, ThreadStart};
use parallax_protocol::{
    AgentCancelParams, AgentStatus, AgentWaitParams, AgentWaitResult, ErrorKind, RunId,
    ThreadDeleteParams,
};
use plxd::backend::fake::Step;

use crate::agents::{
    Conn, Host, create, fake, init, project_params, start_params, subscribe, text, until,
    updated_to,
};
use crate::support::{Client, kind, temp_dir};

/// How soon a wait that has to end early must answer: far under its own 60 s timeout.
const PROMPTLY: Duration = Duration::from_secs(3);

/// A host whose runs work until cancelled, `count` runs running on it, and a client.
async fn hanging_runs(count: usize) -> (Host, Conn, Vec<RunId>) {
    let host = Host::start(
        temp_dir(),
        fake(vec![init("wait-1"), text("Working"), Step::Hang]),
    );
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
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

async fn cancel(client: &mut Conn, run_id: RunId) {
    client
        .call::<AgentCancel>(AgentCancelParams { run_id, from: None })
        .await
        .unwrap();
}

async fn answer(waiter: &mut Client) -> AgentWaitResult {
    waiter.response().await.into_result().unwrap()
}

fn statuses(result: &AgentWaitResult) -> Vec<AgentStatus> {
    result.runs.iter().map(|run| run.status).collect()
}

/// `any` answers once one run is idle, with every run in the order asked for.
#[tokio::test]
async fn any_answers_when_one_run_is_idle() {
    let (host, mut client, runs) = hanging_runs(2).await;
    let mut waiter = Client::ready(&host.server.socket).await;
    waiter
        .send::<AgentWait>(wait_params(runs.clone(), "any", 30_000))
        .await;
    waiter.stays_quiet(Duration::from_millis(200)).await;

    cancel(&mut client, runs[1]).await;
    let result = answer(&mut waiter).await;
    assert!(!result.timed_out);
    assert_eq!(
        result.runs.iter().map(|run| run.id).collect::<Vec<_>>(),
        runs
    );
    assert_eq!(
        statuses(&result),
        [AgentStatus::Running, AgentStatus::Cancelled]
    );
}

/// `all` keeps waiting while any run still works.
#[tokio::test]
async fn all_answers_when_every_run_is_idle() {
    let (host, mut client, runs) = hanging_runs(2).await;
    let mut waiter = Client::ready(&host.server.socket).await;
    waiter
        .send::<AgentWait>(wait_params(runs.clone(), "all", 30_000))
        .await;

    cancel(&mut client, runs[0]).await;
    waiter.stays_quiet(Duration::from_millis(300)).await;
    cancel(&mut client, runs[1]).await;
    let result = answer(&mut waiter).await;
    assert!(!result.timed_out);
    assert_eq!(
        statuses(&result),
        [AgentStatus::Cancelled, AgentStatus::Cancelled]
    );
}

/// A run that stays busy times the wait out, which answers with the run as it stands.
#[tokio::test]
async fn a_busy_run_times_out() {
    let (host, _client, runs) = hanging_runs(1).await;
    let mut waiter = Client::ready(&host.server.socket).await;
    let started = Instant::now();
    let result = waiter
        .call::<AgentWait>(wait_params(runs, "all", 300))
        .await
        .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert!(result.timed_out);
    assert_eq!(statuses(&result), [AgentStatus::Running]);
}

/// An unknown run fails with `runNotFound`, and no runs or more than 50 is refused.
#[tokio::test]
async fn an_unknown_run_is_not_found() {
    let (host, _client, runs) = hanging_runs(1).await;
    let mut waiter = Client::ready(&host.server.socket).await;
    let unknown = waiter
        .call::<AgentWait>(wait_params(vec![runs[0], RunId::generate()], "any", 1_000))
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RunNotFound);

    for run_ids in [Vec::new(), vec![runs[0]; 51]] {
        let refused = waiter
            .call::<AgentWait>(wait_params(run_ids, "any", 1_000))
            .await
            .unwrap_err();
        assert_eq!(refused.code, INVALID_PARAMS, "{refused:?}");
    }
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

/// Stopping plxd doesn't wait out a pending wait, which is answered as timed out first.
#[tokio::test]
async fn stopping_plxd_ends_a_pending_wait() {
    let (host, _client, runs) = hanging_runs(1).await;
    let mut waiter = Client::ready(&host.server.socket).await;
    waiter
        .send::<AgentWait>(wait_params(runs, "all", 60_000))
        .await;
    waiter.stays_quiet(Duration::from_millis(200)).await;

    let stopping = Instant::now();
    host.server.stop().await;
    assert!(stopping.elapsed() < PROMPTLY, "{:?}", stopping.elapsed());
    assert!(answer(&mut waiter).await.timed_out);
}

/// Deleting a waited thread ends the wait instead of leaving it to its timeout.
#[tokio::test]
async fn deleting_a_thread_ends_a_wait_on_it() {
    let (host, mut client, _) = hanging_runs(0).await;
    let params = crate::threads::start_params(None, "Work until deleted");
    let run_id = params.run_id;
    client.call::<ThreadStart>(params).await.unwrap();
    let mut waiter = Client::ready(&host.server.socket).await;
    waiter
        .send::<AgentWait>(wait_params(vec![run_id], "any", 60_000))
        .await;
    waiter.stays_quiet(Duration::from_millis(200)).await;

    let deleting = Instant::now();
    client
        .call::<ThreadDelete>(ThreadDeleteParams { run_id })
        .await
        .unwrap();
    // The wait either sees the run cancelled on its way out or finds it gone.
    match waiter.response().await.into_result::<AgentWaitResult>() {
        Ok(result) => {
            assert!(!result.timed_out);
            assert_eq!(statuses(&result), [AgentStatus::Cancelled]);
        }
        Err(error) => assert_eq!(kind(&error), ErrorKind::RunNotFound, "{error:?}"),
    }
    assert!(deleting.elapsed() < PROMPTLY, "{:?}", deleting.elapsed());
}
