use parallax_store::{
    RunFields, RunState, Store, StoreError, StoredEvent, WakeState, WorktreeFields,
};
use rusqlite::Connection;
use uuid::Uuid;

mod common;
use common::UNDO_56;

fn open() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = Store::open(dir.path().join("parallax.sqlite3")).expect("open");
    (dir, store)
}

fn fields(project_id: Uuid) -> RunFields {
    RunFields {
        project_id,
        prompt: "Add a README".to_owned(),
        requested_account: Some(r#"{"kind":"subscription","backend":"claude"}"#.to_owned()),
        policy: "workspaceWrite".to_owned(),
        backend: "claude".to_owned(),
        orchestrator_thread: None,
        parent: None,
        notify_parent: false,
        model: Some("opus".to_owned()),
        effort: Some("high".to_owned()),
        permission: None,
        context_window: None,
        fast: None,
        approvals: false,
        checkout: false,
        explore: false,
    }
}

fn starting() -> RunState {
    RunState {
        status: "starting".to_owned(),
        account_id: "claude".to_owned(),
        ..RunState::default()
    }
}

fn event(seq: u64, run_id: Option<Uuid>) -> StoredEvent {
    StoredEvent {
        seq,
        time: "2026-09-25T12:00:00.25Z".parse().unwrap(),
        project_id: Some(Uuid::now_v7()),
        thread_id: run_id,
        kind: "agent.output".to_owned(),
        payload: format!(r#"{{"kind":"agent.output","n":{seq}}}"#),
        command_id: None,
        run_id: None,
    }
}

#[test]
fn a_page_of_run_events_stops_at_its_byte_budget_but_never_comes_back_empty() {
    let (_dir, store) = open();
    let run = Uuid::now_v7();
    for seq in 1..=10 {
        let mut big = event(seq, Some(run));
        big.payload = "x".repeat(1000);
        store.append_event(&big).unwrap();
    }
    let (first, more) = store.run_events(run, 0, 500, 2500).unwrap();
    assert_eq!(first.len(), 2, "a third would pass 2500 bytes");
    assert!(more);
    let (tiny, more) = store.run_events(run, 0, 500, 10).unwrap();
    assert_eq!(
        tiny.len(),
        1,
        "one event even when it alone is over the budget"
    );
    assert!(more);

    let mut after = 0;
    let mut seen = Vec::new();
    loop {
        let (events, more) = store.run_events(run, after, 500, 2500).unwrap();
        after = events.last().unwrap().seq;
        seen.extend(events.iter().map(|e| e.seq));
        if !more {
            break;
        }
    }
    assert_eq!(seen, (1..=10).collect::<Vec<_>>());

    // Newest first, it pages the same way (PLX-490).
    let (newest, more) = store.run_events_before(run, u64::MAX, 500, 2500).unwrap();
    assert_eq!(newest.iter().map(|e| e.seq).collect::<Vec<_>>(), [10, 9]);
    assert!(more);
    let (oldest, more) = store.run_events_before(run, 2, 500, 10).unwrap();
    assert_eq!(oldest.iter().map(|e| e.seq).collect::<Vec<_>>(), [1]);
    assert!(!more);
}

#[test]
fn a_before_page_inside_a_compacted_turn_carries_the_rewritten_row() {
    let (_dir, store) = open();
    let run = Uuid::now_v7();
    store.append_event(&event(1, Some(run))).unwrap();
    store.append_event(&event(2, Some(run))).unwrap();
    let mut compacted = event(5, Some(run));
    compacted.payload =
        format!(r#"{{"kind":"agent.output","runId":"{run}","items":[],"compacted":{{"from":3}}}}"#);
    store.append_event(&compacted).unwrap();
    store.append_event(&event(6, Some(run))).unwrap();

    let (page, more) = store.run_events_before(run, 4, 500, 10_000).unwrap();
    let seqs: Vec<u64> = page.iter().map(|e| e.seq).collect();
    assert_eq!(
        seqs,
        [5, 2, 1],
        "the compacted row leads a newest-first page"
    );
    assert!(!more);
}

fn worktree_fields() -> WorktreeFields {
    WorktreeFields {
        repo_path: "/src/app".to_owned(),
        path: "/data/worktrees/app/run".to_owned(),
        branch: "parallax/abcd1234".to_owned(),
        base: "abc".to_owned(),
        git_dir: "/src/app/.git/worktrees/run".to_owned(),
        base_dirty: false,
    }
}

#[test]
fn a_run_and_its_worktree_are_created_together_or_not_at_all() {
    let (dir, mut store) = open();
    let id = Uuid::now_v7();
    let (run, worktree) = store
        .create_run_with_worktree(id, &fields(Uuid::now_v7()), &starting(), &worktree_fields())
        .unwrap();
    assert_eq!(store.get_run(id).unwrap(), Some(run));
    assert_eq!(store.get_worktree(id).unwrap(), Some(worktree));

    // A worktree row already there makes the run's insert roll back with it.
    let taken = Uuid::now_v7();
    Connection::open(dir.path().join("parallax.sqlite3"))
        .unwrap()
        .execute(
            "INSERT INTO worktrees (id, repo_path, path, branch, base, created_at)
             VALUES (?1, '', '', '', '', '2026-01-01T00:00:00Z')",
            [taken.to_string()],
        )
        .unwrap();
    assert!(matches!(
        store.create_run_with_worktree(
            taken,
            &fields(Uuid::now_v7()),
            &starting(),
            &worktree_fields()
        ),
        Err(StoreError::IdConflict { .. })
    ));
    assert_eq!(store.get_run(taken).unwrap(), None);

    // A run row already there leaves no new worktree row behind.
    let run_only = Uuid::now_v7();
    store
        .create_run(run_only, &fields(Uuid::now_v7()), &starting())
        .unwrap();
    assert!(
        store
            .create_run_with_worktree(
                run_only,
                &fields(Uuid::now_v7()),
                &starting(),
                &worktree_fields()
            )
            .is_err()
    );
    assert_eq!(store.get_worktree(run_only).unwrap(), None);
}

#[test]
fn a_version_6_database_gains_runs_events_and_worktree_git_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("parallax.sqlite3");
    let id = Uuid::now_v7();
    {
        let mut store = Store::open(&path).unwrap();
        store
            .create_run_with_worktree(id, &fields(Uuid::now_v7()), &starting(), &worktree_fields())
            .unwrap();
    }
    // Roll the database back to what #119 left on develop: schema 6, no runs, events, git_dir or
    // base_dirty columns, turns table (#190's migration 10; dropping `runs` already undoes #157's
    // migration 8 columns on it, since they're columns of the table this drops wholesale), the
    // normal threads tables (#110's migration 9), the wakes table (PLX-178's migration 14), the
    // images table (PLX-191's migration 15), the project icon columns (PLX-227's migration 16),
    // the host settings table (PLX-371's migration 24), the inbox table (PLX-401's migration 25),
    // the project permission column (PLX-394's migration 26), the queued table (PLX-370's
    // migration 27), the project branch columns (PLX-409's migration 29), the questions
    // table (PLX-402's migration 30), the project autonomy column (PLX-403's migration 31), the
    // landings table and auto-land column (PLX-410's migration 33), the placement columns and
    // table (PLX-413's migration 34), the checks columns (PLX-411's migration 35), the search
    // index (PLX-487's migration 36), the attached-thread cursors (PLX-486's migration 37), the
    // dispatcher's tables (PLX-643's migration 39), delegation's (PLX-648's migrations 42
    // and 43), the project computer
    // column (PLX-909's migration 48), the board items table (PLX-940's migration 49), the
    // orchestrator sessions table (PLX-937's migration 51), the You entries table (PLX-946's
    // migration 52), or the pull request guides table (PLX-1188's migration 58).
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE orchestrators RENAME TO projects;
             DROP TABLE you_entries; DROP TABLE orchestrator_sessions; DROP TABLE board_items;
             DROP TABLE runs; DROP TABLE log_meta; DROP TABLE events; DROP TABLE turns;
             DROP TABLE threads; DROP TABLE repos; DROP TABLE wakes; DROP TABLE images;
             DROP TABLE host_settings; DROP TABLE inbox; DROP TABLE queued; DROP TABLE questions;
             DROP TABLE landings;
             DROP TABLE placements;
             DROP TABLE thread_text_fts; DROP TABLE thread_text;
             DROP TABLE command_receipts;
             DROP TABLE attached_seen;
             DROP TABLE orchestration_receipts; DROP TABLE effects; DROP TABLE projection_meta;
             DROP TABLE scheduled_tasks; DROP TABLE pr_watches; DROP TABLE pr_guides;
             DROP TABLE thread_runs; DROP TABLE run_attempts; DROP TABLE nodes;
             DROP TABLE runtime_requests; DROP TABLE graph_imports;
             DROP TABLE thread_lineage; DROP TABLE context_transfers; DROP TABLE secret_refs;
             ALTER TABLE worktrees DROP COLUMN git_dir;
             ALTER TABLE worktrees DROP COLUMN base_dirty;
             ALTER TABLE projects DROP COLUMN icon_name;
             ALTER TABLE projects DROP COLUMN icon_color;
             ALTER TABLE projects DROP COLUMN icon_image_type;
             ALTER TABLE projects DROP COLUMN icon_image_data;
             ALTER TABLE projects DROP COLUMN permission;
             ALTER TABLE projects DROP COLUMN base_branch;
             ALTER TABLE projects DROP COLUMN integration_branch;
             ALTER TABLE projects DROP COLUMN autonomy;
             ALTER TABLE projects DROP COLUMN auto_land;
             ALTER TABLE projects DROP COLUMN max_children;
             ALTER TABLE projects DROP COLUMN allow_api_keys;
             ALTER TABLE projects DROP COLUMN checks;
             ALTER TABLE projects DROP COLUMN proposed_checks;
             ALTER TABLE projects DROP COLUMN computer;
             DELETE FROM schema_version WHERE version >= 7;",
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let worktree = store.get_worktree(id).unwrap().unwrap();
    assert_eq!(worktree.git_dir, "", "an older row has no pinned git dir");
    assert!(!worktree.base_dirty, "an older row is never flagged dirty");
    let run = store
        .create_run(Uuid::now_v7(), &fields(Uuid::now_v7()), &starting())
        .unwrap();
    assert_eq!(store.list_runs(None).unwrap(), [run]);
    store.append_event(&event(1, None)).unwrap();
    assert_eq!(store.event_head().unwrap(), 1);
}

#[test]
fn deleting_a_long_turn_does_not_exceed_sqlite_variable_limit() {
    let (_dir, store) = open();
    let run = Uuid::now_v7();
    store.begin().unwrap();
    for seq in 1..=33_000 {
        store.append_event(&event(seq, Some(run))).unwrap();
    }
    store.commit().unwrap();
    let seqs: Vec<u64> = (1..33_000).collect();
    assert_eq!(store.delete_events(&seqs).unwrap(), seqs.len());
    let (rows, more) = store.run_events(run, 0, 100, usize::MAX).unwrap();
    assert!(!more);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].seq, 33_000);
}

