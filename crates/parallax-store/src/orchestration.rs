//! The orchestrator's receipts and effect outbox (0059). The daemon owns what a command's type,
//! an effect's kind, and their payloads mean; this crate stores them as text.

use jiff::{SignedDuration, Timestamp};
use rusqlite::{OptionalExtension, params, params_from_iter};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// How long receipts and settled effects are kept (0059): far longer than any retry.
const RETENTION: SignedDuration = SignedDuration::from_hours(7 * 24);

/// A command's outcome, written in the transaction that applied it (0059).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestrationReceipt {
    pub command_id: String,
    /// The thread (or Project) whose lane the command ran in.
    pub thread_id: Uuid,
    /// The command's type, such as `thread.archive`.
    pub kind: String,
    /// The newest `seq` it staged; `None` when it staged nothing.
    pub result_seq: Option<u64>,
    /// The error JSON of a rejected command; `None` for an accepted one.
    pub error: Option<String>,
}

/// An effect to enqueue with a command's change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEffect {
    /// Derived from the command and the effect's place in it, so a replay can't enqueue twice.
    pub id: String,
    pub command_id: String,
    pub thread_id: Uuid,
    pub kind: String,
    pub payload: String,
}

/// An effect the worker claimed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedEffect {
    pub id: String,
    pub thread_id: Uuid,
    pub kind: String,
    pub payload: String,
    /// Attempts so far, this one included.
    pub attempts: u32,
}

/// How a claimed effect ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectOutcome {
    Succeeded,
    /// Back to `pending`, claimable again at `at`.
    Retry {
        error: String,
        at: Timestamp,
    },
    Failed {
        error: String,
    },
}

fn cutoff() -> String {
    timestamp::format(Timestamp::now() - RETENTION)
}

