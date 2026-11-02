use parallax_store::{
    ForkedFrom, RepoFields, RunFields, RunState, Store, StoredEvent, StoredImage, ThreadFields,
    ThreadUpdate, WakeState, WorktreeFields,
};
use rusqlite::Connection;
use uuid::Uuid;

mod common;
use common::UNDO_56;

fn open() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
    (dir, store)
}

fn repo_fields(path: &str) -> RepoFields {
    RepoFields {
        name: path.rsplit('/').next().unwrap().to_owned(),
        path: path.to_owned(),
        scratch: false,
        project: false,
    }
}

fn run_fields(repo: Uuid) -> RunFields {
    RunFields {
        project_id: repo,
        prompt: "Fix the flaky attach test.".to_owned(),
        requested_account: None,
        policy: "workspaceWrite".to_owned(),
        backend: "claude".to_owned(),
        orchestrator_thread: None,
        parent: None,
        notify_parent: false,
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        approvals: false,
        checkout: false,
        explore: false,
    }
}

fn worktree_fields(id: Uuid) -> WorktreeFields {
    WorktreeFields {
        repo_path: "/Users/me/src/parallax".to_owned(),
        path: format!("/data/worktrees/parallax-1234/{id}"),
        branch: format!("parallax/{}", &id.simple().to_string()[..8]),
        base: "b7e1f2a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9".to_owned(),
        git_dir: format!("/Users/me/src/parallax/.git/worktrees/{id}"),
        base_dirty: false,
    }
}

fn state() -> RunState {
    RunState {
        status: "starting".to_owned(),
        account_id: "claude".to_owned(),
        ..RunState::default()
    }
}

/// A wake-up or another thread's message moves `last_prompt_at` but not `last_user_prompt_at`,
/// which the app's Working clock counts from (PLX-1012).
#[test]
fn only_the_users_turns_move_last_user_prompt_at() {
    let (_dir, mut store) = open();
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let id = Uuid::now_v7();
    let (thread, _, _) = store
        .create_thread_run(
            id,
            repo.id,
            &run_fields(repo.id),
            &state(),
            None,
            &ThreadFields::default(),
        )
        .unwrap();
    assert_eq!(thread.last_user_prompt_at, thread.created_at);

    store.record_turn(id, Uuid::now_v7(), "Fix it").unwrap();
    let prompted = store.get_thread(id).unwrap().unwrap();
    assert!(prompted.last_user_prompt_at > thread.created_at);
    assert_eq!(prompted.last_user_prompt_at, prompted.last_prompt_at);

    store
        .record_turn_from(id, Uuid::now_v7(), "CI failed on your pull request", false)
        .unwrap();
    store
        .record_turn(id, Uuid::now_v7(), "Parallax, not the user: a wake-up")
        .unwrap();
    let woken = store.get_thread(id).unwrap().unwrap();
    assert!(woken.last_prompt_at > prompted.last_prompt_at);
    assert_eq!(woken.last_user_prompt_at, prompted.last_user_prompt_at);
}