/// PLX-936: migration 50 starts each existing orchestrator's delivered-end cursor where plxd's old
/// one was, its newest turn or else its creation, and leaves other runs without one.
#[test]
fn a_version_49_database_starts_each_orchestrators_cursor_at_its_newest_turn() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().join("parallax.sqlite3");
    let store = Store::open(&path).expect("open");
    let project = Uuid::now_v7();
    let orchestrator = |prompt: &str| RunFields {
        policy: "noWrite".to_owned(),
        prompt: prompt.to_owned(),
        ..fields(project)
    };
    let (talked, quiet, worker) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    store
        .create_run(talked, &orchestrator("Plan."), &starting())
        .unwrap();
    store
        .create_run(quiet, &orchestrator("Start over."), &starting())
        .unwrap();
    store
        .create_run(worker, &fields(project), &starting())
        .unwrap();
    store.record_turn(talked, Uuid::now_v7(), "Go on.").unwrap();
    drop(store);
    let conn = Connection::open(&path).expect("open raw connection");
    conn.execute_batch(
        "ALTER TABLE wakes DROP COLUMN woken_at;
         DELETE FROM schema_version WHERE version = 50;",
    )
    .expect("roll the database back to version 49");
    drop(conn);

    let store = Store::open(&path).expect("open should apply migration 50");
    let turned = store.last_turn_at(talked).unwrap();
    assert!(turned.is_some());
    assert_eq!(store.wake_state(talked).unwrap().woken, turned);
    let made = store.get_run(quiet).unwrap().unwrap().created_at;
    assert_eq!(store.wake_state(quiet).unwrap().woken, Some(made));
    assert_eq!(store.wake_state(worker).unwrap(), WakeState::default());
}

