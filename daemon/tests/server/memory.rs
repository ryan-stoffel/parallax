//! Memory end to end (PLX-405, decision 0044): the app's `memory/*` methods, which write as the
//! user, and the memory tools of `plxd mcp --thread`, by the caller's role: a coordinator writes,
//! a Project's child proposes to its coordinator, and a plain thread proposes to the user.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::jsonrpc::{ErrorObject, INVALID_PARAMS};
use parallax_protocol::methods::{
    AgentStart, ContextWrite, InboxList, MemoryDelete, MemoryList, MemoryPropose, MemoryRead,
    MemoryWrite, ProjectStart, RepoAdd, ThreadStart,
};
use parallax_protocol::{
    AgentRun, AgentStatus, ContextWriteId, ContextWriteParams, ErrorKind, InboxKind,
    InboxListParams, MemoryDeleteParams, MemoryFile, MemoryKind, MemoryListParams,
    MemoryProposalTo, MemoryProposeParams, MemoryReadParams, MemoryReadResult, MemoryScope,
    MemoryScopeKind, MemoryWriteParams, Project, ProjectId, Repo, RepoAddParams, RepoId, RunId,
};
use plxd::backend::fake::Step;
use plxd::backend::{RunRequest, ToolPolicy};
use serde_json::json;

use crate::agents::{
    Conn, Host, create, end_turn, fake, init, project_params, real_repo, subscribe, until,
    updated_to,
};
use crate::coordinator::{coordinator_launches, nth_launch, roles, spawn, start_params};
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
        .call::<MemoryRead>(MemoryReadParams { scope, path })
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

async fn names(mcp: &mut Mcp) -> Vec<String> {
    let listed = mcp.request("tools/list", json!({})).await;
    listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect()
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
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
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
            path: "notes.md".to_owned(),
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

/// `context/write`, and so `write_context`, takes one file name: memory's folders are written
/// only through `memory/*`, by a child or a coordinator alike.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_context_never_reaches_memorys_folders_or_the_brief() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let child = spawn(&mut client, &coordinator, "Fix the build.").await;
    for run in [child, coordinator.id] {
        let mut mcp = tools(&host, run).await;
        for path in [
            "brief.md",
            "memory/decision/sneaky.md",
            "knowledge/x.md",
            "history/x.md",
            "proposals/x.md",
        ] {
            let write = json!({"path": path, "content": "x"});
            let refused = mcp.refused("write_context", write).await;
            assert!(refused.contains("one file name"), "{refused}");
        }
        mcp.ok("write_context", json!({"path": "notes.md", "content": "x"}))
            .await;
    }
    // The user still writes the brief, through memory/*.
    let scope = MemoryScope::Project { id: project.id };
    let brief = write(scope, "brief.md", "# Goal\n", None);
    client.call::<MemoryWrite>(brief).await.unwrap();
    assert_eq!(
        read(&mut client, scope, "brief.md").await.unwrap().content,
        "# Goal\n"
    );
    host.server.stop().await;
}

/// The paths of the proposals waiting in `project`'s folder.
async fn waiting(client: &mut Conn, project: ProjectId) -> Vec<String> {
    let scope = MemoryScope::Project { id: project };
    let mut paths = paths(client, scope).await;
    paths.retain(|path| path.starts_with("proposals/"));
    paths
}

/// Polls until no proposal waits in `project`'s folder.
async fn until_delivered(client: &mut Conn, project: ProjectId) {
    let deadline = tokio::time::Instant::now() + crate::support::PATIENCE;
    while !waiting(client, project).await.is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "never delivered");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A child's proposal waits on disk for the coordinator's next wake-up without causing one, and