#[test]
fn deleting_a_thread_removes_every_row_kept_for_it_and_nothing_else() {
    let (_dir, mut store) = open();
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let [kept, gone] = [Uuid::now_v7(), Uuid::now_v7()];
    for id in [kept, gone] {
        store
            .create_thread_run(
                id,
                repo.id,
                &run_fields(repo.id),
                &state(),
                Some(&worktree_fields(id)),
                &ThreadFields::default(),
            )
            .unwrap();
    }
    for (seq, run) in [(1, kept), (2, gone), (3, gone)] {
        store
            .append_event(&StoredEvent {
                seq,
                time: "2026-09-26T12:00:00Z".parse().unwrap(),
                project_id: Some(repo.id),
                thread_id: Some(run),
                kind: "agent.output".to_owned(),
                payload: "{}".to_owned(),
                command_id: None,
                run_id: None,
            })
            .unwrap();
    }
    // A run's sent turns (#190) and images (PLX-191) have no foreign key to `runs`, so
    // `delete_thread` has to remove them itself: nothing else would.
    let image = Uuid::now_v7();
    for run in [kept, gone] {
        store.record_turn(run, Uuid::now_v7(), "carry on").unwrap();
        let stored = StoredImage {
            media_type: "image/png".to_owned(),
            data: "iVBORw0KGgo=".to_owned(),
        };
        store.add_images(run, &[(image, stored)]).unwrap();
    }
    store.record_attached_seen(gone, &[(kept, 3)]).unwrap();
    store.record_attached_seen(kept, &[(gone, 4)]).unwrap();
    let paused = WakeState {
        in_a_row: 2,
        paused: true,
        woken: None,
    };
    for run in [kept, gone] {
        store.set_wake_state(run, paused).unwrap();
    }

    assert!(store.delete_thread(gone).unwrap());
    assert!(
        !store.delete_thread(gone).unwrap(),
        "deleting again does nothing"
    );
    assert_eq!(store.get_thread(gone).unwrap(), None);
    assert_eq!(store.get_run(gone).unwrap(), None);
    assert_eq!(store.get_worktree(gone).unwrap(), None);
    assert!(store.run_events(gone, 0, 10, 1 << 20).unwrap().0.is_empty());
    assert_eq!(store.run_turns(gone).unwrap(), []);
    assert_eq!(store.image(gone, image).unwrap(), None);
    assert_eq!(store.attached_seen(gone, kept).unwrap(), None);
    assert_eq!(store.attached_seen(kept, gone).unwrap(), None);
    assert_eq!(store.wake_state(gone).unwrap(), WakeState::default());
    let found: Vec<Uuid> = (store.search_threads("flaky", 10).unwrap())
        .iter()
        .map(|thread| thread.id)
        .collect();
    assert_eq!(
        found,
        [kept],
        "a deleted run's text leaves the search index"
    );

    assert!(store.get_thread(kept).unwrap().is_some());
    assert!(store.get_run(kept).unwrap().is_some());
    assert_eq!(store.run_events(kept, 0, 10, 1 << 20).unwrap().0.len(), 1);
    assert_eq!(store.run_turns(kept).unwrap().len(), 1);
    assert!(store.image(kept, image).unwrap().is_some());
    assert!(store.wake_state(kept).unwrap().paused);
}

/// Makes threads with a prompt and logs their `agent.output` events, for the search tests.
struct Threads {
    repo: Uuid,
    seq: u64,
}

impl Threads {
    fn new(store: &mut Store) -> Self {
        let repo = store
            .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
            .unwrap();
        Self {
            repo: repo.id,
            seq: 0,
        }
    }

    fn thread(&self, store: &mut Store, prompt: &str) -> Uuid {
        let id = Uuid::now_v7();
        let fields = RunFields {
            prompt: prompt.to_owned(),
            ..run_fields(self.repo)
        };
        store
            .create_thread_run(
                id,
                self.repo,
                &fields,
                &state(),
                Some(&worktree_fields(id)),
                &ThreadFields::default(),
            )
            .unwrap();
        id
    }

