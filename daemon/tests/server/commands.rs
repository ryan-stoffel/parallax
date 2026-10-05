//! Command ids (PLX-482, 0052): a listed method's receipt, id conflicts, and start-time cleanup.

use parallax_protocol::jsonrpc::{ErrorObject, Request, RequestId};
use parallax_protocol::methods::{ProjectCreate, ProjectDelete, ProjectList, RequestMethod};
use parallax_protocol::{ErrorKind, ProjectDeleteParams, ProjectListParams, ProjectListResult};
use rustix::process::Signal;
use serde_json::json;
use uuid::Uuid;

use crate::support::{Client, Plxd, create_params, kind, temp_dir};

#[tokio::test]
async fn a_listed_method_returns_the_first_result_and_does_not_apply_twice() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;

    let created = client
        .call::<ProjectCreate>(create_params(dir.path(), "once"))
        .await
        .unwrap()
        .project;
    let command_id = Uuid::now_v7();
    let params = ProjectDeleteParams {
        project: created.id,
    };
    let first = call_with_command::<ProjectDelete>(&mut client, params.clone(), command_id)
        .await
        .unwrap();
    let again = call_with_command::<ProjectDelete>(&mut client, params, command_id)
        .await
        .unwrap();
    assert_eq!(again, first);

    let listed = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    assert!(
        listed
            .projects
            .iter()
            .all(|project| project.id != created.id),
        "the project was deleted once: {listed:?}"
    );

    let other = client
        .call::<ProjectCreate>(create_params(dir.path(), "other"))
        .await
        .unwrap()
        .project;
    let conflict = call_with_command::<ProjectDelete>(
        &mut client,
        ProjectDeleteParams { project: other.id },
        command_id,
    )
    .await
    .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);
    assert_eq!(names(&mut client).await, vec!["other".to_owned()]);
}

#[tokio::test]
async fn an_unfinished_claim_is_deleted_on_restart_and_a_retry_runs_again() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let created = client
        .call::<ProjectCreate>(create_params(dir.path(), "restart"))
        .await
        .unwrap()
        .project;
    drop(client);
    plxd.signal(Signal::TERM);
    let _ = plxd.exit().await;

    let command_id = Uuid::now_v7();
    let params = ProjectDeleteParams {
        project: created.id,
    };
    let store = parallax_store::Store::open(dir.path().join("plxd.sqlite3")).unwrap();
    let (inserted, _) = store
        .claim_command(
            &command_id.hyphenated().to_string(),
            ProjectDelete::NAME,
            "unused-after-restart",
            None,
        )
        .unwrap();
    assert!(inserted);
    drop(store);

    let plxd = Plxd::start(dir.path()).await;
    let conn = rusqlite::Connection::open(dir.path().join("plxd.sqlite3")).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM command_receipts WHERE command_id = ?1",
            rusqlite::params![command_id.hyphenated().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "the unfinished claim is gone after restart");

    let mut client = Client::ready(&plxd.socket).await;
    call_with_command::<ProjectDelete>(&mut client, params, command_id)
        .await
        .unwrap();
    assert!(
        names(&mut client).await.is_empty(),
        "the retry ran after the unfinished claim was dropped"
    );
}

#[tokio::test]
async fn receipt_failure_rolls_back_delete_and_retries_do_not_wait_without_an_owner() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = client
        .call::<ProjectCreate>(create_params(dir.path(), "receipt-failure"))
        .await
        .unwrap()
        .project;
    let db = rusqlite::Connection::open(dir.path().join("plxd.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_receipt_fill BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(FAIL, 'receipt fill failed'); END;
        CREATE TRIGGER fail_receipt_delete BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(FAIL, 'receipt delete failed'); END;").unwrap();
    let id = Uuid::now_v7();
    let params = ProjectDeleteParams {
        project: project.id,
    };
    assert!(
        call_with_command::<ProjectDelete>(&mut client, params.clone(), id)
            .await
            .is_err()
    );
    // Both completing and cleaning up the claim fail. A later retry has no running owner.
    let retry = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        call_with_command::<ProjectDelete>(&mut client, params, id),
    )
    .await
    .expect("abandoned claim must not hang");
    assert!(retry.is_err());
    assert_eq!(names(&mut client).await, vec!["receipt-failure"]);
    let result: Option<String> = db
        .query_row(
            "SELECT result FROM command_receipts WHERE command_id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn deleted_project_receipt_survives_restart() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = client
        .call::<ProjectCreate>(create_params(dir.path(), "durable"))
        .await
        .unwrap()
        .project;
    let id = Uuid::now_v7();
    let params = ProjectDeleteParams {
        project: project.id,
    };
    let first = call_with_command::<ProjectDelete>(&mut client, params.clone(), id)
        .await
        .unwrap();
    drop(client);
    plxd.signal(Signal::TERM);
    let _ = plxd.exit().await;
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    assert_eq!(
        call_with_command::<ProjectDelete>(&mut client, params, id)
            .await
            .unwrap(),
        first
    );
}

async fn names(client: &mut Client) -> Vec<String> {
    let listed: ProjectListResult = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    listed
        .projects
        .into_iter()
        .map(|project| project.name)
        .collect()
}

pub(crate) async fn call_with_command<M: RequestMethod>(
    client: &mut Client,
    params: M::Params,
    command_id: Uuid,
) -> Result<M::Result, ErrorObject> {
    let mut value = serde_json::to_value(params).unwrap();
    value.as_object_mut().unwrap().insert(
        "commandId".to_owned(),
        json!(command_id.hyphenated().to_string()),
    );
    let id = RequestId::String(command_id.hyphenated().to_string());
    client
        .send_message(&Request {
            id: id.clone(),
            method: M::NAME.to_owned(),
            params: Some(value),
        })
        .await;
    let response = client.response().await;
    assert_eq!(response.id, Some(id));
    response.into_result()
}
