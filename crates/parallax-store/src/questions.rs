use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// A question a Project's child asked with `ask` (PLX-402, decision 0043). The daemon owns what
/// `status` means; this crate stores it as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub id: Uuid,
    pub project_id: Uuid,
    /// The child that asked.
    pub run_id: Uuid,
    pub question: String,
    /// What the child went on assuming.
    pub assumption: String,
    pub status: String,
    /// The coordinator's or the user's answer, once there is one.
    pub answer: Option<String>,
    pub created_at: Timestamp,
}

const COLUMNS: &str = "id, project_id, run_id, question, assumption, status, answer, created_at";

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
);

fn from_row(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn into_question(
    (id, project, run, question, assumption, status, answer, created): Raw,
) -> Result<Question, StoreError> {
    Ok(Question {
        id: Uuid::parse_str(&id)?,
        project_id: Uuid::parse_str(&project)?,
        run_id: Uuid::parse_str(&run)?,
        question,
        assumption,
        status,
        answer,
        created_at: timestamp::parse(&created)?,
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
            &format!("INSERT INTO questions ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
            params![
                question.id.to_string(),
                question.project_id.to_string(),
                question.run_id.to_string(),
                question.question,
                question.assumption,
                question.status,
                question.answer,
                timestamp::format(question.created_at),
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
                from_row,
            )
            .optional()?
            .map(into_question)
            .transpose()
    }

    /// `project`'s questions, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn questions(&self, project: Uuid) -> Result<Vec<Question>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM questions WHERE project_id = ?1 ORDER BY created_at, id"
        ))?;
        let rows = statement
            .query_map(params![project.to_string()], from_row)?
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
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use uuid::Uuid;

    use super::Question;
    use crate::Store;

    #[test]
    fn questions_list_per_project_take_an_answer_and_go_with_their_project_or_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (ours, theirs) = (Uuid::now_v7(), Uuid::now_v7());
        let question = |project| Question {
            id: Uuid::now_v7(),
            project_id: project,
            run_id: Uuid::now_v7(),
            question: "Which port?".to_owned(),
            assumption: "8080".to_owned(),
            status: "open".to_owned(),
            answer: None,
            created_at: Timestamp::now(),
        };
        let (first, other) = (question(ours), question(theirs));
        store.add_question(&first).unwrap();
        store.add_question(&other).unwrap();
        assert_eq!(store.questions(ours).unwrap(), std::slice::from_ref(&first));

        assert!(
            store
                .set_question(first.id, "decided", Some("9090"))
                .unwrap()
        );
        let stored = store.get_question(first.id).unwrap().unwrap();
        assert_eq!(
            (stored.status.as_str(), stored.answer.as_deref()),
            ("decided", Some("9090"))
        );
        assert!(!store.set_question(Uuid::now_v7(), "decided", None).unwrap());

        store.delete_project(ours).unwrap();
        assert!(store.questions(ours).unwrap().is_empty());
        assert_eq!(
            store.questions(theirs).unwrap(),
            std::slice::from_ref(&other)
        );
        store.delete_run(other.run_id).unwrap();
        assert!(store.questions(theirs).unwrap().is_empty());
    }
}
