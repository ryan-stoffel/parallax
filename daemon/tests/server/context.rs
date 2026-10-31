//! `context/list`, `context/read`, and `context/write` (#155), and the paths and symlinks they
//! refuse.

use std::os::unix::fs::symlink;

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{ContextList, ContextRead, ContextWrite, OrchestratorCreate};
use parallax_protocol::{
    ContextListParams, ContextReadParams, ContextWriteId, ContextWriteParams, Orchestrator, ScopeId,
};

use crate::support::{Client, Plxd, create_params, temp_dir};

async fn project(client: &mut Client, dir: &std::path::Path) -> Orchestrator {
    client
        .call::<OrchestratorCreate>(create_params(dir, "parallax"))
        .await
        .unwrap()
        .orchestrator
}

fn write_params(
    project: ScopeId,
    path: &str,
    content: &str,
    writer: Option<&str>,
) -> ContextWriteParams {
    ContextWriteParams {
        id: ContextWriteId::generate(),
        project,
        path: path.to_owned(),
        content: content.to_owned(),
        writer: writer.map(str::to_owned),
    }
}

#[tokio::test]
async fn write_read_and_list_round_trip() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;

    let written = client
        .call::<ContextWrite>(write_params(
            project.id,
            "plan.md",
            "# Notes",
            Some("editor"),
        ))
        .await
        .unwrap();
    assert_eq!(written.file.path, "plan.md");
    assert_eq!(written.file.size, "# Notes".len() as u64);
    assert_eq!(written.file.last_writer.as_deref(), Some("editor"));

    let read = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "plan.md".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(read.content, "# Notes");
    assert_eq!(read.file, written.file);

    let listed = client
        .call::<ContextList>(ContextListParams {
            project: project.id,
        })
        .await
        .unwrap();
    assert_eq!(listed.files, vec![written.file]);
}

#[tokio::test]
async fn concurrent_writes_to_one_path_leave_a_consistent_last_writer() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;

    let mut a = Client::ready(&plxd.socket).await;
    let mut b = Client::ready(&plxd.socket).await;
    let (result_a, result_b) = tokio::join!(
        a.call::<ContextWrite>(write_params(project.id, "plan.md", "from a", Some("a"))),
        b.call::<ContextWrite>(write_params(project.id, "plan.md", "from b", Some("b"))),
    );
    result_a.unwrap();
    result_b.unwrap();

    let read = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "plan.md".to_owned(),
        })
        .await
        .unwrap();
    assert!(
        read.content == "from a" || read.content == "from b",
        "{}",
        read.content
    );
    let expected_writer = if read.content == "from a" { "a" } else { "b" };
    assert_eq!(
        read.file.last_writer.as_deref(),
        Some(expected_writer),
        "the recorded writer must match whichever content actually landed on disk"
    );
}

#[tokio::test]
async fn traversal_absolute_hidden_nested_and_bad_extension_paths_are_refused() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;

    for path in [
        "../escape.md",
        "/etc/plan.md",
        "sub/plan.md",
        ".hidden.md",
        "notes.png",
        "notes",
        "..",
    ] {
        let write_error = client
            .call::<ContextWrite>(write_params(project.id, path, "x", None))
            .await
            .unwrap_err();
        assert_eq!(write_error.code, INVALID_PARAMS, "write {path:?}");

        let read_error = client
            .call::<ContextRead>(ContextReadParams {
                project: project.id,
                path: path.to_owned(),
            })
            .await
            .unwrap_err();
        assert_eq!(read_error.code, INVALID_PARAMS, "read {path:?}");
    }

    let listed = client
        .call::<ContextList>(ContextListParams {
            project: project.id,
        })
        .await
        .unwrap();
    assert!(listed.files.is_empty(), "nothing invalid was ever written");
}

#[tokio::test]
async fn a_pre_existing_symlink_is_refused_for_read_and_write_and_left_untouched() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;
    // Ensures the project's context folder exists before this test plants a symlink in it.
    client
        .call::<ContextList>(ContextListParams {
            project: project.id,
        })
        .await
        .unwrap();

    let outside = dir.path().join("outside.md");
    std::fs::write(&outside, "secret").unwrap();
    let context_dir = dir.path().join("context").join(project.id.to_string());
    symlink(&outside, context_dir.join("plan.md")).unwrap();

    let write_error = client
        .call::<ContextWrite>(write_params(project.id, "plan.md", "clobbered", None))
        .await
        .unwrap_err();
    assert_eq!(write_error.code, INVALID_PARAMS);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");

    let read_error = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "plan.md".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(read_error.code, INVALID_PARAMS);
}
