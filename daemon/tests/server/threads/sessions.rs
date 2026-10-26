//! Live sessions (0060): a thread's CLI stays up after its turn until something releases it. Each
//! script prints its pid, so a test sees whether that CLI is still running.

use std::time::Duration;

use parallax_protocol::methods::ThreadStart;
use parallax_protocol::{
    AgentOutputItem, AgentStatus, EventsEventParams, ParallaxEvent, RepoId, RunId,
};
use plxd::backend::fake::Step;
use rustix::process::{Pid, test_kill_process};
use tokio::time::Instant;

use super::{Conn, Host, fake, real_repo, scope, start_params};
use crate::agents::{end_turn, init};
use crate::support::PATIENCE;

/// A thread's CLI that prints its pid, ends its turn, and then waits for its next message, which
/// it gets only while its session lives.
fn waiting() -> Vec<Step> {
    vec![
        init("session-1"),
        Step::EchoPid,
        Step::WriteFile {
            path: "NOTES.md".to_owned(),
            content: "Written in a thread.\n".to_owned(),
        },
        end_turn("Done."),
        Step::AwaitFollowUp,
        end_turn("Again."),
    ]
}

fn alive(pid: i32) -> bool {
    test_kill_process(Pid::from_raw(pid).unwrap()).is_ok()
}

/// Waits for the CLI with `pid` to be gone.
async fn gone(pid: i32) {
    let deadline = Instant::now() + PATIENCE;
    while alive(pid) {
        assert!(Instant::now() < deadline, "the CLI {pid} still runs");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Starts a thread on `repo` and waits for its turn to settle: its CLI's pid.
async fn settled(client: &mut Conn, runs: &mut Conn, repo: RepoId, task: &str) -> (RunId, i32) {
    let run = client
        .call::<ThreadStart>(start_params(Some(repo), task))
        .await
        .unwrap()
        .run
        .id;
    let mut pid = None;
    runs.until(|event: &EventsEventParams| match &event.event {
        ParallaxEvent::AgentOutput { run_id, items, .. } if *run_id == run => {
            pid = pid.or(items.iter().find_map(|item| match item {
                AgentOutputItem::Text { text, .. } => text.parse().ok(),
                _ => None,
            }));
            false
        }
        ParallaxEvent::AgentUpdated { run_id, state } if *run_id == run => {
            state.status == AgentStatus::Completed
        }
        _ => false,
    })
    .await;
    let pid = pid.expect("the CLI printed its pid");
    assert!(alive(pid), "the session outlives its turn");
    (run, pid)
}

/// Past five idle sessions, the least recently used is released; the rest stay up.
#[tokio::test]
async fn past_five_idle_sessions_the_oldest_is_released() {
    let host = Host::start(fake(waiting()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(repo.id))).await;
    let mut pids = Vec::new();
    for n in 0..6 {
        pids.push(
            settled(&mut client, &mut runs, repo.id, &format!("Task {n}"))
                .await
                .1,
        );
    }
    gone(pids[0]).await;
    assert!(pids[1..].iter().all(|&pid| alive(pid)), "{pids:?}");
}
