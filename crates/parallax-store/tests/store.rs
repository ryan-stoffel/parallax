use std::path::PathBuf;
use std::thread;

use parallax_store::{
    AccountFields, ChosenIcon, OrchestratorEdit, OrchestratorFields, Store, StoreError,
    StoredEvent, UsageDelta,
};
use rusqlite::Connection;
use uuid::Uuid;

fn temp_db_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("create temp dir");
    let path = dir.path().join("parallax.sqlite3");
    (dir, path)
}

/// A store in a temporary directory, which lives as long as the `TempDir`.
fn open_temp() -> (tempfile::TempDir, Store) {
    let (dir, path) = temp_db_path();
    (dir, Store::open(&path).expect("open"))
}

fn sample_fields() -> OrchestratorFields {
    OrchestratorFields {
        name: "parallax".to_string(),
        repo_path: Some("/Users/ryan/dev/parallax".to_string()),
        icon: None,
        permission: "auto".to_string(),
        autonomy: "routine".to_string(),
        base_branch: None,
    }
}

fn icon(name: &str, color: Option<&str>) -> ChosenIcon {
    ChosenIcon {
        name: name.to_string(),
        color: color.map(str::to_string),
        image: None,
    }
}

#[test]
fn creating_with_the_same_id_and_different_fields_conflicts() {
    let (_dir, mut store) = open_temp();
    let id = Uuid::now_v7();
    let mut other = sample_fields();
    other.name = "different-name".to_string();

    store
        .create_orchestrator(id, &sample_fields())
        .expect("first create should succeed");
    let err = store
        .create_orchestrator(id, &other)
        .expect_err("repeat create with different fields should fail");

    match err {
        StoreError::IdConflict { id: conflicting } => assert_eq!(conflicting, id),
        other => panic!("expected IdConflict, got {other:?}"),
    }
    assert_eq!(
        store.list_orchestrators().expect("list").len(),
        1,
        "a rejected conflicting create must not change the stored row"
    );
}

#[test]
fn update_renames_and_sets_the_icon_without_touching_the_rest() {
    let (_dir, mut store) = open_temp();
    let id = Uuid::now_v7();
    let created = store
        .create_orchestrator(id, &sample_fields())
        .expect("create should succeed");

    let (renamed, changed) = store
        .update_orchestrator(
            id,
            &OrchestratorEdit {
                name: Some("renamed".to_string()),
                ..OrchestratorEdit::default()
            },
        )
        .expect("a rename");
    assert!(changed);
    assert_eq!(
        renamed,
        parallax_store::Orchestrator {
            name: "renamed".to_string(),
            ..created.clone()
        },
        "only the name changes: not the repository, the icon, or updated_at"
    );

    let (with_icon, changed) = store
        .update_orchestrator(
            id,
            &OrchestratorEdit {
                icon: Some(icon("rocket", Some("green"))),
                ..OrchestratorEdit::default()
            },
        )
        .expect("an icon");
    assert!(changed);
    assert_eq!(with_icon.name, "renamed", "an absent name stays as it is");
    assert_eq!(with_icon.icon, Some(icon("rocket", Some("green"))));
    assert_eq!(with_icon.updated_at, created.updated_at);

    let (recolored, changed) = store
        .update_orchestrator(
            id,
            &OrchestratorEdit {
                icon: Some(icon("rocket", None)),
                ..OrchestratorEdit::default()
            },
        )
        .expect("an icon without a color");
    assert!(changed, "the icon is replaced whole, so its color goes");
    assert_eq!(recolored.icon, Some(icon("rocket", None)));

    assert_eq!(
        store
            .get_orchestrator(id)
            .expect("get")
            .expect("the project"),
        recolored,
        "the update was stored"
    );
}

