//! Scheduled tasks end to end (0063): a fire goes through the effect worker into its thread, or
//! launches one, and a restart neither loses a task nor fires it again.

use parallax_protocol::methods::{ScheduleList, ScheduleRun, ScheduleSave};
use parallax_protocol::{
    Schedule, ScheduleIdParams, ScheduleListParams, ScheduleRunStatus, ScheduleSaveParams,
    ScheduledTask,
};

use super::*;

fn hourly(title: &str, prompt: &str, thread: Option<RunId>) -> ScheduleSaveParams {
    ScheduleSaveParams {
        id: None,
        title: title.to_owned(),
        prompt: prompt.to_owned(),
        enabled: true,
        schedule: Schedule::Interval {
            every_ms: 3_600_000,
        },
        thread,
        project: None,
        repo: None,
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
        model: None,
        effort: None,
        permission: None,
        from: None,
    }
}

async fn tasks(client: &mut Conn) -> Vec<ScheduledTask> {
    client
        .call::<ScheduleList>(ScheduleListParams {})
        .await
        .unwrap()
        .tasks
}

/// Task `id` once its last fire has been sent.
async fn sent(client: &mut Conn, id: &str) -> ScheduledTask {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let task = tasks(client)
            .await
            .into_iter()
            .find(|task| task.id == id)
            .unwrap();
        if task.last_run_status != ScheduleRunStatus::Running {
            return task;
        }
        assert!(
            Instant::now() < deadline,
            "the fire was never sent: {task:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_scheduled_task_reaches_its_thread_or_a_new_one_and_outlives_a_restart() {
    let host = Host::start(fake(editing()));
    let mut client = host.client().await;
    let thread = client
        .call::<ThreadStart>(start_params(None, "Keep an eye on the build"))
        .await
        .unwrap()
        .run
        .id;

    let bound = client
        .call::<ScheduleSave>(hourly(
            "Build check",
            "Check the build again.",
            Some(thread),
        ))
        .await
        .unwrap();
    let fresh = client
        .call::<ScheduleSave>(hourly("Nightly digest", "Write the digest.", None))
        .await
        .unwrap();
    for task in [&bound, &fresh] {
        client
            .call::<ScheduleRun>(ScheduleIdParams {
                id: task.id.clone(),
            })
            .await
            .unwrap();
    }
    let bound = sent(&mut client, &bound.id).await;
    assert_eq!(
        bound.last_run_status,
        ScheduleRunStatus::Succeeded,
        "{bound:?}"
    );
    assert_eq!(bound.run_count, 1);
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            run_id: thread,
            after: 0,
            before: None,
            limit: None,
        })
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&events.events)
            .unwrap()
            .contains("Check the build again."),
        "the prompt reached the thread"
    );
    let fresh = sent(&mut client, &fresh.id).await;
    assert_eq!(
        fresh.last_run_status,
        ScheduleRunStatus::Succeeded,
        "{fresh:?}"
    );
    let listed = client.list().await;
    assert!(
        listed
            .threads
            .iter()
            .any(|thread| thread.title.as_deref() == Some("Nightly digest")),
        "a new thread named for the task: {listed:?}"
    );

    let before = tasks(&mut client).await;
    drop(client);
    let host = host.restart(fake(editing())).await;
    let mut client = host.client().await;
    let after = tasks(&mut client).await;
    assert_eq!(after, before, "kept, and not fired again");
    assert_eq!(client.list().await.threads.len(), 2);
}