/// PLX-937: an orchestrator's new session ends its open epoch as not resumable, the same one
/// changes nothing, and an epoch ended first is not ended again.
#[test]
fn a_new_session_ends_the_open_epoch_and_the_same_one_changes_nothing() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = Store::open(dir.path().join("parallax.sqlite3")).expect("open");
    let run = Uuid::now_v7();
    let orchestrator = RunFields {
        policy: "noWrite".to_owned(),
        ..fields(Uuid::now_v7())
    };
    store.create_run(run, &orchestrator, &starting()).unwrap();

    assert_eq!(
        store.begin_orchestrator_session(run, "a").unwrap(),
        Some((1, false))
    );
    assert_eq!(store.begin_orchestrator_session(run, "a").unwrap(), None);
    assert_eq!(
        store.begin_orchestrator_session(run, "b").unwrap(),
        Some((2, true))
    );
    assert_eq!(
        store.end_orchestrator_session(run, "user-fresh").unwrap(),
        Some(3)
    );
    assert_eq!(
        store.end_orchestrator_session(run, "user-fresh").unwrap(),
        None
    );
    assert_eq!(
        store.begin_orchestrator_session(run, "c").unwrap(),
        Some((3, false))
    );
    assert_eq!(
        store.orchestrator_sessions(run).unwrap(),
        [
            ("a".to_owned(), Some("not-resumable".to_owned())),
            ("b".to_owned(), Some("user-fresh".to_owned())),
            ("c".to_owned(), None),
        ]
    );
}

