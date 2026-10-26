//! Memory end to end (PLX-405, decision 0044): the app's `memory/*` methods, which write as the
//! user, and the memory tools of `plxd mcp --thread`, by the caller's role: only a coordinator
//! writes, and a child's presented files never follow a symlink.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::jsonrpc::{ErrorObject, INVALID_PARAMS};
use parallax_protocol::methods::{
    AgentList, ContextList, ContextSaveArtifact, ContextWrite, InboxList, MemoryDelete, MemoryList,
    MemoryPropose, MemoryRead, MemoryWrite, RepoAdd,
};
use parallax_protocol::{
    AgentListParams, AgentRun, AgentStatus, ContextListParams, ContextSaveArtifactParams,
    ContextWriteId, ContextWriteParams, ErrorKind, InboxKind, InboxListParams, MemoryDeleteParams,
    MemoryFile, MemoryKind, MemoryListParams, MemoryProposeParams, MemoryReadParams,
    MemoryReadResult, MemoryScope, MemoryWriteParams, Project, ProjectId, Repo, RepoAddParams,
    RepoId, RunId,
};
use plxd::backend::RunRequest;
use plxd::backend::fake::Step;
use serde_json::json;

use crate::agents::{
    Conn, Host, create, end_turn, fake, init, project_params, real_repo, until, updated_to,
};
use crate::coordinator::{plan, roles, spawn};
use crate::mcp::{Mcp, mcp_command};
use crate::support::{kind, temp_dir};

fn write(scope: MemoryScope, path: &str, content: &str, title: Option<&str>) -> MemoryWriteParams {
    MemoryWriteParams {
        scope,
        path: path.to_owned(),
        content: content.to_owned(),
        title: title.map(str::to_owned),
        source: None,
        from: None,
    }
}

async fn files(client: &mut Conn, scope: MemoryScope) -> Vec<MemoryFile> {
    client
        .call::<MemoryList>(MemoryListParams { scope })
        .await
        .unwrap()
        .files
}

async fn paths(client: &mut Conn, scope: MemoryScope) -> Vec<String> {
    let files = files(client, scope).await;
    files.into_iter().map(|file| file.path).collect()
}

async fn read(
    client: &mut Conn,
    scope: MemoryScope,
    path: &str,
) -> Result<MemoryReadResult, ErrorObject> {
    let path = path.to_owned();
    client
        .call::<MemoryRead>(MemoryReadParams {
            scope,
            path,
            from: None,
        })
        .await
}

async fn delete(client: &mut Conn, scope: MemoryScope, path: &str) {
    let path = path.to_owned();
    client
        .call::<MemoryDelete>(MemoryDeleteParams { scope, path })
        .await
        .unwrap();
}

/// A run's proposal, as a thread's tools send it.
fn proposal(from: RunId, scope: MemoryScope, title: &str) -> MemoryProposeParams {
    MemoryProposeParams {
        from,
        scope,
        kind: Some(MemoryKind::Gotcha),
        title: title.to_owned(),
        content: "Details.".to_owned(),
        replaces: None,
    }
}

/// A repo entry for a new repository outside the data folder, which `_repos` keeps.
async fn repo(client: &mut Conn) -> (Repo, tempfile::TempDir) {
    let repos = temp_dir();
    let path = real_repo(repos.path()).to_str().unwrap().to_owned();
    let id = RepoId::generate();
    let added = client.call::<RepoAdd>(RepoAddParams { id, path }).await;
    (added.unwrap().repo, repos)
}

async fn tools(host: &Host, run: RunId) -> Mcp {
    let run = run.to_string();
    Mcp::spawn(mcp_command(host.dir.path(), &["--thread", &run])).await
}

/// The names `mcp`'s `tools/list` gives, but the device tools (PLX-640) and the schedule and
/// pull request tools (0063) every caller gets last.
async fn names(mcp: &mut Mcp) -> Vec<String> {
    let listed = mcp.request("tools/list", json!({})).await;
    let mut names: Vec<String> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    let last = [
        plxd::mcp::html::TOOLS,
        plxd::mcp::files::TOOLS,
        plxd::mcp::preview::TOOLS,
        plxd::mcp::device::TOOLS,
        plxd::mcp::triggers::TOOLS,
        plxd::mcp::delegation::TOOLS,
        plxd::mcp::COMPUTER_TOOLS,
    ]
    .concat();
    let devices = names.split_off(names.len() - last.len());
    assert_eq!(devices, last, "every caller's last tools");
    names
}