/// is removed once delivered. The child gets neither the context folder's path nor access to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_proposal_waits_for_the_coordinators_next_wake_up() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let child = spawn(&mut client, &coordinator, "Fix the build.").await;
    let mut of_child = tools(&host, child).await;

    let (said, is_error) = of_child
        .tool(
            "memory_propose",
            json!({"kind": "convention", "title": "Tests sit by code", "content": "Put a_test.rs by a.rs."}),
        )
        .await;
    assert!(!is_error && said.contains("next wake-up"), "{said}");
    let path = "proposals/tests-sit-by-code.md";
    assert_eq!(waiting(&mut client, project.id).await, [path]);
    // Past wake-ups' 2 s batch: the proposal alone wakes nobody.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(coordinator_launches(&seen).len(), 1, "no wake-up yet");

    // A run the user starts wakes the coordinator, and the proposal goes with it.
    let theirs = crate::agents::start_params(project.id, "Add a README.");
    client.call::<AgentStart>(theirs).await.unwrap();
    let wake = nth_launch(&seen, 1).await.prompt;
    let line = format!(
        "- Proposal from thread {child}: a convention memory entry for the project scope, \"Tests sit by code\""
    );
    assert!(wake.contains(&line), "{wake}");
    assert!(wake.contains("  > Put a_test.rs by a.rs."), "{wake}");
    until_delivered(&mut client, project.id).await;

    let children: Vec<_> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.policy == ToolPolicy::WorkspaceWrite)
        .cloned()
        .collect();
    assert!(!children.is_empty());
    for child in children {
        let sandbox = child.sandbox.expect("a child keeps the worker sandbox");
        assert!(sandbox.writable.is_empty(), "{:?}", sandbox.writable);
        let folder = format!("context/{}", project.id);
        let named = child.prompt.contains(&folder) || child.prompt.contains("context folder");
        assert!(!named, "{}", child.prompt);
    }
    host.server.stop().await;
}

/// A child's proposal outlives a plxd restart, names the scope it is for, and goes with the
/// coordinator's first wake-up after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_proposal_survives_a_restart() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let child = spawn(&mut client, &coordinator, "Fix the build.").await;
    let mine = proposal(child, MemoryScope::You, "Kept across restarts");
    let proposed = client.call::<MemoryPropose>(mine).await.unwrap();
    assert_eq!(proposed.to, MemoryProposalTo::Coordinator);
    assert_eq!(
        proposed.file.unwrap().path,
        "proposals/kept-across-restarts.md"
    );
    drop(client);

    let turn = |result: &str| vec![init("coordinator-1"), end_turn(result)];
    let backends = roles(
        vec![init("worker-1"), Step::Hang],
        vec![turn("Noted."), turn("Noted again.")],
        &seen,
    );
    let host = host.restart(backends).await;
    let mut client = host.client().await;
    let theirs = crate::agents::start_params(project.id, "Add a README.");
    client.call::<AgentStart>(theirs).await.unwrap();
    let wake = nth_launch(&seen, 1).await.prompt;
    let line = format!(
        "- Proposal from thread {child}: a gotcha memory entry for the you scope, \"Kept across restarts\""
    );
    assert!(wake.contains(&line), "{wake}");
    until_delivered(&mut client, project.id).await;
    host.server.stop().await;
}

/// The first launch of a child whose task is `task`.
async fn child_launch(seen: &Mutex<Vec<RunRequest>>, task: &str) -> RunRequest {
    let deadline = tokio::time::Instant::now() + crate::support::PATIENCE;
    loop {
        let launches = seen.lock().unwrap().clone();
        let found = launches.into_iter().find(|request| {
            request.policy == ToolPolicy::WorkspaceWrite && request.prompt.ends_with(task)
        });
        if let Some(launch) = found {
            return launch;
        }
        assert!(tokio::time::Instant::now() < deadline, "never launched");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A child's first message carries the brief and then the memory index, You before Project,
/// after its header (0044, PLX-406).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_first_message_carries_the_brief_then_the_index() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let scope = MemoryScope::Project { id: project.id };
    let brief = write(scope, "brief.md", "Ship v2 by Friday.\n", None);
    client.call::<MemoryWrite>(brief).await.unwrap();
    let decision = write(
        scope,
        "memory/decision/vitest.md",
        "Body.",
        Some("Use Vitest"),
    );
    client.call::<MemoryWrite>(decision).await.unwrap();
    let terse = write(
        MemoryScope::You,
        "memory/preference/terse.md",
        "Body.",
        Some("Answer tersely"),
    );
    client.call::<MemoryWrite>(terse).await.unwrap();

    spawn(&mut client, &coordinator, "Fix the build.").await;
    let prompt = child_launch(&seen, "Fix the build.").await.prompt;
    let expected = "memory_propose.\n\nThe Project's brief:\nShip v2 by Friday.\n\n\
                    Memory, one line per entry as scope, kind, title, and path. Read one with \
                    memory_read:\n\
                    - you preference: Answer tersely (memory/preference/terse.md)\n\
                    - project decision: Use Vitest (memory/decision/vitest.md)\n\n\
                    Your task:\nFix the build.";
    assert!(prompt.ends_with(expected), "{prompt}");
    host.server.stop().await;
}

/// Over 8 KiB, the index ends with a note, and the coordinator's next wake-up asks it to merge
/// entries, without waking it on its own (0044).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_index_over_the_cap_asks_the_coordinator_to_merge_entries() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, _coordinator) = project_with_coordinator(&seen).await;
    let scope = MemoryScope::Project { id: project.id };
    let title = "t".repeat(250);
    for n in 0..40 {
        let path = format!("memory/gotcha/{n:02}.md");
        let entry = write(scope, &path, "Body.", Some(&title));
        client.call::<MemoryWrite>(entry).await.unwrap();
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        coordinator_launches(&seen).len(),
        1,
        "no wake-up of its own"
    );

    let theirs = crate::agents::start_params(project.id, "Add a README.");
    client.call::<AgentStart>(theirs).await.unwrap();
    let prompt = child_launch(&seen, "Add a README.").await.prompt;
    assert!(
        prompt.contains("more not listed. List each scope with memory_read and no path.\n"),
        "{prompt}"
    );
    let wake = nth_launch(&seen, 1).await.prompt;
    assert!(wake.contains("memory index is over 8 KiB"), "{wake}");
    host.server.stop().await;
}