    fn output(&mut self, store: &Store, run: Uuid, items: &str) {
        self.seq += 1;
        let payload = format!(r#"{{"kind":"agent.output","runId":"{run}","items":{items}}}"#);
        store
            .append_event(&StoredEvent {
                seq: self.seq,
                time: "2026-09-26T12:00:00Z".parse().unwrap(),
                project_id: Some(self.repo),
                thread_id: Some(run),
                kind: "agent.output".to_owned(),
                payload,
                command_id: None,
                run_id: None,
            })
            .unwrap();
    }
}

fn found(store: &Store, query: &str, limit: usize) -> Vec<Uuid> {
    store
        .search_threads(query, limit)
        .unwrap()
        .iter()
        .map(|thread| thread.id)
        .collect()
}

fn indexed_rows(path: &std::path::Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM thread_text", [], |row| row.get(0))
        .unwrap()
}

/// Quotes, FTS5 operators, and a NUL in a query are plain text: they never fail a search.
#[test]
fn search_takes_quotes_and_operators_as_text() {
    let (_dir, mut store) = open();
    let threads = Threads::new(&mut store);
    let run = threads.thread(&mut store, "Fix the \"flaky\" attach test (again)");

    for query in [
        "\"flaky\"",
        "flaky\"",
        "(flaky)",
        "-flaky",
        "^flaky",
        "flaky*",
        "'flaky'",
        "flaky !",
        "\"flaky attach\"",
        "flaky\0",
        "\0flaky\0attach",
    ] {
        assert_eq!(found(&store, query, 10), [run], "{query}");
    }
    for query in [
        "\"", "*", "(", "%", "\"\" OR", "AND", "NEAR(x", "text:x", "x NOT", "\0",
    ] {
        assert!(found(&store, query, 10).is_empty(), "{query}");
    }
}

/// Migration 36 indexes a store's existing runs from their prompts, turns, and events. The
/// store is rolled back to before it, and so before migration 39's events columns too.
#[test]
fn the_search_index_is_backfilled_from_existing_events() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("parallax.sqlite3");
    let mut store = Store::open(&path).unwrap();
    let mut threads = Threads::new(&mut store);
    let run = threads.thread(&mut store, "Look into CI");
    threads.output(
        &store,
        run,
        r#"[{"kind":"text","text":"The cache was stale"}]"#,
    );
    store
        .record_turn(run, Uuid::now_v7(), "Now the sidebar")
        .unwrap();
    threads.output(
        &store,
        run,
        r#"[{"kind":"turnStarted","text":"Now the sidebar"},
            {"kind":"toolResult","callId":"1","status":"ok","output":"grep output"}]"#,
    );
    let quiet = threads.thread(&mut store, "Nothing logged yet");
    drop(store);
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "DROP TABLE thread_text_fts; DROP TABLE thread_text;
             DROP TRIGGER thread_text_prompt; DROP TRIGGER thread_text_turn;
             DROP INDEX events_command; ALTER TABLE events DROP COLUMN command_id;
             ALTER TABLE events DROP COLUMN run_id; ALTER TABLE events DROP COLUMN node_id;
             ALTER TABLE events RENAME COLUMN thread_id TO run_id;
             ALTER TABLE events RENAME COLUMN type TO kind;
             DROP TABLE orchestration_receipts; DROP TABLE effects; DROP TABLE projection_meta;
             DELETE FROM schema_version WHERE version IN (36, 39);",
        )
        .unwrap();

    let store = Store::open(&path).unwrap();
    for query in ["CI", "stale", "sidebar"] {
        assert_eq!(found(&store, query, 10), [run], "{query}");
    }
    assert!(found(&store, "grep", 10).is_empty(), "tool output");
    assert_eq!(found(&store, "logged", 10), [quiet], "a run with no events");
    store.index_run_text(run).unwrap();
    assert_eq!(
        indexed_rows(&path),
        4,
        "two prompts, the turn, and the replies, which the backfill covered"
    );
}

/// Two branches each added a migration: a database that has a newer version but is missing an
/// older one, as when #157's migration 8 lands after this one, still gets the older one.
#[test]
fn a_missing_migration_below_the_newest_still_applies() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("parallax.sqlite3");
    drop(Store::open(&path).unwrap());
    let versions = |conn: &Connection| -> Vec<i64> {
        conn.prepare("SELECT version FROM schema_version ORDER BY version")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let conn = Connection::open(&path).unwrap();
    let all = versions(&conn);
    assert!(all.contains(&9), "{all:?}");
    conn.execute_batch("DELETE FROM schema_version WHERE version = 6; DROP TABLE role_defaults;")
        .unwrap();
    drop(conn);

    drop(Store::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(versions(&conn), all);
    let restored: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'role_defaults'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(restored, 1);
}

/// Migration 23 (decision record 0041): a run an orchestrator started gets the orchestrator's
/// thread as its parent, the orchestrator itself (whose thread is its own id) and a client's run
/// get none, and existing threads have no fork origin, no title, and aren't settled.
#[test]
fn migration_23_makes_an_orchestrators_runs_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("parallax.sqlite3");
    let mut store = Store::open(&path).unwrap();
    let project = Uuid::now_v7();
    let [orchestrator, subagent, own] = [Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7()];
    for (id, thread) in [
        (orchestrator, Some(orchestrator)),
        (subagent, Some(orchestrator)),
        (own, None),
    ] {
        let fields = RunFields {
            orchestrator_thread: thread,
            ..run_fields(project)
        };
        store.create_run(id, &fields, &state()).unwrap();
    }
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let thread = Uuid::now_v7();
    store
        .create_thread_run(
            thread,
            repo.id,
            &run_fields(repo.id),
            &state(),
            None,
            &ThreadFields::default(),
        )
        .unwrap();
    drop(store);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!(
        "{UNDO_56}
         ALTER TABLE runs DROP COLUMN parent;
         ALTER TABLE threads DROP COLUMN forked_from_run;
         ALTER TABLE threads DROP COLUMN forked_from_turn;
         ALTER TABLE threads DROP COLUMN title;
         ALTER TABLE threads DROP COLUMN settled;
         DELETE FROM schema_version WHERE version = 23;"
    ))
    .unwrap();
    drop(conn);

    let store = Store::open(&path).unwrap();
    let parent = |id| store.get_run(id).unwrap().unwrap().fields.parent;
    assert_eq!(parent(subagent), Some(orchestrator));
    assert_eq!(parent(orchestrator), None);
    assert_eq!(parent(own), None);
    let thread = store.get_thread(thread).unwrap().unwrap();
    assert_eq!(thread.parent, None);
    assert_eq!(thread.fields, ThreadFields::default());
    assert!(!thread.settled);
}