/// A Project whose coordinator has finished its first turn, and whose children hang.
async fn project_with_coordinator(
    seen: &Arc<Mutex<Vec<RunRequest>>>,
) -> (Host, Conn, Project, AgentRun) {
    let turn = |result: &str| vec![init("coordinator-1"), end_turn(result)];
    let backends = roles(
        vec![init("worker-1"), Step::Hang],
        vec![turn("Planned."), turn("Noted.")],
        seen,
    );
    let host = Host::start(temp_dir(), backends);
    let (mut client, project) = host.project_client().await;
    let coordinator = plan(&mut client, project.id).await;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    (host, client, project, coordinator)
}

/// The app writes an entry as the user, with plxd's header, and lists, reads, and deletes it. The
/// board isn't memory.
#[tokio::test]
async fn the_app_writes_reads_lists_and_deletes_an_entry_as_the_user() {
    let host = Host::start(temp_dir(), fake(vec![init("s-1"), end_turn("Done.")]));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let scope = MemoryScope::Project { id: project.id };
    let path = "memory/decision/vitest.md";

    let refused = client
        .call::<MemoryWrite>(write(scope, path, "Body.", None))
        .await
        .unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "an entry needs a title");
    let body = "We moved off Jest.\n";
    let written = client
        .call::<MemoryWrite>(write(scope, path, body, Some("Use Vitest")))
        .await
        .unwrap()
        .file;
    assert_eq!(written.kind, Some(MemoryKind::Decision));
    assert_eq!(written.title.as_deref(), Some("Use Vitest"));
    assert_eq!(written.writer.as_deref(), Some("user"));
    assert_eq!(written.source.as_deref(), Some("user"));
    let folder = host.dir.path().join("context").join(project.id.to_string());
    let on_disk = std::fs::read_to_string(folder.join(path)).unwrap();
    let header = "Kind: decision\nTitle: Use Vitest\nSource: user\nDate: ";
    assert!(on_disk.starts_with(header), "{on_disk}");
    assert!(on_disk.ends_with("Writer: user\n\nWe moved off Jest.\n"));

    let brief = write(scope, "brief.md", "# Goal\n", None);
    client.call::<MemoryWrite>(brief).await.unwrap();
    client
        .call::<ContextWrite>(ContextWriteParams {
            id: ContextWriteId::generate(),
            project: project.id,
            path: "plan.md".to_owned(),
            content: "Board".to_owned(),
            writer: None,
        })
        .await
        .unwrap();
    assert_eq!(paths(&mut client, scope).await, ["brief.md", path]);
    let entry = read(&mut client, scope, path).await.unwrap();
    assert_eq!(entry.content, body);
    assert_eq!(entry.file.title.as_deref(), Some("Use Vitest"));

    delete(&mut client, scope, path).await;
    let gone = read(&mut client, scope, path).await.unwrap_err();
    assert_eq!(kind(&gone), ErrorKind::ContextNotFound);
    host.server.stop().await;
}

/// You lives in `context/you`, a repo entry's memory in its own folder, and paths outside 0044's
/// layout and unknown scopes are refused.
#[tokio::test]
async fn the_you_and_repo_scopes_take_memory_and_bad_paths_are_refused() {
    let host = Host::start(temp_dir(), fake(vec![init("s-1"), end_turn("Done.")]));
    let mut client = host.client().await;
    let tabs = write(
        MemoryScope::You,
        "memory/preference/tabs.md",
        "Tabs.",
        Some("Tabs"),
    );
    client.call::<MemoryWrite>(tabs).await.unwrap();
    let you = host
        .dir
        .path()
        .join("context/you/memory/preference/tabs.md");
    assert!(you.is_file());

    let (repo, _repos) = repo(&mut client).await;
    let scope = MemoryScope::Repo { id: repo.id };
    let auth = write(scope, "knowledge/auth.md", "How auth works.", None);
    client.call::<MemoryWrite>(auth).await.unwrap();
    assert_eq!(paths(&mut client, scope).await, ["knowledge/auth.md"]);

    for bad in [
        "notes.md",
        "../x.md",
        "history/run.md",
        "proposals/x.md",
        "memory/other/x.md",
    ] {
        let refused = client
            .call::<MemoryWrite>(write(scope, bad, "x", Some("X")))
            .await
            .unwrap_err();
        assert_eq!(refused.code, INVALID_PARAMS, "{bad}");
    }
    let id = ProjectId::generate();
    let scope = MemoryScope::Project { id };
    let missing = client
        .call::<MemoryList>(MemoryListParams { scope })
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::ProjectNotFound);
    let id = RepoId::generate();
    let scope = MemoryScope::Repo { id };
    let missing = client
        .call::<MemoryList>(MemoryListParams { scope })
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::RepoNotFound);
    host.server.stop().await;
}