/// The Memory tab's rewrite (0044): a coordinator proposes an entry and the brief for the user.
/// They wait in its Project's folder naming their scope, and a wake-up neither carries nor
/// removes them, though it delivers a child's proposal beside them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_coordinators_proposal_waits_for_the_user() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let mut curator = tools(&host, coordinator.id).await;

    let (said, is_error) = curator
        .tool(
            "memory_propose",
            json!({"scope": "you", "kind": "preference", "title": "Use Vitest", "content": "Not Jest."}),
        )
        .await;
    assert!(!is_error && said.contains("user"), "{said}");
    // A brief is a whole file, so the 4 KiB entry cap doesn't hold it.
    let goal = format!("# Goal\n\n{}\n", "Ship v2. ".repeat(1000));
    let brief = json!({"kind": "brief", "title": "Ship v2 first", "content": goal});
    let (said, is_error) = curator.tool("memory_propose", brief).await;
    assert!(!is_error, "{said}");
    let elsewhere = json!({"scope": "you", "kind": "brief", "title": "B", "content": "B"});
    let refused = curator.refused("memory_propose", elsewhere).await;
    assert!(refused.contains("brief"), "{refused}");

    let scope = MemoryScope::Project { id: project.id };
    let mut proposed = files(&mut client, scope).await;
    proposed.retain(|file| file.path.starts_with("proposals/"));
    let writer = Some(format!("coordinator {}", coordinator.id));
    let entry = &proposed[1];
    assert_eq!(entry.path, "proposals/use-vitest.md");
    assert_eq!(entry.kind, Some(MemoryKind::Preference));
    assert_eq!(entry.writer, writer);
    assert_eq!(entry.for_scope, Some(MemoryScopeKind::You));
    let brief = &proposed[0];
    assert_eq!(brief.path, "proposals/ship-v2-first.md");
    assert_eq!((brief.kind, &brief.writer), (None, &writer));
    assert_eq!(brief.for_scope, Some(MemoryScopeKind::Project));
    let read = read(&mut client, scope, &brief.path).await.unwrap();
    assert_eq!(read.content, goal);

    // A wake-up carries the child's proposal, and leaves the coordinator's for the user.
    let child = spawn(&mut client, &coordinator, "Fix the build.").await;
    let childs = proposal(child, scope, "Retry flaky tests");
    client.call::<MemoryPropose>(childs).await.unwrap();
    let theirs = crate::agents::start_params(project.id, "Add a README.");
    client.call::<AgentStart>(theirs).await.unwrap();
    let wake = nth_launch(&seen, 1).await.prompt;
    assert!(wake.contains("Retry flaky tests"), "{wake}");
    assert!(
        !wake.contains("Use Vitest") && !wake.contains("Ship v2"),
        "{wake}"
    );
    let deadline = tokio::time::Instant::now() + crate::support::PATIENCE;
    while waiting(&mut client, project.id).await.len() > 2 {
        assert!(tokio::time::Instant::now() < deadline, "never delivered");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        waiting(&mut client, project.id).await,
        ["proposals/ship-v2-first.md", "proposals/use-vitest.md"]
    );
    host.server.stop().await;
}