/// A project's base branch (PLX-409, decision record 0045) is checked on a retry only when
/// given, and recording the integration branch fills in a base only when there was none.
#[test]
fn an_orchestrators_branches_are_stored_and_a_retry_without_a_base_matches() {
    let (_dir, mut store) = open_temp();
    let id = Uuid::now_v7();
    let created = store
        .create_orchestrator(id, &sample_fields())
        .expect("create");
    assert_eq!(
        (created.base_branch, created.integration_branch),
        (None, None)
    );

    assert!(
        store
            .set_integration_branch(id, "parallax/app", "main")
            .expect("record")
    );
    assert!(
        !store
            .set_integration_branch(id, "parallax/app", "other")
            .expect("record again"),
        "nothing changes"
    );
    let project = store
        .get_orchestrator(id)
        .expect("get")
        .expect("the project");
    assert_eq!(project.base_branch.as_deref(), Some("main"));
    assert_eq!(project.integration_branch.as_deref(), Some("parallax/app"));
    store
        .create_orchestrator(id, &sample_fields())
        .expect("a retry with no base matches");
    match store.create_orchestrator(
        id,
        &OrchestratorFields {
            base_branch: Some("develop".to_string()),
            ..sample_fields()
        },
    ) {
        Err(StoreError::IdConflict { id: conflicted }) => assert_eq!(conflicted, id),
        result => panic!("expected IdConflict for another base, got {result:?}"),
    }

    let (updated, changed) = store
        .update_orchestrator(
            id,
            &OrchestratorEdit {
                base_branch: Some("develop".to_string()),
                ..OrchestratorEdit::default()
            },
        )
        .expect("a new base");
    assert!(changed);
    assert_eq!(updated.base_branch.as_deref(), Some("develop"));
    assert_eq!(updated.integration_branch.as_deref(), Some("parallax/app"));
}

/// PLX-411: an orchestrator's proposal never becomes the checks; the user's confirmation does, and
/// clears the proposal. Empty clears either.
#[test]
fn confirming_checks_clears_the_proposal_and_empty_clears_them() {
    let (_dir, mut store) = open_temp();
    let id = Uuid::now_v7();
    store
        .create_orchestrator(id, &sample_fields())
        .expect("create");
    let edit = |checks: Option<&str>, proposed: Option<&str>| OrchestratorEdit {
        checks: checks.map(str::to_owned),
        proposed_checks: proposed.map(str::to_owned),
        ..OrchestratorEdit::default()
    };

    let (proposed, changed) = store
        .update_orchestrator(id, &edit(None, Some("cargo test")))
        .expect("a proposal");
    assert!(changed);
    assert_eq!(proposed.proposed_checks.as_deref(), Some("cargo test"));
    assert_eq!(proposed.checks, None, "a proposal never runs");

    let (confirmed, changed) = store
        .update_orchestrator(id, &edit(Some("cargo test"), None))
        .expect("a confirmation");
    assert!(changed);
    assert_eq!(confirmed.checks.as_deref(), Some("cargo test"));
    assert_eq!(confirmed.proposed_checks, None);
    let (_, changed) = store
        .update_orchestrator(id, &edit(Some("cargo test"), None))
        .expect("the same again");
    assert!(!changed);

    let (cleared, changed) = store
        .update_orchestrator(id, &edit(Some(""), None))
        .expect("cleared");
    assert!(changed);
    assert_eq!(cleared.checks, None);
    assert_eq!(store.get_orchestrator(id).unwrap().unwrap(), cleared);
}

/// Regression test for a migration-runner race: several connections opening
/// the same brand-new database at once must all succeed, and every
/// migration must be applied exactly once even though each connection reads
/// the "current version" before it holds any lock.
#[test]
fn concurrent_open_of_a_fresh_database_applies_migrations_exactly_once() {
    let (_dir, path) = temp_db_path();

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            thread::spawn(move || Store::open(&path))
        })
        .collect();

    let stores: Vec<Store> = handles
        .into_iter()
        .map(|handle| handle.join().expect("opening thread should not panic"))
        .collect::<Result<_, StoreError>>()
        .expect("every concurrent open should succeed");

    for store in &stores {
        assert_eq!(store.list_orchestrators().expect("list"), Vec::new());
    }

    let conn = Connection::open(&path).expect("open verification connection");
    let mut stmt = conn
        .prepare("SELECT version, COUNT(*) AS n FROM schema_version GROUP BY version HAVING n > 1")
        .expect("prepare duplicate check");
    let duplicate_versions: Vec<i64> = stmt
        .query_map([], |row| row.get(0))
        .expect("query duplicates")
        .collect::<Result<_, _>>()
        .expect("collect duplicates");

    assert!(
        duplicate_versions.is_empty(),
        "schema_version has duplicate rows for versions: {duplicate_versions:?}"
    );
}