/// PLX-937: migration 51 makes each orchestrator with a session its epoch 1, open, and gives a
/// worker or an orchestrator without a session none.
#[test]
fn a_version_50_database_makes_each_orchestrators_session_its_first_epoch() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().join("parallax.sqlite3");
    let store = Store::open(&path).expect("open");
    let project = Uuid::now_v7();
    let orchestrator = RunFields {
        policy: "noWrite".to_owned(),
        ..fields(project)
    };
    let (talked, quiet, worker) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let with_session = RunState {
        session_id: Some("session-1".to_owned()),
        ..starting()
    };
    store
        .create_run(talked, &orchestrator, &with_session)
        .unwrap();
    store.create_run(quiet, &orchestrator, &starting()).unwrap();
    store
        .create_run(worker, &fields(project), &with_session)
        .unwrap();
    drop(store);
    let conn = Connection::open(&path).expect("open raw connection");
    conn.execute_batch(&format!(
        "{UNDO_56}
             DROP TABLE coordinator_sessions;
             ALTER TABLE turns DROP COLUMN from_user;
             DELETE FROM schema_version WHERE version = 51;"
    ))
    .expect("roll the database back to version 50");
    drop(conn);

    let store = Store::open(&path).expect("open should apply migration 51");
    assert_eq!(
        store.orchestrator_sessions(talked).unwrap(),
        [("session-1".to_owned(), None)]
    );
    assert!(store.orchestrator_sessions(quiet).unwrap().is_empty());
    assert!(store.orchestrator_sessions(worker).unwrap().is_empty());
}