/// Only the coordinator writes, and its write adds a `learned` inbox item. Its child has no
/// `memory_write`, and plxd refuses one in its name. Only the user writes the brief.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_coordinator_writes_and_its_write_adds_a_learned_item() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let scope = MemoryScope::Project { id: project.id };

    let mut curator = tools(&host, coordinator.id).await;
    let offered = names(&mut curator).await;
    assert_eq!(
        offered[offered.len() - 3..],
        ["memory_read", "memory_propose", "memory_write"]
    );
    let written = curator
        .ok(
            "memory_write",
            json!({"path": "memory/gotcha/flaky.md", "title": "CI is flaky", "content": "Retry."}),
        )
        .await;
    assert_eq!(written["writer"], format!("coordinator {}", coordinator.id));
    let params = InboxListParams {
        project: project.id,
    };
    let inbox = client.call::<InboxList>(params).await.unwrap().items;
    let learned = inbox.iter().find(|item| item.kind == InboxKind::Learned);
    let learned = learned.expect("a learned item");
    assert_eq!(learned.run, coordinator.id);
    assert!(learned.text.contains("CI is flaky"), "{}", learned.text);

    let child = spawn(&mut client, &coordinator, "Fix the build.").await;
    let mut of_child = tools(&host, child).await;
    let offered = names(&mut of_child).await;
    assert_eq!(
        offered[offered.len() - 2..],
        ["memory_read", "memory_propose"]
    );
    let call =
        json!({"name": "memory_write", "arguments": {"path": "brief.md", "content": "Mine."}});
    let refused = of_child.request("tools/call", call).await;
    assert_eq!(refused["error"]["code"], -32602, "{refused}");
    let as_child = MemoryWriteParams {
        from: Some(child),
        ..write(scope, "brief.md", "Mine.", None)
    };
    let refused = client.call::<MemoryWrite>(as_child).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
    assert!(refused.message.contains("only a Project's coordinator"));
    let listed = of_child.ok("memory_read", json!({})).await;
    assert_eq!(listed["files"][0]["path"], "memory/gotcha/flaky.md");

    // 0044: the user writes or approves the brief, so the coordinator proposes it.
    let brief = json!({"path": "brief.md", "content": "Mine."});
    let refused = curator.refused("memory_write", brief).await;
    assert!(
        refused.contains("only the user writes the brief"),
        "{refused}"
    );
    let as_coordinator = MemoryWriteParams {
        from: Some(coordinator.id),
        ..write(scope, "brief.md", "Mine.", None)
    };
    let refused = client.call::<MemoryWrite>(as_coordinator).await;
    assert_eq!(refused.unwrap_err().code, INVALID_PARAMS);
    let childs_brief = MemoryProposeParams {
        kind: None,
        ..proposal(child, scope, "Brief")
    };
    let refused = client.call::<MemoryPropose>(childs_brief).await;
    assert_eq!(
        refused.unwrap_err().code,
        INVALID_PARAMS,
        "a coordinator's alone"
    );
    host.server.stop().await;
}

/// `run`'s worktree, once it has one.
async fn child_folder(client: &mut Conn, run: RunId) -> std::path::PathBuf {
    loop {
        let runs = client
            .call::<AgentList>(AgentListParams { project: None })
            .await
            .unwrap()
            .runs;
        let found = runs.into_iter().find(|found| found.id == run).unwrap();
        if let Some(path) = found.worktree_path {
            return std::path::PathBuf::from(path);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// PLX-941: a symlink in the child's folder is never followed, so it can't copy a file from
/// outside into the Project.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_symlinked_source_is_never_saved_as_an_artifact() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let child = spawn(&mut client, &coordinator, "Take a screenshot.").await;
    let folder = child_folder(&mut client, child).await;
    let outside = temp_dir();
    std::fs::write(outside.path().join("secret.png"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret.png"), folder.join("link.png")).unwrap();
    std::os::unix::fs::symlink(outside.path(), folder.join("linked")).unwrap();

    for path in ["link.png", "linked/secret.png"] {
        let save = ContextSaveArtifactParams {
            run_id: child,
            path: path.to_owned(),
        };
        let refused = client.call::<ContextSaveArtifact>(save).await;
        assert_eq!(refused.unwrap_err().code, INVALID_PARAMS, "{path}");
    }
    let listed = client
        .call::<ContextList>(ContextListParams {
            project: project.id,
        })
        .await
        .unwrap()
        .files;
    assert!(
        listed
            .iter()
            .all(|file| !file.path.starts_with("artifacts/")),
        "{listed:?}"
    );
    host.server.stop().await;
}