/// Regression test: a database written by the old `time`-based store (RFC
/// 3339 with a variable-width fraction, or none at all when it was zero)
/// must still open and read correctly. jiff's parser accepts any fraction
/// width.
#[test]
fn reads_timestamps_written_in_the_old_variable_width_format() {
    let (_dir, path) = temp_db_path();
    Store::open(&path).expect("open should create the schema");

    let id = Uuid::now_v7();
    let conn = Connection::open(&path).expect("open raw connection");
    conn.execute(
        &format!(
            "INSERT INTO orchestrators (id, name, repo_path, created_at, updated_at)
             VALUES ('{id}', 'legacy', '/r', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.5Z')"
        ),
        [],
    )
    .expect("insert a row shaped like time's old output");
    drop(conn);

    let store = Store::open(&path).expect("reopen an existing database");
    let project = store
        .get_orchestrator(id)
        .expect("get should parse the legacy timestamps")
        .expect("row should exist");

    assert_eq!(project.created_at, "2026-01-01T00:00:00Z".parse().unwrap());
    assert_eq!(
        project.updated_at,
        "2026-01-01T00:00:00.5Z".parse().unwrap()
    );
    assert_eq!(store.list_orchestrators().expect("list").len(), 1);
}

/// Migration 2 drops the `host` column. A database written at schema
/// version 1, with a row in it, must open, keep the row, and lose the
/// column.
#[test]
fn a_version_1_database_migrates_and_keeps_its_orchestrators() {
    let (_dir, path) = temp_db_path();
    let id = Uuid::now_v7();
    let conn = Connection::open(&path).expect("open raw connection");
    conn.execute_batch(&format!(
        "CREATE TABLE schema_version (
             version INTEGER NOT NULL PRIMARY KEY,
             applied_at TEXT NOT NULL
         );
         CREATE TABLE projects (
             id TEXT NOT NULL PRIMARY KEY,
             name TEXT NOT NULL,
             repo_path TEXT NOT NULL,
             host TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         INSERT INTO schema_version VALUES (1, '2026-09-24T12:00:00.000000000Z');
         INSERT INTO projects VALUES ('{id}', 'parallax', '/r', 'macbook',
             '2026-09-24T12:00:00.000000000Z', '2026-09-24T12:00:00.000000000Z');"
    ))
    .expect("write a version 1 database");
    drop(conn);

    let mut store = Store::open(&path).expect("open should migrate to version 2");
    let project = store
        .get_orchestrator(id)
        .expect("get")
        .expect("the row should survive the migration");
    assert_eq!(project.name, "parallax");
    assert_eq!(project.repo_path.as_deref(), Some("/r"));
    assert_eq!(
        project.icon, None,
        "migration 16 leaves old projects with no icon"
    );
    assert_eq!(
        project.permission, "auto",
        "migration 26 puts old projects in Auto"
    );
    let again = store
        .create_orchestrator(
            id,
            &OrchestratorFields {
                name: "parallax".to_string(),
                repo_path: Some("/r".to_string()),
                // No icon, Auto, and Routine: what migrations 16, 26, and 31 give an old row.
                ..sample_fields()
            },
        )
        .expect("an idempotent create should match the migrated row");
    assert_eq!(again, project);

    let conn = Connection::open(&path).expect("open verification connection");
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('projects')")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert!(
        !columns.iter().any(|column| column == "host"),
        "migration 2 drops it: {columns:?}"
    );
}

