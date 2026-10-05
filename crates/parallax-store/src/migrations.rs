use std::collections::BTreeSet;

use rusqlite::{Connection, TransactionBehavior, params};

use crate::error::StoreError;
use crate::timestamp;

struct Migration {
    version: i64,
    sql: &'static str,
}

/// Versioned migrations, applied in order. Add new tables here by appending
/// a migration; never edit one that has already shipped.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: "CREATE TABLE projects (
            id TEXT NOT NULL PRIMARY KEY,
            name TEXT NOT NULL,
            repo_path TEXT NOT NULL,
            host TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    },
    // A plxd's store only holds projects on its own host, so the column
    // had nothing to say (decision record 0009).
    Migration {
        version: 2,
        sql: "ALTER TABLE projects DROP COLUMN host;",
    },
    // A key account's record: metadata only. The API key itself lives in the Keychain and never
    // reaches this database (#117); `masked_key` is the display form, such as `sk-ant-...abcd`.
    Migration {
        version: 3,
        sql: "CREATE TABLE accounts (
            id TEXT NOT NULL PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT NOT NULL,
            masked_key TEXT NOT NULL,
            created_at TEXT NOT NULL
        );",
    },
    // Per-account usage (#120): append-only token/cost deltas, one replaced snapshot per account
    // limit window, and one replaced running total per session and model, so a resumed session
    // can pass its baseline (#113's `Resume::usage_totals`). `model` uses `''`, not `NULL`, as the
    // "no model reported" sentinel: SQLite treats two `NULL`s as distinct, which would stop
    // `session_usage_totals` from replacing an existing row for the unnamed model.
    Migration {
        version: 4,
        sql: "CREATE TABLE usage_deltas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            cost_usd_micros INTEGER,
            at TEXT NOT NULL
        );
        CREATE INDEX usage_deltas_account_at ON usage_deltas (account_id, at);

        CREATE TABLE limit_snapshots (
            account_id TEXT NOT NULL,
            window TEXT NOT NULL,
            used_percent REAL,
            resets_at TEXT,
            captured_at TEXT NOT NULL,
            PRIMARY KEY (account_id, window)
        );

        CREATE TABLE session_usage_totals (
            session_id TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            cost_usd_micros INTEGER,
            PRIMARY KEY (session_id, model)
        );",
    },
    // A run's worktree (#154): one row per run, keyed by the run id, so startup garbage
    // collection can tell a worktree the store still knows about from an orphan left behind by
    // a crash. `base` is the concrete commit the worktree was created from, resolved once at
    // creation time so a later diff or commit is never against a base that moved.
    Migration {
        version: 5,
        sql: "CREATE TABLE worktrees (
            id TEXT NOT NULL PRIMARY KEY,
            repo_path TEXT NOT NULL,
            path TEXT NOT NULL,
            branch TEXT NOT NULL,
            base TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX worktrees_repo_path ON worktrees (repo_path);",
    },
    // Per-host role defaults for account routing (#119): the account a task's role falls back to
    // when it doesn't name one outright. `account_kind` is 'subscription' or 'key'; exactly one of
    // `backend` (a backend's name, such as 'claude') and `key_account_id` (a row in `accounts`,
    // though not enforced by a foreign key, since a key account can be removed after being set as
    // a default) is set, matching `account_kind`.
    Migration {
        version: 6,
        sql: "CREATE TABLE role_defaults (
            role TEXT NOT NULL PRIMARY KEY,
            account_kind TEXT NOT NULL,
            backend TEXT,
            key_account_id TEXT,
            updated_at TEXT NOT NULL
        );",
    },
    // Agent runs and the persisted event log (#156, decision 0014).
    //
    // - `worktrees.git_dir`: the linked worktree's private git directory, resolved once at
    //   creation (#166), so a restart never has to trust the worktree's own `.git` file again.
    // - `runs`: one row per `agent/start`, keyed by its client-generated run id. The params that
    //   make a retry idempotent (`project_id`, `prompt`, `requested_account`, `policy`) never
    //   change; the rest is the run's latest state. `requested_account` is the JSON of the
    //   account the request named, or NULL for the worker role's default.
    // - `log_meta` and `events`: 0007's event log, numbered by the daemon-wide `seq`, so the
    //   editor can replay after a reconnect or a restart. `payload` is the event's JSON;
    //   `run_id` is set for an agent run's events, for `agent/events`.
    Migration {
        version: 7,
        sql: "ALTER TABLE worktrees ADD COLUMN git_dir TEXT NOT NULL DEFAULT '';

        CREATE TABLE runs (
            id TEXT NOT NULL PRIMARY KEY,
            project_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            requested_account TEXT,
            policy TEXT NOT NULL,
            backend TEXT NOT NULL,
            account_id TEXT NOT NULL,
            status TEXT NOT NULL,
            session_id TEXT,
            error TEXT,
            commit_sha TEXT,
            files_changed INTEGER,
            insertions INTEGER,
            deletions INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX runs_project ON runs (project_id, created_at);

        CREATE TABLE log_meta (
            id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
            log_id TEXT NOT NULL
        );

        CREATE TABLE events (
            seq INTEGER NOT NULL PRIMARY KEY,
            time TEXT NOT NULL,
            project_id TEXT,
            run_id TEXT,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE INDEX events_run ON events (run_id, seq);",
    },
    // Accepting a run (#157): `agent/accept`'s client-generated id, for its idempotency, and what
    // the merge did to the project's repository (`merge_how` is `fastForward`, `merge`, or
    // `upToDate`). All NULL until the run is accepted.
    Migration {
        version: 8,
        sql: "ALTER TABLE runs ADD COLUMN accept_id TEXT;
        ALTER TABLE runs ADD COLUMN merge_commit TEXT;
        ALTER TABLE runs ADD COLUMN merge_into TEXT;
        ALTER TABLE runs ADD COLUMN merge_how TEXT;",
    },
    // Normal threads (#110, decision 0017).
    //
    // - `repos`: lightweight repo entries that normal threads run in, one per canonical path.
    //   `scratch` marks plxd's own entry for threads with no repo.
    // - `threads`: one row per normal thread, keyed by its run's id. The run's `project_id`
    //   holds the same `repo_id`, so its events and `agent/list` use the repo entry's id.
    Migration {
        version: 9,
        sql: "CREATE TABLE repos (
            id TEXT NOT NULL PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            scratch INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE threads (
            id TEXT NOT NULL PRIMARY KEY,
            repo_id TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX threads_repo ON threads (repo_id, created_at);",
    },
    // Turn idempotency across a restart (#190): `Actor::turns` kept sent turns only in memory, so
    // a plxd restart lost `agent/send`'s idempotency (0014) for a run's `turnId`s, and a retried
    // `agent/send` could resume a session twice with the same message. No foreign key to `runs`,
    // matching this database's existing style (`role_defaults`, `events`), and no retention of its
    // own yet: a row is small (an id and the sent text) and nothing prunes a finished run's rows
    // at all today (0016, #207), so this waits on the same removal feature `events` does rather
    // than growing its own ad hoc rule (#190 review non-blocking note). `Store::delete_thread`
    // (#110) also deletes a deleted thread's `turns` rows, since this table has no cascade.
    Migration {
        version: 10,
        sql: "CREATE TABLE turns (
            run_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, turn_id)
        );",
    },
    // The coordinator thread that started a run through its Parallax tools (#195, decision 0019), or
    // NULL for a run a client started itself. Part of `agent/start`'s idempotent params.
    Migration {
        version: 11,
        sql: "ALTER TABLE runs ADD COLUMN coordinator_thread TEXT;",
    },
    // Whether a worktree's base was resolved from a dirty `HEAD` (#257): its repository's tracked
    // files had uncommitted changes not included in the worktree. A caller shows the user a
    // notice; it never blocks creating the worktree. Always 0 for an explicit base, and for a row
    // written before this column existed.
    Migration {
        version: 12,
        sql: "ALTER TABLE worktrees ADD COLUMN base_dirty INTEGER NOT NULL DEFAULT 0;",
    },
    // The model, effort, and permission a run asked for (PLX-97), each NULL for the CLI's
    // default. Part of `agent/start`'s idempotent params, and passed again when a run resumes.
    Migration {
        version: 13,
        sql: "ALTER TABLE runs ADD COLUMN model TEXT;
        ALTER TABLE runs ADD COLUMN effort TEXT;
        ALTER TABLE runs ADD COLUMN permission TEXT;",
    },
    // A coordinator's wake-up count and pause (PLX-178, decision 0025), so a restart neither
    // resets the cap nor lifts a pause. No row means none in a row and not paused. No foreign
    // key, like `turns`.
    Migration {
        version: 14,
        sql: "CREATE TABLE wakes (
            run_id TEXT NOT NULL PRIMARY KEY,
            in_a_row INTEGER NOT NULL,
            paused INTEGER NOT NULL
        );",
    },
    // Images sent with a run's messages (PLX-191, decision 0026), which `turnStarted` names by id
    // and `agent/image` serves: kept out of `events`, since one can be megabytes. `data` is the
    // base64 the client sent. No foreign key, like `turns`, so `Store::delete_thread` deletes a
    // thread's rows, and they wait on #207 otherwise, as its events do.
    Migration {
        version: 15,
        sql: "CREATE TABLE images (
            run_id TEXT NOT NULL,
            id TEXT NOT NULL,
            media_type TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, id)
        );",
    },
    // A project's icon (PLX-227, decision 0032), as the client sent it: a Lucide icon's name and
    // an optional palette key. A NULL `icon_name` means no icon, so existing projects have none.
    Migration {
        version: 16,
        sql: "ALTER TABLE projects ADD COLUMN icon_name TEXT;
        ALTER TABLE projects ADD COLUMN icon_color TEXT;",
    },
    // Whether a run forwards its CLI's permission requests to the client (PLX-222, decision
    // 0031), which only a client that answers them asks for. 0 for every run before, which keeps
    // denying what would prompt. Part of the start methods' idempotent params, and passed again
    // when a run resumes.
    Migration {
        version: 17,
        sql: "ALTER TABLE runs ADD COLUMN approvals INTEGER NOT NULL DEFAULT 0;",
    },
    // Whether a thread runs in its repository's own checkout instead of a worktree of its own,
    // as the Workspace menu's "Current checkout" asks. 0 for every run before, which all got a
    // worktree.
    Migration {
        version: 18,
        sql: "ALTER TABLE runs ADD COLUMN checkout INTEGER NOT NULL DEFAULT 0;",
    },
    // What the sidebar needs to show which threads need the user (PLX-270, decision 0033): when
    // the user last saw each thread, until when it is snoozed, and each repo entry's icon in
    // 0032's shape. Existing threads count as seen now, so an upgrade doesn't mark every old
    // thread as new.
    Migration {
        version: 19,
        sql: "ALTER TABLE threads ADD COLUMN seen_at TEXT;
        ALTER TABLE threads ADD COLUMN snoozed_until TEXT;
        UPDATE threads SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
        ALTER TABLE repos ADD COLUMN icon_name TEXT;
        ALTER TABLE repos ADD COLUMN icon_color TEXT;",
    },
    // A run's context window in tokens and whether it runs in fast mode, each NULL for the CLI's
    // default. Kept and passed again, as `model` is.
    Migration {
        version: 20,
        sql: "ALTER TABLE runs ADD COLUMN context_window INTEGER;
        ALTER TABLE runs ADD COLUMN fast INTEGER;",
    },
    // The web URLs of the pull requests linked to a run (PLX-318), oldest first, one per line.
    // Empty for every run before, which had none linked.
    Migration {
        version: 21,
        sql: "ALTER TABLE runs ADD COLUMN pull_requests TEXT NOT NULL DEFAULT '';",
    },
    // An uploaded image as a project's or repo entry's icon (PLX-339, decision 0038): its media
    // type and base64 data, as the client sent them. A NULL type means no image, so existing
    // icons keep their glyph.
    Migration {
        version: 22,
        sql: "ALTER TABLE projects ADD COLUMN icon_image_type TEXT;
        ALTER TABLE projects ADD COLUMN icon_image_data TEXT;
        ALTER TABLE repos ADD COLUMN icon_image_type TEXT;
        ALTER TABLE repos ADD COLUMN icon_image_data TEXT;",
    },
    // Thread lineage (PLX-369, decision 0041). `runs.parent` is the run that launched a run, on
    // `runs` because a coordinator's subagents have no thread row: existing runs a coordinator
    // started get its thread as their parent, except the coordinator itself, which carries its
    // own id (0024). A thread's fork origin (a run and a turn), title, and settled flag go on
    // `threads`. No foreign keys, like the rest: deleting a run clears these on its children.
    Migration {
        version: 23,
        sql: "ALTER TABLE runs ADD COLUMN parent TEXT;
        UPDATE runs SET parent = coordinator_thread
            WHERE coordinator_thread IS NOT NULL AND coordinator_thread != id;
        ALTER TABLE threads ADD COLUMN forked_from_run TEXT;
        ALTER TABLE threads ADD COLUMN forked_from_turn TEXT;
        ALTER TABLE threads ADD COLUMN title TEXT;
        ALTER TABLE threads ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;",
    },
    // Auto-resume after a usage limit (PLX-371, decision 0049): a run's override (NULL for the
    // host's setting), when its stored timer fires (NULL when it doesn't wait), and how many
    // resumes in a row found no reset time, for the backoff. `host_settings` holds the host's
    // settings by key; no row means the default.
    Migration {
        version: 24,
        sql: "ALTER TABLE runs ADD COLUMN auto_resume INTEGER;
        ALTER TABLE runs ADD COLUMN resume_at TEXT;
        ALTER TABLE runs ADD COLUMN resume_tries INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE host_settings (
            key TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL
        );",
    },
    // A Project's inbox (PLX-401, decision 0043): what its children did, built from the events
    // plxd handles. `run_id` is the run an item is about, `kind` one of 0043's kinds, and
    // `seen_at` NULL until a client marks it seen. No foreign keys, like the rest:
    // `Store::delete_project` deletes a project's items.
    Migration {
        version: 25,
        sql: "CREATE TABLE inbox (
            id TEXT NOT NULL PRIMARY KEY,
            project_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            seen_at TEXT
        );
        CREATE INDEX inbox_project ON inbox (project_id, created_at);",
    },
    // A project's permission mode (PLX-394, decision 0042), `auto` or `bypass`, which its
    // coordinator and every run in it start in. Existing projects get `auto`.
    Migration {
        version: 26,
        sql: "ALTER TABLE projects ADD COLUMN permission TEXT NOT NULL DEFAULT 'auto';",
    },
    // A run's waiting messages (PLX-370, decision 0048), so a restart keeps them: `position`
    // orders them, first to be sent first, and `extra` is the daemon's JSON for what else goes
    // with the message (its images, run options, and account). No foreign key, like `turns`.
    Migration {
        version: 27,
        sql: "CREATE TABLE queued (
            run_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            text TEXT NOT NULL,
            extra TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, turn_id)
        );",
    },
    // Whether a child wakes its parent when a CLI process of its ends (PLX-380, decisions 0025
    // and 0041): `thread_launch`'s `notify`. Existing runs keep what they did: a coordinator's
    // subagents woke it, and a thread's children didn't wake it.
    Migration {
        version: 28,
        sql: "ALTER TABLE runs ADD COLUMN notify_parent INTEGER NOT NULL DEFAULT 0;
        UPDATE runs SET notify_parent = 1
            WHERE parent IS NOT NULL AND coordinator_thread IS NOT NULL;",
    },
    // A project's base branch and integration branch (PLX-409, decision 0045), NULL until set or
    // cut, and whether a run in a project is an exploration child, which never lands.
    Migration {
        version: 29,
        sql: "ALTER TABLE projects ADD COLUMN base_branch TEXT;
        ALTER TABLE projects ADD COLUMN integration_branch TEXT;
        ALTER TABLE runs ADD COLUMN explore INTEGER NOT NULL DEFAULT 0;",
    },
    // A Project's children's questions (PLX-402, decision 0043): what a child asked with `ask`
    // and the assumption it went on with, its status (`open`, `escalated`, `decided`, or
    // `answered`), and the answer once there is one. `Store::delete_project` deletes a project's
    // questions.
    Migration {
        version: 30,
        sql: "CREATE TABLE questions (
            id TEXT NOT NULL PRIMARY KEY,
            project_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            question TEXT NOT NULL,
            assumption TEXT NOT NULL,
            status TEXT NOT NULL,
            answer TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX questions_project ON questions (project_id, created_at);",
    },
    // A project's autonomy level (PLX-403, decision 0043), `ask`, `routine`, or `full`: who
    // answers its children's questions. Existing projects get `routine`.
    Migration {
        version: 31,
        sql: "ALTER TABLE projects ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'routine';",
    },
    // The coordinator whose wake-up turn carried a question to its CLI (PLX-469), NULL until one
    // did, so a restart's catch-up names only questions that coordinator hasn't seen.
    Migration {
        version: 32,
        sql: "ALTER TABLE questions ADD COLUMN delivered_to TEXT;",
    },
    // A Project's landing queue (PLX-410, decision 0045): one row per child the coordinator
    // queued with `land`, its status (`waiting`, `queued`, `sentBack`, `landed`, or `needsYou`),
    // how many times landing it conflicted, and when it was last queued, which orders the queue.
    // And whether a project lands its children without waiting for the user's approval.
    Migration {
        version: 33,
        sql: "CREATE TABLE landings (
            run_id TEXT NOT NULL PRIMARY KEY,
            project_id TEXT NOT NULL,
            status TEXT NOT NULL,
            conflicts INTEGER NOT NULL DEFAULT 0,
            queued_at TEXT NOT NULL
        );
        CREATE INDEX landings_project ON landings (project_id, status, queued_at);
        ALTER TABLE projects ADD COLUMN auto_land INTEGER NOT NULL DEFAULT 0;",
    },
    // Placing a Project's children (PLX-413, decision 0046): how many may run at once, whether
    // they may use an API key, and the children waiting to be placed, oldest first. `prompt` is
    // a child's first message with its attached threads, and `extra` the daemon's JSON for its
    // images, threads, and requested account. `Store::delete_project` deletes a project's rows.
    Migration {
        version: 34,
        sql: "ALTER TABLE projects ADD COLUMN max_children INTEGER NOT NULL DEFAULT 10;
        ALTER TABLE projects ADD COLUMN allow_api_keys INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE placements (
            run_id TEXT NOT NULL PRIMARY KEY,
            project_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            extra TEXT NOT NULL,
            created_at TEXT NOT NULL
        );",
    },
    // A Project's checks (PLX-411, decision 0045): the command the user confirmed, which runs
    // after each landing, and the one its coordinator proposed, which never runs. NULL is none.
    // And how many times a child's landing failed the checks since it was queued.
    Migration {
        version: 35,
        sql: "ALTER TABLE projects ADD COLUMN checks TEXT;
        ALTER TABLE projects ADD COLUMN proposed_checks TEXT;
        ALTER TABLE landings ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;",
    },
    // `thread/search`'s full-text index (PLX-487): a run's messages, never tool calls or their
    // output. The triggers on `runs` and `turns` index a prompt and each sent turn as they're
    // stored, and `Store::index_run_text` adds the agent's `text` replies when a turn ends. A
    // reply row's `seq` is the newest event it covers, where the next one starts; a message's
    // row keeps the run's current one. `thread_text_fts` indexes `text` without a copy of it,
    // the `thread_text` triggers keep it in step, and `delete_run_rows` deletes a run's rows.
    // Existing runs get their prompt, their turns, and one row of all their replies.
    Migration {
        version: 36,
        sql: "CREATE TABLE thread_text (
            id INTEGER PRIMARY KEY,
            run_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX thread_text_run ON thread_text (run_id, seq);
        CREATE VIRTUAL TABLE thread_text_fts USING fts5(
            text, content = 'thread_text', content_rowid = 'id',
            tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER thread_text_insert AFTER INSERT ON thread_text BEGIN
            INSERT INTO thread_text_fts (rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER thread_text_delete AFTER DELETE ON thread_text BEGIN
            INSERT INTO thread_text_fts (thread_text_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
        END;
        INSERT INTO thread_text (run_id, seq, text) SELECT id, 0, prompt FROM runs;
        INSERT INTO thread_text (run_id, seq, text) SELECT run_id, 0, text FROM turns;
        INSERT INTO thread_text (run_id, seq, text)
        SELECT events.run_id, MAX(events.seq),
            group_concat(json_extract(item.value, '$.text'), char(10))
        FROM events, json_each(events.payload, '$.items') AS item
        WHERE events.kind = 'agent.output' AND events.run_id IS NOT NULL
            AND json_extract(item.value, '$.kind') = 'text'
            AND json_extract(item.value, '$.text') IS NOT NULL
        GROUP BY events.run_id;
        CREATE TRIGGER thread_text_prompt AFTER INSERT ON runs BEGIN
            INSERT INTO thread_text (run_id, seq, text) VALUES (new.id, 0, new.prompt);
        END;
        CREATE TRIGGER thread_text_turn AFTER INSERT ON turns BEGIN
            INSERT INTO thread_text (run_id, seq, text)
            VALUES (new.run_id, COALESCE((SELECT MAX(seq) FROM thread_text
                WHERE run_id = new.run_id), 0), new.text);
        END;",
    },
    // Command receipts (0052, PLX-482): a client-chosen commandId claims a row before a listed
    // method runs. `result` stays null until the command ends; `effect_id` is for PLX-483.
    Migration {
        version: 37,
        sql: "CREATE TABLE command_receipts (
            command_id TEXT NOT NULL PRIMARY KEY,
            method TEXT NOT NULL,
            params_hash TEXT NOT NULL,
            run_id TEXT,
            effect_id INTEGER,
            result TEXT,
            created_at TEXT NOT NULL,
            finished_at TEXT
        );
        CREATE INDEX command_receipts_run ON command_receipts (run_id, created_at);
        CREATE INDEX command_receipts_age ON command_receipts (created_at);",
    },
];

/// Bootstraps the `schema_version` table and applies every migration whose
/// version isn't recorded, in order. A missing version below the newest
/// recorded one still applies, for a developer database that ran a branch's
/// migration before an earlier-numbered one landed. Versions must be exactly
/// `1..=N` (a test checks it), so two branches can't both ship the same one.
pub(crate) fn run(conn: &mut Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;

    let applied: BTreeSet<i64> = conn
        .prepare("SELECT version FROM schema_version")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let current = applied.last().copied().unwrap_or(0);

    let supported = MIGRATIONS.last().map_or(0, |m| m.version);
    if current > supported {
        return Err(StoreError::UnsupportedSchemaVersion {
            found: current,
            supported,
        });
    }

    for migration in MIGRATIONS.iter().filter(|m| !applied.contains(&m.version)) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // `applied` was read before this transaction acquired the write
        // lock, so another connection may have applied this exact
        // migration in the meantime (two `Store::open` calls racing to
        // create the same brand-new database). Re-check under the lock,
        // which now sees that connection's commit rather than our stale
        // pre-lock snapshot, and skip re-applying it if so.
        let already_applied: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_version WHERE version = ?1)",
            params![migration.version],
            |row| row.get(0),
        )?;

        if !already_applied {
            tx.execute_batch(migration.sql)?;
            tx.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)",
                params![migration.version, timestamp::now()],
            )?;
        }

        tx.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::MIGRATIONS;

    /// Versions are exactly `1..=N`: a duplicate would be skipped silently as already applied,
    /// and a gap would let a later release apply a migration beneath a newer schema. Two branches
    /// that each add one must take distinct numbers, and this fails whichever merges second.
    #[test]
    fn versions_are_exactly_one_to_n() {
        let versions: Vec<i64> = MIGRATIONS.iter().map(|m| m.version).collect();
        let expected: Vec<i64> = (1..=i64::try_from(MIGRATIONS.len()).unwrap()).collect();
        assert_eq!(versions, expected);
    }
}