/// A snippet longer than 120 characters is cut around its match, on character boundaries
/// (PLX-789).
#[test]
fn a_long_snippet_is_cut_around_its_match() {
    let (_dir, mut store) = open();
    let threads = Threads::new(&mut store);
    let prompt = format!("{} flaky {}", "é".repeat(150), "ü".repeat(150));
    let id = threads.thread(&mut store, &prompt);
    let snippets = store.search_snippets("flaky", &[id]).unwrap();
    let [(found, snippet)] = snippets.as_slice() else {
        panic!("one snippet, got {snippets:?}");
    };
    assert_eq!(*found, id);
    assert_eq!(snippet.chars().count(), 120, "{snippet}");
    assert!(
        snippet.starts_with("…é") && snippet.ends_with("ü…"),
        "{snippet}"
    );
    assert!(snippet.contains(" flaky "), "{snippet}");
}

#[test]
fn search_matches_titles_prompts_turns_and_replies_but_not_tool_calls() {
    let (_dir, mut store) = open();
    let mut threads = Threads::new(&mut store);
    let prompted = threads.thread(&mut store, "Fix the flaky attach test.");
    let followed_up = threads.thread(&mut store, "Rename the sidebar");
    store
        .record_turn(followed_up, Uuid::now_v7(), "Also the 50% case")
        .unwrap();
    let replied = threads.thread(&mut store, "Look into CI");
    threads.output(
        &store,
        replied,
        r#"[{"kind":"text","text":"The \"flaky\" attach test passes now"}]"#,
    );
    let tool_only = threads.thread(&mut store, "Read the logs");
    threads.output(
        &store,
        tool_only,
        r#"[{"kind":"toolCall","callId":"1","name":"Bash","input":{"command":"grep flaky"}},
            {"kind":"toolResult","callId":"1","status":"ok","output":"flaky"}]"#,
    );
    let titled = threads.thread(&mut store, "Go");
    let title = ThreadUpdate {
        title: Some(Some("Quarantine the attach test".to_owned())),
        ..ThreadUpdate::default()
    };
    store.update_thread(titled, &title).unwrap();
    assert_eq!(
        found(&store, "flaky", 10),
        [prompted],
        "a prompt is searchable as it's stored, a reply when its turn ends"
    );
    assert_eq!(found(&store, "50%", 10), [followed_up], "a sent turn, too");
    for run in [replied, tool_only] {
        store.index_run_text(run).unwrap();
    }

    assert_eq!(
        found(&store, "FLAKY", 10),
        [replied, prompted],
        "case-insensitive, newest message first, and a tool call's text doesn't count"
    );
    assert_eq!(
        found(&store, "fla", 10),
        [replied, prompted],
        "a word prefix"
    );
    assert_eq!(found(&store, "flaky", 1), [replied], "the limit holds");
    assert_eq!(
        found(&store, "attach test", 10),
        [titled, replied, prompted],
        "a title matches, first"
    );
}

