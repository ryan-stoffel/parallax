//! `context/list`, `context/read`, and `context/write` (#155), and the watcher that turns an
//! agent's own writes on disk into `context.changed` events.

use std::os::unix::fs::symlink;
use std::time::Duration;

use parallax_protocol::jsonrpc::{INVALID_PARAMS, Message, Notification};
use parallax_protocol::methods::{
    ContextList, ContextRead, ContextWrite, EventsEvent, EventsSubscribe, NotificationMethod,
    ProjectCreate,
};
use parallax_protocol::{
    ContextListParams, ContextReadParams, ContextWriteId, ContextWriteParams, ErrorKind,
    EventsEventParams, EventsSubscribeParams, ParallaxEvent, Project, ProjectId,
};

use crate::support::{Client, Plxd, create_params, kind, temp_dir};

async fn project(client: &mut Client, dir: &std::path::Path) -> Project {
    client
        .call::<ProjectCreate>(create_params(dir, "parallax"))
        .await
        .unwrap()
        .project
}

fn write_params(
    project: ProjectId,
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

async fn next_event(client: &mut Client) -> EventsEventParams {
    match client.next().await {
        Some(Message::Notification(Notification { method, params })) => {
            assert_eq!(method, <EventsEvent as NotificationMethod>::NAME);
            serde_json::from_value(params.expect("params")).expect("an event")
        }
        other => panic!("expected an event, got {other:?}"),
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
            "notes.md",
            "# Notes",
            Some("editor"),
        ))
        .await
        .unwrap();
    assert_eq!(written.file.path, "notes.md");
    assert_eq!(written.file.size, "# Notes".len() as u64);
    assert_eq!(written.file.last_writer.as_deref(), Some("editor"));

    let read = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "notes.md".to_owned(),
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
async fn traversal_absolute_hidden_nested_and_bad_extension_paths_are_refused() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;

    for path in [
        "../escape.md",
        "/etc/notes.md",
        "sub/notes.md",
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
async fn reading_a_missing_file_is_context_not_found() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;

    let error = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "missing.md".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::ContextNotFound);
}

#[tokio::test]
async fn context_methods_for_an_unknown_project_are_project_not_found() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let missing = ProjectId::generate();

    let error = client
        .call::<ContextList>(ContextListParams { project: missing })
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::ProjectNotFound);

    let error = client
        .call::<ContextWrite>(write_params(missing, "notes.md", "x", None))
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::ProjectNotFound);
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
    symlink(&outside, context_dir.join("notes.md")).unwrap();

    let write_error = client
        .call::<ContextWrite>(write_params(project.id, "notes.md", "clobbered", None))
        .await
        .unwrap_err();
    assert_eq!(write_error.code, INVALID_PARAMS);
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");

    let read_error = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "notes.md".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(read_error.code, INVALID_PARAMS);
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
        a.call::<ContextWrite>(write_params(project.id, "notes.md", "from a", Some("a"))),
        b.call::<ContextWrite>(write_params(project.id, "notes.md", "from b", Some("b"))),
    );
    result_a.unwrap();
    result_b.unwrap();

    let read = client
        .call::<ContextRead>(ContextReadParams {
            project: project.id,
            path: "notes.md".to_owned(),
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
async fn a_write_emits_exactly_one_context_changed_event_and_an_agents_own_write_emits_another() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let project = project(&mut client, dir.path()).await;

    let mut watcher = Client::ready(&plxd.socket).await;
    watcher
        .call::<EventsSubscribe>(EventsSubscribeParams {
            after: 0,
            project: Some(project.id),
            run: None,
            shell: false,
        })
        .await
        .unwrap();

    client
        .call::<ContextWrite>(write_params(
            project.id,
            "notes.md",
            "hello",
            Some("editor"),
        ))
        .await
        .unwrap();
    let event = next_event(&mut watcher).await;
    assert_eq!(event.project, Some(project.id));
    match event.event {
        ParallaxEvent::ContextChanged { file } => {
            assert_eq!(file.path, "notes.md");
            assert_eq!(file.last_writer.as_deref(), Some("editor"));
        }
        other => panic!("expected context.changed, got {other:?}"),
    }
    // The write above must not also be reported by the disk watcher: plxd's own write is
    // suppressed as an echo of the one just reported.
    watcher.stays_quiet(Duration::from_millis(1500)).await;

    // An agent's own write, made directly on disk with no plxd call at all (0005).
    let context_dir = dir.path().join("context").join(project.id.to_string());
    std::fs::write(context_dir.join("research.md"), "from an agent").unwrap();
    let event = next_event(&mut watcher).await;
    assert_eq!(event.project, Some(project.id));
    match event.event {
        ParallaxEvent::ContextChanged { file } => {
            assert_eq!(file.path, "research.md");
            assert_eq!(
                file.last_writer, None,
                "plxd never made this write, so it has no writer to report"
            );
        }
        other => panic!("expected context.changed, got {other:?}"),
    }
}
