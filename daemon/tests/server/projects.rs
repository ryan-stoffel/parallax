//! `project/list`, `project/create`, and `project/update` against a real store.

use parallax_protocol::ProjectListParams;
use parallax_protocol::methods::{ProjectCreate, ProjectList};
use rustix::process::Signal;

use crate::support::{Client, Plxd, create_params, temp_dir};

#[tokio::test]
async fn projects_are_created_listed_and_retried_idempotently() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;

    let empty = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    assert!(empty.projects.is_empty());
    assert_eq!(empty.seq, 0);

    let params = create_params(dir.path(), "parallax");
    let created = client
        .call::<ProjectCreate>(params.clone())
        .await
        .unwrap()
        .project;
    assert_eq!(created.id, params.id);
    assert_eq!(created.name, params.name);
    assert_eq!(created.repo_path, params.repo_path);
    assert_eq!(created.created_at, created.updated_at);

    let retried = client
        .call::<ProjectCreate>(params.clone())
        .await
        .unwrap()
        .project;
    assert_eq!(
        retried, created,
        "a retry returns the stored project unchanged"
    );

    let second = client
        .call::<ProjectCreate>(create_params(dir.path(), "roster"))
        .await
        .unwrap()
        .project;
    let listed = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    assert_eq!(listed.projects, [created, second], "oldest first");
    assert_eq!(
        listed.seq, 2,
        "one event per new project, none for the retry"
    );
}

#[tokio::test]
async fn projects_and_the_event_log_outlive_a_restart() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::connect(&plxd.socket).await;
    let first_log = client.initialize().await.unwrap().log_id;
    let created = client
        .call::<ProjectCreate>(create_params(dir.path(), "parallax"))
        .await
        .unwrap()
        .project;
    drop(client);
    plxd.signal(Signal::TERM);
    assert!(plxd.exit().await.0.success());

    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::connect(&plxd.socket).await;
    let second_log = client.initialize().await.unwrap().log_id;
    assert_eq!(
        first_log, second_log,
        "the log is stored from M3 on, so it continues (decision 0014)"
    );
    let listed = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    assert_eq!(listed.projects, [created]);
    assert_eq!(listed.seq, 1, "project.created is still in the log");
}
