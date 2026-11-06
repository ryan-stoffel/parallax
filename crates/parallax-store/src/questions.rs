use jiff::Timestamp;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// A question an orchestrator's child asked with `ask` (PLX-402, decision 0043). The daemon owns
/// what `status` means; this crate stores it as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub id: Uuid,
    pub orchestrator_id: Uuid,
    /// The child that asked.
    pub run_id: Uuid,
    pub question: String,
    /// What the child went on assuming.
    pub assumption: String,
    pub status: String,
    /// The orchestrator's or the user's answer, once there is one.
    pub answer: Option<String>,
    pub created_at: Timestamp,
    /// The orchestrator run whose wake-up turn carried the question to its CLI (PLX-469).
    pub delivered_to: Option<Uuid>,
}

const COLUMNS: &str =
    "id, orchestrator_id, run_id, question, assumption, status, answer, created_at, delivered_to";

/// A row as SQLite stored it, before the fallible conversion to [`Question`].
type Raw = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);

fn into_question(
    (id, orchestrator, run, question, assumption, status, answer, created, delivered): Raw,
) -> Result<Question, StoreError> {
    Ok(Question {
        id: Uuid::parse_str(&id)?,
        orchestrator_id: Uuid::parse_str(&orchestrator)?,
        run_id: Uuid::parse_str(&run)?,
        question,
        assumption,
        status,
        answer,
        created_at: timestamp::parse(&created)?,
        delivered_to: delivered.as_deref().map(Uuid::parse_str).transpose()?,
    })
}

impl Store {
    /// Records `question`.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if its id is taken.
    pub fn add_question(&self, question: &Question) -> Result<(), StoreError> {
        self.conn.execute(
            &format!(
                "INSERT INTO questions ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
            ),
            params![
                question.id.to_string(),
                question.orchestrator_id.to_string(),
                question.run_id.to_string(),
                question.question,
                question.assumption,
                question.status,
                question.answer,
                timestamp::format(question.created_at),
                question.delivered_to.map(|run| run.to_string()),
            ],
        )?;
        Ok(())
    }

    /// The question `id`, if there is one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn get_question(&self, id: Uuid) -> Result<Option<Question>, StoreError> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM questions WHERE id = ?1"),
                params![id.to_string()],
                |row| Raw::try_from(row),
            )
            .optional()?
            .map(into_question)
            .transpose()
    }

    /// `orchestrator`'s questions, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn questions(&self, orchestrator: Uuid) -> Result<Vec<Question>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM questions WHERE orchestrator_id = ?1 ORDER BY created_at, id"
        ))?;
        let rows = statement
            .query_map(params![orchestrator.to_string()], |row| Raw::try_from(row))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(into_question).collect()
    }

    /// Sets question `id`'s status and answer. Whether it exists.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_question(
        &self,
        id: Uuid,
        status: &str,
        answer: Option<&str>,
    ) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "UPDATE questions SET status = ?2, answer = ?3 WHERE id = ?1",
            params![id.to_string(), status, answer],
        )?;
        Ok(changed > 0)
    }

    /// Records that orchestrator run `to`'s wake-up turn carried questions `ids` to its CLI
    /// (PLX-469).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn deliver_questions(&self, ids: &[Uuid], to: Uuid) -> Result<(), StoreError> {
        for id in ids {
            self.conn.execute(
                "UPDATE questions SET delivered_to = ?2 WHERE id = ?1",
                params![id.to_string(), to.to_string()],
            )?;
        }
        Ok(())
    }
}