impl Store {
    /// The receipt for `command_id`, if any.
    ///
    /// # Errors
    ///
    /// A database error, or an error if the stored thread id is corrupt.
    pub fn orchestration_receipt(
        &self,
        command_id: &str,
    ) -> Result<Option<OrchestrationReceipt>, StoreError> {
        let row = self
            .conn
            .prepare_cached(
                "SELECT thread_id, type, result_seq, error FROM orchestration_receipts
                 WHERE command_id = ?1",
            )?
            .query_row(params![command_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                ))
            })
            .optional()?;
        row.map(|(thread_id, kind, result_seq, error)| {
            Ok(OrchestrationReceipt {
                command_id: command_id.to_owned(),
                thread_id: Uuid::parse_str(&thread_id)?,
                kind,
                result_seq,
                error,
            })
        })
        .transpose()
    }

    /// Inserts `receipt`, after deleting receipts older than seven days.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if `command_id` has one already.
    pub fn insert_orchestration_receipt(
        &self,
        receipt: &OrchestrationReceipt,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("DELETE FROM orchestration_receipts WHERE at < ?1")?
            .execute(params![cutoff()])?;
        self.conn
            .prepare_cached(
                "INSERT INTO orchestration_receipts
                    (command_id, thread_id, type, status, result_seq, error, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![
                receipt.command_id,
                receipt.thread_id.to_string(),
                receipt.kind,
                if receipt.error.is_some() {
                    "rejected"
                } else {
                    "accepted"
                },
                receipt.result_seq,
                receipt.error,
                timestamp::now(),
            ])?;
        Ok(())
    }

    /// Enqueues `effect`, available now, unless its id is enqueued already. Deletes succeeded
    /// and cancelled effects older than seven days first; failed ones are kept.
    ///
    /// # Errors
    ///
    /// A database error.
    // ponytail: the prune scans settled rows on every enqueue; index `completed_at` when
    // phase 2's per-turn effects make the table large.
    pub fn enqueue_effect(&self, effect: &NewEffect) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "DELETE FROM effects
                 WHERE status IN ('succeeded', 'cancelled') AND completed_at < ?1",
            )?
            .execute(params![cutoff()])?;
        let now = timestamp::now();
        self.conn
            .prepare_cached(
                "INSERT INTO effects
                    (id, command_id, thread_id, kind, payload, status, available_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)
                 ON CONFLICT (id) DO NOTHING",
            )?
            .execute(params![
                effect.id,
                effect.command_id,
                effect.thread_id.to_string(),
                effect.kind,
                effect.payload,
                now,
            ])?;
        Ok(())
    }

    /// Claims at most `limit` effects available at `now`, marking them `running`: each the
    /// oldest open effect of its thread, so a thread runs its effects one at a time, in order.
    /// The claim queries repeat `effects_open`'s `status IN ('pending', 'running')` beside
    /// `status = 'pending'` so SQLite uses that partial index.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored thread id is corrupt.
    pub fn claim_effects(
        &self,
        now: Timestamp,
        limit: usize,
    ) -> Result<Vec<ClaimedEffect>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare_cached(
            "UPDATE effects SET status = 'running', attempts = attempts + 1
             WHERE id IN (
                 SELECT c.id FROM effects AS c
                 WHERE c.status IN ('pending', 'running') AND c.status = 'pending'
                   AND c.available_at <= ?1
                   AND NOT EXISTS (
                       SELECT 1 FROM effects AS a
                       WHERE a.thread_id = c.thread_id
                         AND a.status IN ('pending', 'running')
                         AND a.rowid < c.rowid
                   )
                 ORDER BY c.available_at, c.rowid
                 LIMIT ?2
             )
             RETURNING id, thread_id, kind, payload, attempts",
        )?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![timestamp::format(now), limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        let mut claimed = Vec::new();
        for row in rows {
            let (id, thread_id, kind, payload, attempts) = row?;
            claimed.push(ClaimedEffect {
                id,
                thread_id: Uuid::parse_str(&thread_id)?,
                kind,
                payload,
                attempts,
            });
        }
        Ok(claimed)
    }

    /// When the next effect that waits on its backoff becomes available, if one does. A thread
    /// with an effect running has none: that effect's end wakes the worker.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored timestamp is corrupt.
    pub fn next_effect_at(&self) -> Result<Option<Timestamp>, StoreError> {
        let next: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT MIN(c.available_at) FROM effects AS c
                 WHERE c.status IN ('pending', 'running') AND c.status = 'pending'
                   AND NOT EXISTS (
                       SELECT 1 FROM effects AS a
                       WHERE a.thread_id = c.thread_id
                         AND a.status IN ('pending', 'running')
                         AND a.rowid < c.rowid
                   )",
            )?
            .query_row([], |row| row.get(0))?;
        next.map(|at| timestamp::parse(&at)).transpose()
    }

    /// Records how claimed effect `id` ended. Does nothing to an effect no longer `running`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn finish_effect(&self, id: &str, outcome: &EffectOutcome) -> Result<(), StoreError> {
        let now = timestamp::now();
        let (status, error, available_at) = match outcome {
            EffectOutcome::Succeeded => ("succeeded", None, None),
            EffectOutcome::Retry { error, at } => {
                ("pending", Some(error), Some(timestamp::format(*at)))
            }
            EffectOutcome::Failed { error } => ("failed", Some(error), None),
        };
        self.conn
            .prepare_cached(
                "UPDATE effects SET status = ?2, last_error = ?3,
                     available_at = COALESCE(?4, available_at),
                     completed_at = CASE WHEN ?2 = 'pending' THEN NULL ELSE ?5 END
                 WHERE id = ?1 AND status = 'running'",
            )?
            .execute(params![id, status, error, available_at, now])?;
        Ok(())
    }

    /// Start-up recovery (0059): `running` effects whose kind is in `replay_safe` go back to
    /// `pending`, and open effects of any other kind are cancelled, since the process they
    /// belonged to is gone. Returns how many were requeued and how many cancelled.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn recover_effects(&self, replay_safe: &[&str]) -> Result<(usize, usize), StoreError> {
        let now = timestamp::now();
        let kinds = vec!["?"; replay_safe.len()].join(", ");
        let cancelled = self.conn.execute(
            &format!(
                "UPDATE effects SET status = 'cancelled', completed_at = ?1,
                     last_error = 'Cancelled because plxd restarted before it finished.'
                 WHERE status IN ('pending', 'running') AND kind NOT IN ({kinds})"
            ),
            params_from_iter(std::iter::once(now.as_str()).chain(replay_safe.iter().copied())),
        )?;
        let requeued = self.conn.execute(
            "UPDATE effects SET status = 'pending', available_at = ?1,
                 last_error = 'Requeued after plxd restarted.'
             WHERE status = 'running'",
            params![now],
        )?;
        Ok((requeued, cancelled))
    }
}