/// Deleting a run clears it from its children's parent and its forks' origin, and touches no
/// other thread.
#[test]
fn deleting_a_parent_leaves_its_children_with_no_parent() {
    let (_dir, mut store) = open();
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let [parent, child, other] = [Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7()];
    let start = |store: &mut Store, id, parent: Option<Uuid>| {
        let fields = RunFields {
            parent,
            ..run_fields(repo.id)
        };
        let lineage = ThreadFields {
            forked_from: parent.map(|run| ForkedFrom {
                run,
                turn: Uuid::now_v7(),
            }),
            title: None,
        };
        store
            .create_thread_run(id, repo.id, &fields, &state(), None, &lineage)
            .unwrap()
            .0
    };
    start(&mut store, parent, None);
    start(&mut store, child, Some(parent));
    let untouched = start(&mut store, other, Some(child));

    assert!(store.delete_thread(parent).unwrap());
    let orphan = store.get_thread(child).unwrap().unwrap();
    assert_eq!(orphan.parent, None);
    assert_eq!(orphan.fields.forked_from, None);
    assert_eq!(store.get_run(child).unwrap().unwrap().fields.parent, None);
    assert_eq!(store.get_thread(other).unwrap(), Some(untouched));
}

#[test]
fn a_project_keeps_its_instructions_and_files_until_cleared() {
    let (_dir, mut store) = open();
    let id = Uuid::now_v7();
    let fields = RepoFields {
        project: true,
        ..repo_fields("/data/projects/essays")
    };
    store.add_repo(id, &fields).unwrap();
    let files = vec![
        "/data/uploads/a/brief.pdf".to_owned(),
        "/data/uploads/b/notes.md".to_owned(),
    ];

    let (repo, changed) = store
        .set_project_context(id, Some("Cite every source."), Some(&files))
        .unwrap();
    assert!(changed);
    assert_eq!(repo.instructions.as_deref(), Some("Cite every source."));
    assert_eq!(repo.files, files);
    // Only what's given changes, and the same values again change nothing.
    let (_, changed) = store.set_project_context(id, None, Some(&files)).unwrap();
    assert!(!changed);
    let reopened = store.get_repo(id).unwrap().unwrap();
    assert_eq!(reopened.instructions.as_deref(), Some("Cite every source."));
    assert_eq!(reopened.files, files);

    let (repo, changed) = store.set_project_context(id, Some(""), Some(&[])).unwrap();
    assert!(changed);
    assert_eq!(repo.instructions, None);
    assert!(repo.files.is_empty());
}

/// An orchestrator's Start over (0093): the new run takes over its thread's orchestration, Project,
/// and pin, and the run it replaced keeps a thread with orchestration off.
#[test]
fn a_new_orchestrator_run_takes_over_its_thread() {
    let (_dir, mut store) = open();
    let orchestrator = Uuid::now_v7();
    let fields = parallax_store::OrchestratorFields {
        name: "formula fly".to_owned(),
        repo_path: None,
        icon: None,
        permission: "auto".to_owned(),
        autonomy: "routine".to_owned(),
        base_branch: None,
    };
    store.create_orchestrator(orchestrator, &fields).unwrap();
    assert_eq!(
        store
            .get_orchestrator(orchestrator)
            .unwrap()
            .unwrap()
            .repo_path,
        None
    );
    let (old, new) = (Uuid::now_v7(), Uuid::now_v7());
    for run in [old, new] {
        let run_fields = RunFields {
            policy: "noWrite".to_owned(),
            orchestrator_thread: Some(run),
            ..run_fields(orchestrator)
        };
        store.create_run(run, &run_fields, &state()).unwrap();
    }
    let project = Uuid::now_v7();
    store.create_orchestrator_thread(old, orchestrator).unwrap();
    store.set_thread_project(old, Some(project)).unwrap();
    store
        .update_thread(
            old,
            &ThreadUpdate {
                pinned: Some(true),
                ..ThreadUpdate::default()
            },
        )
        .unwrap();

    let (thread, before) = store.create_orchestrator_thread(new, orchestrator).unwrap();
    assert_eq!(
        (thread.orchestrator_id, thread.project_id),
        (Some(orchestrator), Some(project))
    );
    let before = before.unwrap();
    assert_eq!(
        (before.orchestrator_id, before.project_id, before.pinned),
        (None, None, false)
    );
    assert_eq!(
        store.orchestrator_thread(orchestrator).unwrap().unwrap().id,
        new
    );
    // Only an orchestrator thread that left the list wakes.
    assert!(store.wake_thread(new, "{}").unwrap().is_none());
    store.set_thread_archived(old, true).unwrap();
    assert!(store.wake_thread(old, "{}").unwrap().is_none());
}
