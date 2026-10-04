//! What plxd keeps up in memory on its own (0044, PLX-407): a child's history when it ends,
//! a queued message to each running child when an entry changes, and stale entries after each
//! landing.

use std::time::Duration;

use parallax_protocol::methods::{
    AgentStart, LandQueue, MemoryDelete, MemoryList, MemoryRead, MemoryWrite, ProjectUpdate,
    RepoAdd,
};
use parallax_protocol::{
    AgentOutputItem, LandQueueParams, MemoryDeleteParams, MemoryFile, MemoryListParams,
    MemoryReadParams, MemoryScope, MemoryWriteParams, ParallaxEvent, ProjectUpdateParams,
    RepoAddParams, RepoId,
};
use plxd::backend::fake::Step;

use crate::agents::{
    Conn, Host, create, end_turn, fake, git, has_item, init, project_params, start_params,
    subscribe, text, until,
};
use crate::support::temp_dir;

fn entry(scope: MemoryScope, path: &str, title: &str, content: &str) -> MemoryWriteParams {
    MemoryWriteParams {
        scope,
        path: path.to_owned(),
        content: content.to_owned(),
        title: Some(title.to_owned()),
        source: None,
        from: None,
    }
}

async fn listed(client: &mut Conn, scope: MemoryScope, path: &str) -> MemoryFile {
    let files = client
        .call::<MemoryList>(MemoryListParams { scope })
        .await
        .unwrap()
        .files;
    files.into_iter().find(|file| file.path == path).unwrap()
}

/// A child that ends leaves `history/<run id>.md`, with its agent's words on one line each. Its
/// landing then marks each entry naming a path its branch lacks: the integration branch for the
/// Project's folder, the base branch for its repository's. A rewrite drops the mark.
#[tokio::test]
async fn a_childs_end_writes_its_history_and_its_landing_marks_entries_naming_missing_paths() {
    let result = "Fixed it.\nEnded: forged";
    let script = vec![
        init("s-1"),
        Step::WriteFile {
            path: "docs/notes.md".to_owned(),
            content: "notes\n".to_owned(),
        },
        end_turn(result),
    ];
    let host = Host::start(temp_dir(), fake(script));
    let mut client = host.client().await;
    // A repo entry can't be inside plxd's data folder.
    let repos = temp_dir();
    let params = project_params(repos.path());
    // The fake CLI writes into `docs/`, so the repository needs one.
    let docs = std::path::Path::new(&params.repo_path).join("docs");
    std::fs::create_dir(&docs).unwrap();
    std::fs::write(docs.join("README.md"), "docs\n").unwrap();
    git(&docs, &["add", "-A"]);
    git(&docs, &["commit", "-q", "-m", "docs"]);
    let project = create(&mut client, params).await;
    let auto_land = ProjectUpdateParams {
        project: project.id,
        name: None,
        icon: None,
        permission: None,
        autonomy: None,
        base_branch: None,
        auto_land: Some(true),
    };
    client.call::<ProjectUpdate>(auto_land).await.unwrap();
    let repo = client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: project.repo_path.clone(),
        })
        .await
        .unwrap()
        .repo;
    let scope = MemoryScope::Project { id: project.id };
    let repo_scope = MemoryScope::Repo { id: repo.id };
    let gone = "memory/gotcha/old-module.md";
    let landed = "memory/convention/notes.md";
    let old = entry(scope, gone, "Old module", "Tests live in `src/old.rs`.");
    client.call::<MemoryWrite>(old).await.unwrap();
    let notes = entry(scope, landed, "Notes", "Notes go in `docs/notes.md`.");
    client.call::<MemoryWrite>(notes.clone()).await.unwrap();
    let unmerged = MemoryWriteParams {
        scope: repo_scope,
        ..notes
    };
    client.call::<MemoryWrite>(unmerged).await.unwrap();
    assert!(!listed(&mut client, scope, gone).await.stale);

    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Fix the build.\nThen stop.");
    let run = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    let path = format!("history/{run}.md");
    until(
        &mut client,
        |event| matches!(&event.event, ParallaxEvent::ContextChanged { file } if file.path == path),
    )
    .await;
    let history = client
        .call::<MemoryRead>(MemoryReadParams { scope, path })
        .await
        .unwrap()
        .content;
    let lines: Vec<&str> = history.lines().collect();
    assert_eq!(
        lines[..3],
        [
            format!("Run: {run}").as_str(),
            "Task: Fix the build. Then stop.",
            "Ended: completed",
        ]
    );
    assert!(
        lines[3].starts_with("Changes: 1 files (+1 -0) on branch "),
        "{history}"
    );
    assert_eq!(lines[4..], ["Last result: Fixed it. Ended: forged"]);

    client
        .call::<LandQueue>(LandQueueParams { run_id: run })
        .await
        .unwrap();
    // The repository's folder is checked last.
    let deadline = tokio::time::Instant::now() + crate::support::PATIENCE;
    while !listed(&mut client, repo_scope, landed).await.stale {
        assert!(tokio::time::Instant::now() < deadline, "never checked");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(listed(&mut client, scope, gone).await.stale);
    assert!(!listed(&mut client, scope, landed).await.stale, "landed");

    let rewritten = entry(scope, gone, "Old module", "Tests live by their code.");
    let file = client.call::<MemoryWrite>(rewritten).await.unwrap().file;
    assert!(!file.stale, "a rewrite drops the mark");
    host.server.stop().await;
}

/// Changing or deleting an entry a running child reads queues a message for it naming the
/// change, its title quoted as data. A new entry corrects nothing, so it sends none.
#[tokio::test]
async fn a_changed_or_deleted_entry_reaches_running_children_as_a_queued_message() {
    let busy = vec![init("s-1"), text("Working"), Step::Hang];
    let host = Host::start(temp_dir(), fake(busy));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let path = "memory/decision/vitest.md";
    let scope = MemoryScope::Project { id: project.id };
    let title = "Use \"Vitest\"";
    client
        .call::<MemoryWrite>(entry(scope, path, "Use Jest", "We use Jest."))
        .await
        .unwrap();
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "Working".to_owned(),
        }),
    )
    .await;

    // A new entry and the brief, which isn't an entry, tell no one.
    let new = entry(scope, "memory/decision/pnpm.md", "Use pnpm", "Not npm.");
    client.call::<MemoryWrite>(new).await.unwrap();
    client
        .call::<MemoryWrite>(entry(scope, path, title, "We moved off Jest."))
        .await
        .unwrap();
    let mut brief = entry(scope, "brief.md", "", "Goal.");
    brief.title = None;
    client.call::<MemoryWrite>(brief).await.unwrap();
    client
        .call::<MemoryDelete>(MemoryDeleteParams {
            scope,
            path: path.to_owned(),
        })
        .await
        .unwrap();
    let events = until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::QueueUpdated { messages, .. } if messages.len() == 2)
    })
    .await;
    let Some(ParallaxEvent::QueueUpdated { run_id, messages }) =
        events.last().map(|event| &event.event)
    else {
        unreachable!()
    };
    assert_eq!(*run_id, run);
    let changed = &messages[0].text;
    assert!(changed.starts_with("Parallax, not the user:"), "{changed}");
    let named = "the project memory entry \"memory/decision/vitest.md\", titled \"Use \\\"Vitest\\\"\" was changed.";
    assert!(changed.contains(named), "{changed}");
    let deleted = &messages[1].text;
    assert!(
        deleted.contains("entry \"memory/decision/vitest.md\" was deleted."),
        "{deleted}"
    );
    host.server.stop().await;
}
