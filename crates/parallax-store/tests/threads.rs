use parallax_store::{
    ForkedFrom, ProjectIcon, RepoFields, RunFields, RunState, Store, StoreError, StoredEvent,
    StoredImage, ThreadFields, ThreadUpdate, WorktreeFields,
};
use rusqlite::Connection;
use uuid::Uuid;

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
    }
}

fn run_fields(repo: Uuid) -> RunFields {
    RunFields {
        project_id: repo,
        prompt: "Fix the flaky attach test.".to_owned(),
        requested_account: None,
        policy: "workspaceWrite".to_owned(),
        backend: "claude".to_owned(),
        coordinator_thread: None,
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

#[test]
fn a_path_has_one_repo_entry_whatever_id_asks_for_it() {
    let (_dir, mut store) = open();
    let first = Uuid::now_v7();
    let repo = store
        .add_repo(first, &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    assert_eq!(repo.id, first);
    assert_eq!(repo.fields.name, "parallax");
    assert!(!repo.fields.scratch);

    let again = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    assert_eq!(
        again, repo,
        "a second id for the same path gets the first entry"
    );
    let retried = store
        .add_repo(first, &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    assert_eq!(retried, repo);

    let conflict = store
        .add_repo(first, &repo_fields("/Users/me/src/other"))
        .unwrap_err();
    assert!(matches!(conflict, StoreError::IdConflict { id } if id == first));

    let other = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/other"))
        .unwrap();
    assert_eq!(store.list_repos().unwrap(), vec![repo.clone(), other]);
    assert_eq!(store.get_repo(first).unwrap(), Some(repo));
    assert_eq!(store.scratch_repo().unwrap(), None);
}

/// A repo entry's icon replaces whole, image included (decision records
/// 0033 and 0038), and reads back from get and list.
#[test]
fn a_repo_icon_with_an_image_round_trips_and_an_icon_without_one_clears_it() {
    let (_dir, mut store) = open();
    let id = Uuid::now_v7();
    store
        .add_repo(id, &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let glyph = ProjectIcon {
        name: "flame".to_owned(),
        color: Some("orange".to_owned()),
        image: None,
    };
    let with_image = ProjectIcon {
        image: Some(StoredImage {
            media_type: "image/webp".to_owned(),
            data: "UklGRg==".to_owned(),
        }),
        ..glyph.clone()
    };

    let (repo, changed) = store.set_repo_icon(id, &with_image).unwrap();
    assert!(changed);
    assert_eq!(repo.icon, Some(with_image.clone()));
    assert_eq!(store.list_repos().unwrap(), [repo]);
    assert!(!store.set_repo_icon(id, &with_image).unwrap().1);

    let (cleared, changed) = store.set_repo_icon(id, &glyph).unwrap();
    assert!(changed);
    assert_eq!(cleared.icon, Some(glyph));
    assert_eq!(store.get_repo(id).unwrap(), Some(cleared));
}

#[test]
fn the_scratch_entry_is_found_by_its_flag() {
    let (_dir, mut store) = open();
    store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let scratch = store
        .add_repo(
            Uuid::now_v7(),
            &RepoFields {
                name: "No Repo".to_owned(),
                path: "/data/scratch".to_owned(),
                scratch: true,
            },
        )
        .unwrap();
    assert_eq!(store.scratch_repo().unwrap(), Some(scratch));
}

#[test]
fn a_thread_is_recorded_with_its_run_and_worktree_and_archives() {
    let (_dir, mut store) = open();
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let id = Uuid::now_v7();
    let (thread, run, worktree) = store
        .create_thread_run(
            id,
            repo.id,
            &run_fields(repo.id),
            &state(),
            Some(&worktree_fields(id)),
            &ThreadFields::default(),
        )
        .unwrap();
    assert_eq!(thread.id, id);
    assert_eq!(thread.repo_id, repo.id);
    assert!(!thread.archived);
    assert_eq!(run.fields.project_id, repo.id);
    assert_eq!(worktree.unwrap().id, id);
    assert_eq!(store.list_runs(Some(repo.id)).unwrap(), vec![run]);

    let duplicate = store
        .create_thread_run(
            id,
            repo.id,
            &run_fields(repo.id),
            &state(),
            Some(&worktree_fields(id)),
            &ThreadFields::default(),
        )
        .unwrap_err();
    assert!(matches!(duplicate, StoreError::IdConflict { .. }));
    assert_eq!(store.list_threads().unwrap(), vec![thread.clone()]);

    let archived = store.set_thread_archived(id, true).unwrap();
    assert!(archived.archived);
    assert_eq!(store.get_thread(id).unwrap(), Some(archived));
    assert!(!store.set_thread_archived(id, false).unwrap().archived);
    let missing = Uuid::now_v7();
    assert!(matches!(
        store.set_thread_archived(missing, true).unwrap_err(),
        StoreError::NotFound { id } if id == missing
    ));
}

#[test]
fn a_thread_in_the_current_checkout_is_recorded_with_no_worktree() {
    let (_dir, mut store) = open();
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let id = Uuid::now_v7();
    let fields = RunFields {
        checkout: true,
        ..run_fields(repo.id)
    };
    let (thread, run, worktree) = store
        .create_thread_run(
            id,
            repo.id,
            &fields,
            &state(),
            None,
            &ThreadFields::default(),
        )
        .unwrap();
    assert_eq!(thread.id, id);
    assert!(run.fields.checkout);
    assert_eq!(worktree, None);
    assert_eq!(store.get_worktree(id).unwrap(), None);
    assert_eq!(store.get_run(id).unwrap(), Some(run));

    assert!(store.delete_thread(id).unwrap());
    assert_eq!(store.get_run(id).unwrap(), None);
}

#[test]
fn deleting_a_thread_removes_its_run_worktree_events_turns_and_images_only() {
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
                run_id: Some(run),
                kind: "agent.output".to_owned(),
                payload: "{}".to_owned(),
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
        store.index_run_text(run).unwrap();
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
                run_id: Some(run),
                kind: "agent.output".to_owned(),
                payload,
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

#[test]
fn search_matches_titles_prompts_turns_and_replies_but_not_tool_calls() {
    let (_dir, mut store) = open();
    let mut threads = Threads::new(&mut store);
    let prompted = threads.thread(&mut store, "Fix the flaky attach test.");
    let followed_up = threads.thread(&mut store, "Rename the sidebar");
    threads.output(
        &store,
        followed_up,
        r#"[{"kind":"turnStarted","text":"Also the 50% case"}]"#,
    );
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
    assert!(
        found(&store, "flaky", 10).is_empty(),
        "a run's text is indexed when its turn ends"
    );
    for run in [prompted, followed_up, replied, tool_only, titled] {
        store.index_run_text(run).unwrap();
    }

    assert_eq!(
        found(&store, "FLAKY", 10),
        [prompted, replied],
        "case-insensitive, the shorter message first, and a tool call's text doesn't count"
    );
    assert_eq!(
        found(&store, "fla", 10),
        [prompted, replied],
        "a word prefix"
    );
    assert_eq!(
        found(&store, "50%", 10),
        [followed_up],
        "a follow-up matches"
    );
    assert_eq!(found(&store, "flaky", 1), [prompted], "the limit holds");
    assert_eq!(
        found(&store, "attach test", 10),
        [titled, prompted, replied],
        "a title matches, first"
    );
}

#[test]
fn search_ranks_by_bm25_then_newest() {
    let (_dir, mut store) = open();
    let threads = Threads::new(&mut store);
    let long = "Look at the flaky test and then rename the sidebar and the menu";
    let often = threads.thread(&mut store, "The flaky test is flaky again, so flaky");
    let once = threads.thread(&mut store, long);
    let same = threads.thread(&mut store, long);
    for run in [often, once, same] {
        store.index_run_text(run).unwrap();
    }
    assert_eq!(found(&store, "flaky", 10), [often, same, once]);
}

/// Quotes and FTS5 operators in a query are plain text: they never fail a search.
#[test]
fn search_takes_quotes_and_operators_as_text() {
    let (_dir, mut store) = open();
    let threads = Threads::new(&mut store);
    let run = threads.thread(&mut store, "Fix the \"flaky\" attach test (again)");
    store.index_run_text(run).unwrap();

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
    ] {
        assert_eq!(found(&store, query, 10), [run], "{query}");
    }
    for query in [
        "\"", "*", "(", "%", "\"\" OR", "AND", "NEAR(x", "text:x", "x NOT",
    ] {
        assert!(found(&store, query, 10).is_empty(), "{query}");
    }
}

/// A turn's text becomes searchable when the turn ends, once however often it's indexed.
#[test]
fn a_new_turn_becomes_searchable_when_it_ends() {
    let (dir, mut store) = open();
    let path = dir.path().join("parallax.sqlite3");
    let mut threads = Threads::new(&mut store);
    let run = threads.thread(&mut store, "Look into CI");
    store.index_run_text(run).unwrap();
    assert_eq!(found(&store, "CI", 10), [run], "the prompt alone");

    threads.output(
        &store,
        run,
        r#"[{"kind":"textDelta","messageId":"m","text":"The ca"}]"#,
    );
    threads.output(
        &store,
        run,
        r#"[{"kind":"text","messageId":"m","text":"The cache was stale"}]"#,
    );
    assert!(found(&store, "stale", 10).is_empty(), "mid-turn");
    store.index_run_text(run).unwrap();
    assert_eq!(found(&store, "stale", 10), [run]);
    store.index_run_text(run).unwrap();
    assert_eq!(
        indexed_rows(&path),
        2,
        "the prompt, then the turn, and nothing again"
    );
}

/// Migration 36 indexes a store's existing runs from their events.
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
             DELETE FROM schema_version WHERE version = 36;",
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
        2,
        "the backfill covers the events it read"
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

/// Migration 23 (decision record 0041): a run a coordinator started gets the coordinator's thread
/// as its parent, the coordinator itself (whose thread is its own id) and a client's run get none,
/// and existing threads have no fork origin, no title, and aren't settled.
#[test]
fn migration_23_makes_a_coordinators_runs_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("parallax.sqlite3");
    let mut store = Store::open(&path).unwrap();
    let project = Uuid::now_v7();
    let [coordinator, subagent, own] = [Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7()];
    for (id, thread) in [
        (coordinator, Some(coordinator)),
        (subagent, Some(coordinator)),
        (own, None),
    ] {
        let fields = RunFields {
            coordinator_thread: thread,
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
    conn.execute_batch(
        "ALTER TABLE runs DROP COLUMN parent;
         ALTER TABLE threads DROP COLUMN forked_from_run;
         ALTER TABLE threads DROP COLUMN forked_from_turn;
         ALTER TABLE threads DROP COLUMN title;
         ALTER TABLE threads DROP COLUMN settled;
         DELETE FROM schema_version WHERE version = 23;",
    )
    .unwrap();
    drop(conn);

    let store = Store::open(&path).unwrap();
    let parent = |id| store.get_run(id).unwrap().unwrap().fields.parent;
    assert_eq!(parent(subagent), Some(coordinator));
    assert_eq!(parent(coordinator), None);
    assert_eq!(parent(own), None);
    let thread = store.get_thread(thread).unwrap().unwrap();
    assert_eq!(thread.parent, None);
    assert_eq!(thread.fields, ThreadFields::default());
    assert!(!thread.settled);
}

#[test]
fn a_thread_keeps_its_lineage_and_updates_its_title_and_settled_flag() {
    let (_dir, mut store) = open();
    let repo = store
        .add_repo(Uuid::now_v7(), &repo_fields("/Users/me/src/parallax"))
        .unwrap();
    let [parent, id] = [Uuid::now_v7(), Uuid::now_v7()];
    store
        .create_run(parent, &run_fields(repo.id), &state())
        .unwrap();
    let lineage = ThreadFields {
        forked_from: Some(ForkedFrom {
            run: parent,
            turn: Uuid::now_v7(),
        }),
        title: Some("Fix attach".to_owned()),
    };
    let fields = RunFields {
        parent: Some(parent),
        ..run_fields(repo.id)
    };
    let (thread, run, _) = store
        .create_thread_run(id, repo.id, &fields, &state(), None, &lineage)
        .unwrap();
    assert_eq!(run.fields.parent, Some(parent));
    assert_eq!(thread.parent, Some(parent));
    assert_eq!(thread.fields, lineage);
    assert!(!thread.settled);

    let rename = ThreadUpdate {
        title: Some(Some("Fix the attach test".to_owned())),
        settled: Some(true),
        ..ThreadUpdate::default()
    };
    let (updated, changed) = store.update_thread(id, &rename).unwrap();
    assert!(changed);
    assert_eq!(updated.fields.title.as_deref(), Some("Fix the attach test"));
    assert!(updated.settled);
    assert_eq!(
        store.list_threads().unwrap(),
        std::slice::from_ref(&updated)
    );
    assert_eq!(store.update_thread(id, &rename).unwrap(), (updated, false));

    let clear = ThreadUpdate {
        title: Some(None),
        settled: Some(false),
        ..ThreadUpdate::default()
    };
    let (cleared, changed) = store.update_thread(id, &clear).unwrap();
    assert!(changed);
    assert_eq!(cleared.fields.title, None);
    assert!(!cleared.settled);
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