/// A coordinator's rewrite names the entry it replaces, so saving it doesn't add a second entry
/// when the new title's slug differs from the entry's file name. plxd checks the entry exists at
/// that scope with the proposal's kind, and only a coordinator names one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_coordinators_rewrite_names_the_entry_it_replaces() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator) = project_with_coordinator(&seen).await;
    let scope = MemoryScope::Project { id: project.id };
    let entry = "memory/decision/vitest.md";
    let first = write(scope, entry, "Not Jest.", Some("Use Vitest"));
    client.call::<MemoryWrite>(first).await.unwrap();
    let mut curator = tools(&host, coordinator.id).await;

    let rewrite = json!({"kind": "decision", "path": entry, "title": "Use Vitest, not Jest", "content": "Jest was slow."});
    let (said, is_error) = curator.tool("memory_propose", rewrite).await;
    assert!(!is_error, "{said}");
    let proposed = files(&mut client, scope).await;
    let proposed = proposed
        .iter()
        .find(|file| file.path.starts_with("proposals/"))
        .unwrap();
    assert_eq!(proposed.path, "proposals/use-vitest-not-jest.md");
    assert_eq!(proposed.replaces.as_deref(), Some(entry));
    assert_eq!(proposed.for_scope, Some(MemoryScopeKind::Project));

    for (path, kind) in [
        ("memory/decision/missing.md", "decision"),
        (entry, "gotcha"),
        ("brief.md", "brief"),
    ] {
        let args = json!({"kind": kind, "path": path, "title": "T", "content": "C"});
        let refused = curator.refused("memory_propose", args).await;
        assert!(refused.contains(path), "{refused}");
    }
    let child = spawn(&mut client, &coordinator, "Fix the build.").await;
    let childs = MemoryProposeParams {
        kind: Some(MemoryKind::Decision),
        replaces: Some(entry.to_owned()),
        ..proposal(child, scope, "Theirs")
    };
    let refused = client.call::<MemoryPropose>(childs).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "a coordinator's alone");
    host.server.stop().await;
}

/// A thread outside a Project proposes only at its repository's scope, and the proposal waits
/// for the user in `proposals/`. Its sandbox has no allowed folder for the repo's context folder,
/// so the tools are its only way to Repo memory (PLX-468). A thread with no repository has no
/// memory tools.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plain_threads_proposal_goes_to_the_user_at_its_repos_scope() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(vec![init("s-1"), end_turn("Done.")], Vec::new(), &seen);
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let (repo, _repos) = repo(&mut client).await;
    let start = crate::open_pr::thread(Some(repo.id));
    let thread = client.call::<ThreadStart>(start).await.unwrap().run.id;
    let launch = child_launch(&seen, "Rewrite the README").await;
    let sandbox = launch
        .sandbox
        .expect("a plain thread keeps the worker sandbox");
    assert!(sandbox.writable.is_empty(), "{:?}", sandbox.writable);
    let mut mcp = tools(&host, thread).await;

    let elsewhere =
        json!({"scope": "you", "kind": "preference", "title": "Tabs", "content": "Tabs."});
    let refused = mcp.refused("memory_propose", elsewhere).await;
    assert!(refused.contains("one of repo"), "{refused}");
    let (said, is_error) = mcp
        .tool(
            "memory_propose",
            json!({"kind": "gotcha", "title": "The dev server needs Node 22", "content": "Older Node fails."}),
        )
        .await;
    assert!(!is_error && said.contains("user"), "{said}");
    let scope = MemoryScope::Repo { id: repo.id };
    let listed = files(&mut client, scope).await;
    assert_eq!(listed.len(), 1);
    let proposed = &listed[0];
    assert_eq!(proposed.path, "proposals/the-dev-server-needs-node-22.md");
    assert_eq!(proposed.kind, Some(MemoryKind::Gotcha));
    assert_eq!(proposed.writer, Some(format!("thread {thread}")));
    let you = proposal(thread, MemoryScope::You, "Elsewhere");
    let refused = client.call::<MemoryPropose>(you).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "repository scope only");
    delete(&mut client, scope, &proposed.path).await;

    let start = crate::open_pr::thread(None);
    let scratch = client.call::<ThreadStart>(start).await.unwrap().run.id;
    let mut none = tools(&host, scratch).await;
    let offered = names(&mut none).await;
    assert!(offered.iter().all(|name| !name.starts_with("memory_")));
    host.server.stop().await;
}