#[cfg(test)]
mod tests {
    use jiff::{SignedDuration, Timestamp};
    use uuid::Uuid;

    use super::{EffectOutcome, NewEffect, OrchestrationReceipt, Store};

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("plxd.sqlite3")).unwrap();
        (dir, store)
    }

    fn effect(id: &str, thread: Uuid, kind: &str) -> NewEffect {
        NewEffect {
            id: id.to_owned(),
            command_id: "c".to_owned(),
            thread_id: thread,
            kind: kind.to_owned(),
            payload: "{}".to_owned(),
        }
    }

    fn status(store: &Store, id: &str) -> String {
        store
            .conn
            .query_row("SELECT status FROM effects WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn a_receipt_reads_back_and_a_second_with_its_id_fails() {
        let (_dir, store) = open();
        let receipt = OrchestrationReceipt {
            command_id: "c1".to_owned(),
            thread_id: Uuid::now_v7(),
            kind: "thread.archive".to_owned(),
            result_seq: Some(4),
            error: None,
        };
        store.insert_orchestration_receipt(&receipt).unwrap();
        assert_eq!(
            store.orchestration_receipt("c1").unwrap(),
            Some(receipt.clone())
        );
        assert!(store.insert_orchestration_receipt(&receipt).is_err());
        assert_eq!(store.orchestration_receipt("c2").unwrap(), None);
    }

    /// Each thread's effects run one at a time, oldest first, and a repeated id enqueues once.
    #[test]
    fn a_thread_runs_its_effects_one_at_a_time_in_order() {
        let (_dir, store) = open();
        let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
        for (id, thread) in [("a1", a), ("a2", a), ("b1", b), ("a1", a)] {
            store.enqueue_effect(&effect(id, thread, "k")).unwrap();
        }
        let now = Timestamp::now() + SignedDuration::from_secs(1);
        let ids = |claimed: Vec<super::ClaimedEffect>| {
            let mut ids: Vec<_> = claimed.into_iter().map(|e| e.id).collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(store.claim_effects(now, 4).unwrap()), ["a1", "b1"]);
        assert!(
            store.claim_effects(now, 4).unwrap().is_empty(),
            "a2 waits on a1"
        );
        let later = Timestamp::now() + SignedDuration::from_secs(60);
        store
            .finish_effect(
                "a1",
                &EffectOutcome::Retry {
                    error: "busy".to_owned(),
                    at: later,
                },
            )
            .unwrap();
        assert!(
            store.claim_effects(now, 4).unwrap().is_empty(),
            "a1 backs off first"
        );
        assert_eq!(store.next_effect_at().unwrap(), Some(later));
        let retried = store.claim_effects(later, 4).unwrap();
        assert_eq!((retried[0].id.as_str(), retried[0].attempts), ("a1", 2));
        store
            .finish_effect("a1", &EffectOutcome::Succeeded)
            .unwrap();
        assert_eq!(ids(store.claim_effects(later, 4).unwrap()), ["a2"]);
    }

    /// After a crash, a replay-safe effect that was running runs again, and any other open one
    /// is retired.
    #[test]
    fn recovery_requeues_replay_safe_effects_and_cancels_the_rest() {
        let (_dir, store) = open();
        let (a, b, c) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        store
            .enqueue_effect(&effect("safe", a, "thread.cleanup"))
            .unwrap();
        store
            .enqueue_effect(&effect("bound", b, "provider-turn.start"))
            .unwrap();
        store
            .enqueue_effect(&effect("waiting", c, "provider-turn.start"))
            .unwrap();
        let now = Timestamp::now() + SignedDuration::from_secs(1);
        store.claim_effects(now, 2).unwrap();

        assert_eq!(store.recover_effects(&["thread.cleanup"]).unwrap(), (1, 2));
        assert_eq!(status(&store, "safe"), "pending");
        assert_eq!(status(&store, "bound"), "cancelled");
        assert_eq!(status(&store, "waiting"), "cancelled");
        let claimed = store.claim_effects(now, 4).unwrap();
        assert_eq!((claimed.len(), claimed[0].attempts), (1, 2));
    }
}