/// PLX-937: an orchestrator's last user turns, oldest first, leave out another thread's messages
/// and plxd's own, including a wake-up recorded before turns said who wrote them.
#[test]
fn user_turns_are_the_users_own_newest_last() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = Store::open(dir.path().join("parallax.sqlite3")).expect("open");
    let run = Uuid::now_v7();
    let turn = |text: &str, from_user: bool| {
        store
            .record_turn_from(run, Uuid::now_v7(), text, from_user)
            .unwrap();
    };
    turn("First.", true);
    turn("From another thread.", false);
    turn("Parallax, not the user: an old wake-up.", true);
    turn("Second.", true);
    turn("Third.", true);

    assert_eq!(
        store.user_turns(run, 10).unwrap(),
        ["First.", "Second.", "Third."]
    );
    assert_eq!(store.user_turns(run, 2).unwrap(), ["Second.", "Third."]);
}

#[test]
fn provider_history_survives_switches_repeats_and_reopening() {
    let (dir, store) = open();
    let id = Uuid::now_v7();
    let mut options = fields(Uuid::now_v7());
    assert_eq!(
        store
            .create_run(id, &options, &starting())
            .unwrap()
            .backends,
        ["claude"]
    );
    options.backend = "codex".into();
    assert_eq!(
        store.set_run_options(id, &options).unwrap().backends,
        ["claude", "codex"]
    );
    options.backend = "claude".into();
    store.set_run_options(id, &options).unwrap();
    drop(store);
    let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
    assert_eq!(
        store.get_run(id).unwrap().unwrap().backends,
        ["claude", "codex"]
    );
    assert_eq!(
        store.list_runs_with_worktrees(None).unwrap()[0].0.backends,
        ["claude", "codex"]
    );
}

#[test]
fn provider_history_upgrade_recovers_historical_switches_and_current_backend() {
    let (dir, store) = open();
    let id = Uuid::now_v7();
    let plain = Uuid::now_v7();
    store
        .create_run(id, &fields(Uuid::now_v7()), &starting())
        .unwrap();
    store
        .create_run(plain, &fields(Uuid::now_v7()), &starting())
        .unwrap();
    for (seq, payload) in [
        format!(r#"{{"kind":"agent.started","runId":"{id}","run":{{"backend":"cursor"}}}}"#),
        format!(r#"{{"kind":"agent.updated","runId":"{id}","state":{{"backend":"codex"}}}}"#),
        format!(r#"{{"kind":"agent.updated","runId":"{id}","state":{{"backend":"cursor"}}}}"#),
    ]
    .into_iter()
    .enumerate()
    {
        let mut e = event(seq as u64 + 1, Some(id));
        e.kind = if seq == 0 {
            "agent.started"
        } else {
            "agent.updated"
        }
        .into();
        e.payload = payload;
        store.append_event(&e).unwrap();
    }
    drop(store);
    let path = dir.path().join("parallax.sqlite3");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "ALTER TABLE runs DROP COLUMN backends; DELETE FROM schema_version WHERE version = 59;",
    )
    .unwrap();
    drop(conn);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.get_run(id).unwrap().unwrap().backends,
        ["cursor", "codex", "claude"]
    );
    assert_eq!(store.get_run(plain).unwrap().unwrap().backends, ["claude"]);
}
