//! `orchestrator/list`, `orchestrator/create`, and `orchestrator/update` against a real store.

use parallax_protocol::OrchestratorListParams;
use parallax_protocol::methods::{OrchestratorCreate, OrchestratorList};
use rustix::process::Signal;

use crate::support::{Client, Plxd, create_params, temp_dir};

#[tokio::test]
async fn orchestrators_are_created_listed_and_retried_idempotently() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;

    let empty = client
        .call::<OrchestratorList>(OrchestratorListParams {})
        .await
        .unwrap();
    assert!(empty.orchestrators.is_empty());
    assert_eq!(empty.seq, 0);

    let params = create_params(dir.path(), "parallax");
    let created = client
        .call::<OrchestratorCreate>(params.clone())
        .await
        .unwrap()
        .orchestrator;
    assert_eq!(created.id, params.id);
    assert_eq!(created.name, params.name);
    assert_eq!(created.repo_path, params.repo_path);
    assert_eq!(created.created_at, created.updated_at);

    let retried = client
        .call::<OrchestratorCreate>(params.clone())
        .await
        .unwrap()
        .orchestrator;
    assert_eq!(
        retried, created,
        "a retry returns the stored orchestrator unchanged"
    );

    let second = client
        .call::<OrchestratorCreate>(create_params(dir.path(), "roster"))
        .await
        .unwrap()
        .orchestrator;
    let listed = client
        .call::<OrchestratorList>(OrchestratorListParams {})
        .await
        .unwrap();
    assert_eq!(listed.orchestrators, [created, second], "oldest first");
    assert_eq!(
        listed.seq, 2,
        "one event per new orchestrator, none for the retry"
    );
}

#[tokio::test]
async fn orchestrators_and_the_event_log_outlive_a_restart() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::connect(&plxd.socket).await;
    let first_log = client.initialize().await.unwrap().log_id;
    let created = client
        .call::<OrchestratorCreate>(create_params(dir.path(), "parallax"))
        .await
        .unwrap()
        .orchestrator;
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
        .call::<OrchestratorList>(OrchestratorListParams {})
        .await
        .unwrap();
    assert_eq!(listed.orchestrators, [created]);
    assert_eq!(listed.seq, 1, "orchestrator.created is still in the log");
}
