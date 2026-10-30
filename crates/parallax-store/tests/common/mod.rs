/// Rolls back migration 56 (0093), for a test that rolls back past it.
pub const UNDO_56: &str = "ALTER TABLE orchestrators RENAME TO projects;
    ALTER TABLE orchestrator_sessions RENAME TO coordinator_sessions;
    ALTER TABLE runs RENAME COLUMN orchestrator_thread TO coordinator_thread;
    ALTER TABLE inbox RENAME COLUMN orchestrator_id TO project_id;
    ALTER TABLE questions RENAME COLUMN orchestrator_id TO project_id;
    ALTER TABLE landings RENAME COLUMN orchestrator_id TO project_id;
    ALTER TABLE placements RENAME COLUMN orchestrator_id TO project_id;
    ALTER TABLE board_items RENAME COLUMN orchestrator_id TO project_id;
    DROP INDEX inbox_orchestrator;
    CREATE INDEX inbox_project ON inbox (project_id, created_at);
    DROP INDEX questions_orchestrator;
    CREATE INDEX questions_project ON questions (project_id, created_at);
    DROP INDEX landings_orchestrator;
    CREATE INDEX landings_project ON landings (project_id, status, queued_at);
    DROP INDEX board_items_orchestrator;
    CREATE INDEX board_items_project ON board_items (project_id);
    UPDATE role_defaults SET role = 'coordinator' WHERE role = 'orchestrator';
    DELETE FROM schema_version WHERE version = 56;";
