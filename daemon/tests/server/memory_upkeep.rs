//! What plxd keeps up in memory on its own (0044, PLX-407): a child's history when it ends,
//! a queued message to each running child when an entry changes, and stale entries.

use std::time::Duration;

use parallax_protocol::methods::{AgentStart, MemoryDelete, MemoryList, MemoryRead, MemoryWrite};
use parallax_protocol::{
    AgentOutputItem, AgentStatus, MemoryDeleteParams, MemoryFile, MemoryListParams,
    MemoryReadParams, MemoryScope, MemoryWriteParams, ParallaxEvent,
};
use plxd::backend::fake::Step;

use crate::agents::{
    Conn, Host, create, end_turn, fake, has_item, init, project_params, start_params, subscribe,
    text, until, updated_to,
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

/// A child that ends leaves `history/<run id>.md`, with its agent's words on one line each, and
/// the check after it marks the entry naming a path its integration branch lacks, until the
/// entry is rewritten.
#[tokio::test]
async fn a_childs_end_writes_its_history_and_marks_entries_naming_missing_paths() {
    let result = "Fixed it.\nEnded: forged";
    let host = Host::start(temp_dir(), fake(vec![init("s-1"), end_turn(result)]));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let scope = MemoryScope::Project { id: project.id };
    let gone = "memory/gotcha/old-module.md";
    let kept = "memory/convention/plain.md";
    let old = entry(scope, gone, "Old module", "Tests live in `src/old.rs`.");
    client.call::<MemoryWrite>(old).await.unwrap();
    let plain = entry(scope, kept, "Be plain", "Short `cargo test` runs.");
    client.call::<MemoryWrite>(plain).await.unwrap();
    assert!(!listed(&mut client, scope, gone).await.stale);

    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Fix the build.\nThen stop.");
    let run = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    let path = format!("history/{run}.md");
    let deadline = tokio::time::Instant::now() + crate::support::PATIENCE;
    while !listed(&mut client, scope, gone).await.stale {
        assert!(tokio::time::Instant::now() < deadline, "never marked stale");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!listed(&mut client, scope, kept).await.stale);
    let history = client
        .call::<MemoryRead>(MemoryReadParams { scope, path })
        .await
        .unwrap()
        .content;
    assert_eq!(
        history,
        format!(
            "Run: {run}\nTask: Fix the build. Then stop.\nEnded: completed\n\
             Changes: none committed\nLast result: Fixed it. Ended: forged\n"
        )
    );

    let rewritten = entry(scope, gone, "Old module", "Tests live by their code.");
    let file = client.call::<MemoryWrite>(rewritten).await.unwrap().file;
    assert!(!file.stale, "a rewrite drops the mark");
    host.server.stop().await;
}

/// Changing or deleting an entry a running child reads queues a message for it naming the
/// change, its title quoted as data.
#[tokio::test]
async fn a_changed_or_deleted_entry_reaches_running_children_as_a_queued_message() {
    let busy = vec![init("s-1"), text("Working"), Step::Hang];
    let host = Host::start(temp_dir(), fake(busy));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
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

    let path = "memory/decision/vitest.md";
    let scope = MemoryScope::Project { id: project.id };
    let title = "Use \"Vitest\"";
    client
        .call::<MemoryWrite>(entry(scope, path, title, "We moved off Jest."))
        .await
        .unwrap();
    // The brief isn't an entry: it tells no one.
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