/// A database as `develop` (schema version 3, `accounts` but no usage tables) leaves it, opened by
/// a build that also knows migrations 4 (#120), 5 (worktrees, #154), and 6 (role defaults, #119).
/// Both the pre-existing `accounts` row and the new usage tables must be intact afterward.
#[test]
fn a_version_3_database_from_develop_migrates_to_usage_tables_and_keeps_its_account() {
    let (_dir, path) = temp_db_path();
    let account_id = Uuid::now_v7();
    let conn = Connection::open(&path).expect("open raw connection");
    conn.execute_batch(&format!(
        "CREATE TABLE schema_version (
             version INTEGER NOT NULL PRIMARY KEY,
             applied_at TEXT NOT NULL
         );
         CREATE TABLE projects (
             id TEXT NOT NULL PRIMARY KEY,
             name TEXT NOT NULL,
             repo_path TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE accounts (
             id TEXT NOT NULL PRIMARY KEY,
             provider TEXT NOT NULL,
             label TEXT NOT NULL,
             masked_key TEXT NOT NULL,
             created_at TEXT NOT NULL
         );
         INSERT INTO schema_version VALUES
             (1, '2026-09-24T12:00:00.000000000Z'),
             (2, '2026-09-24T12:00:00.000000000Z'),
             (3, '2026-09-24T12:00:00.000000000Z');
         INSERT INTO accounts VALUES ('{account_id}', 'anthropic', 'Personal', 'sk-ant-...abcd',
             '2026-09-24T12:00:00.000000000Z');"
    ))
    .expect("write a version 3 database, as develop's #117 leaves it");
    drop(conn);

    let store = Store::open(&path).expect("open should migrate to the latest version");
    let account = store
        .get_account(account_id)
        .expect("get")
        .expect("the pre-existing account row should survive the migration");
    assert_eq!(account.masked_key, "sk-ant-...abcd");

    // The new usage tables work: a delta records and reads back.
    store
        .record_usage_delta(&UsageDelta {
            run_id: Uuid::now_v7(),
            account_id: account_id.to_string(),
            model: None,
            input_tokens: 5,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd_micros: None,
            at: "2026-09-24T12:00:00Z".parse().unwrap(),
        })
        .expect("record a usage delta after migrating");
    let summary = store
        .usage_summary(
            &account_id.to_string(),
            "2026-01-01T00:00:00Z".parse().unwrap(),
            "2027-01-01T00:00:00Z".parse().unwrap(),
        )
        .expect("summary");
    assert_eq!(summary.input_tokens, 5);
}

/// A key account's row never holds the key itself: only its masked display form.
#[test]
fn account_rows_never_hold_more_than_the_masked_key() {
    let (_dir, path) = temp_db_path();
    let mut store = Store::open(&path).expect("open");
    let id = Uuid::now_v7();
    let secret = "sk-ant-api03-thisisaveryrealsecretabcd";
    store
        .create_account(
            id,
            &AccountFields {
                provider: "anthropic".to_string(),
                label: "Personal".to_string(),
                masked_key: "sk-ant-...abcd".to_string(),
            },
        )
        .expect("create");

    let conn = Connection::open(&path).expect("open raw connection");
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('accounts')")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert_eq!(
        columns,
        ["id", "provider", "label", "masked_key", "created_at"],
        "no column exists for the real key"
    );
    let stored: String = conn
        .query_row(
            "SELECT masked_key FROM accounts WHERE id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .expect("read the stored masked_key");
    assert_ne!(stored, secret, "the real key must never be stored");
}

fn stored_event(seq: u64, run_id: Option<Uuid>) -> StoredEvent {
    StoredEvent {
        seq,
        time: "2026-09-25T12:00:00Z".parse().unwrap(),
        project_id: None,
        thread_id: run_id,
        kind: if run_id.is_some() {
            "agent.output".to_string()
        } else {
            "context.changed".to_string()
        },
        payload: "{}".to_string(),
        command_id: None,
        run_id: None,
    }
}

#[test]
fn pruning_host_events_keeps_the_newest_and_leaves_run_events_alone() {
    let (_dir, store) = open_temp();
    let run = Uuid::now_v7();
    // Interleave host events (no run_id) with run events, so pruning has to pick them out by
    // `run_id IS NULL` rather than by a contiguous range of `seq`.
    for seq in 1..=6 {
        let run_id = if seq % 2 == 0 { Some(run) } else { None };
        store.append_event(&stored_event(seq, run_id)).unwrap();
    }

    let deleted = store.prune_host_events(1).expect("prune");
    assert_eq!(deleted, 2, "keeps only the newest of the 3 host events");

    let remaining = store
        .latest_events(usize::MAX, usize::MAX, |event| event)
        .expect("latest");
    let seqs: Vec<u64> = remaining.iter().map(|event| event.seq).collect();
    assert_eq!(
        seqs,
        [2, 4, 5, 6],
        "the run's events (2, 4, 6) all survive; only the newest host event (5) does"
    );

    let again = store.prune_host_events(1).expect("prune again");
    assert_eq!(again, 0, "already within the retention");
}
