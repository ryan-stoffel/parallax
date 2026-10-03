//! Resuming a run a usage limit stopped, once the limit resets (PLX-371, decision 0049).
//!
//! While a run's CLI runs, its actor keeps the newest reset time among the limit windows the CLI
//! reported refused ([`Resumes::saw`]): Claude Code's `rate_limit_event` and Codex's
//! `account/rateLimits/updated`. When the CLI ends `rateLimited` and auto-resume is on for the
//! run, [`schedule`] picks when to resume: that reset plus [`Timing::jitter`] when it is still
//! ahead, or else a backoff that doubles from [`Timing::backoff`] up to a cap, as for Cursor,
//! which reports no reset. The run becomes `waiting` with the time stored as `resumeAt`, so a
//! restart keeps it ([`restore`]), and at that time the actor resumes the session with
//! [`MESSAGE`].

use std::sync::Arc;
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::{RunId, TurnId};
use tracing::{info, warn};
use uuid::Uuid;

use super::convert::WAITING;
use super::{store, store_error};
use crate::backend::{LimitStatus, LimitWindow};
use crate::server::Daemon;

/// The turn plxd sends a run once its usage limit has reset.
pub(super) const MESSAGE: &str = "Your usage limit has reset. Continue where you left off.";

/// The backoff never grows past this many times its first interval: 4 hours from 15 minutes.
const BACKOFF_CAP: u32 = 16;

/// How long after a reset a run resumes, and the backoff when no reset is known.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    /// The most a resume waits past its reset, picked at random, so runs that hit the same
    /// limit don't all resume in the same second.
    pub jitter: Duration,
    /// The first wait with no reset to wait for. Each resume in a row that finds the limit
    /// still on doubles it.
    pub backoff: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            jitter: Duration::from_secs(60),
            backoff: Duration::from_mins(15),
        }
    }
}

/// What a run's actor keeps between a usage limit and its resume.
#[derive(Debug, Default)]
pub(super) struct Resumes {
    /// The newest reset among the windows the running CLI reported refused.
    reset: Option<Timestamp>,
    /// The resume turn last sent, until its `turnStarted` is logged.
    sent: Option<TurnId>,
}

impl Resumes {
    /// Notes a limit window the CLI reported.
    pub fn saw(&mut self, window: &LimitWindow) {
        if window.status == LimitStatus::Rejected
            && let Some(reset) = window.resets_at
        {
            self.reset = self.reset.max(Some(reset));
        }
    }

    /// The newest refused window's reset, forgetting it, once the CLI has ended.
    pub fn take_reset(&mut self) -> Option<Timestamp> {
        self.reset.take()
    }

    /// A new resume turn's id, remembered so its `turnStarted` is marked as plxd's.
    pub fn next(&mut self) -> TurnId {
        let turn = TurnId::generate();
        self.sent = Some(turn);
        turn
    }

    /// Whether `turn` was sent as a resume, forgetting it.
    pub fn was_sent(&mut self, turn: TurnId) -> bool {
        self.sent.take_if(|sent| *sent == turn).is_some()
    }
}

/// When a run a usage limit stopped resumes, and its tries in a row with no reset after this
/// one. A `reset` still ahead of `now` is waited for, plus jitter. One that has passed was
/// already waited for, or is stale, so a reset is waited for at most once and the run backs off
/// instead, as it does with no reset at all.
pub(super) fn schedule(
    reset: Option<Timestamp>,
    tries: u32,
    now: Timestamp,
    timing: Timing,
) -> (Timestamp, u32) {
    let jitter = random_up_to(timing.jitter);
    let (at, tries) = match reset.filter(|reset| *reset > now) {
        Some(reset) => (reset, 0),
        None => (now + signed(backoff(tries, timing.backoff)), tries + 1),
    };
    (at + signed(jitter), tries)
}

/// The wait before resume `tries + 1` in a row with no reset: `first`, doubling each try, up to
/// [`BACKOFF_CAP`] times `first`.
fn backoff(tries: u32, first: Duration) -> Duration {
    first * 2u32.saturating_pow(tries).min(BACKOFF_CAP)
}

/// A duration from zero to `max`, at random.
fn random_up_to(max: Duration) -> Duration {
    let max = u64::try_from(max.as_millis()).unwrap_or(u64::MAX);
    if max == 0 {
        return Duration::ZERO;
    }
    // A version 7 id's low 62 bits are random.
    let (_, random) = Uuid::now_v7().as_u64_pair();
    Duration::from_millis(random % (max + 1))
}

fn signed(duration: Duration) -> SignedDuration {
    SignedDuration::try_from(duration).unwrap_or(SignedDuration::MAX)
}

/// Whether a run with `own` as its override waits and resumes after a usage limit: its override,
/// or else the host's setting, which is on unless set off.
pub(super) async fn enabled(daemon: &Daemon, own: Option<bool>) -> bool {
    if let Some(own) = own {
        return own;
    }
    store(daemon, |db| db.auto_resume().map_err(|e| store_error(&e)))
        .await
        .unwrap_or_else(|error| {
            warn!(error = %error.message, "could not read the auto-resume setting; it stays on");
            true
        })
}

/// Spawns the actor of every waiting run, so each one's stored timer runs after a restart. One
/// whose time passed while plxd was stopped resumes at once. Called once at startup.
pub(super) async fn restore(daemon: &Arc<Daemon>) {
    let waiting = store(daemon, |db| {
        let runs = db.list_runs(None).map_err(|e| store_error(&e))?;
        Ok(runs
            .into_iter()
            .filter(|run| run.state.status == WAITING)
            .filter_map(|run| RunId::try_from(run.id).ok())
            .collect::<Vec<_>>())
    })
    .await;
    match waiting {
        Ok(waiting) => {
            for id in waiting {
                info!(run = %id, "a run waits for its usage limit to reset");
                if let Err(error) = super::actor_for(daemon, id).await {
                    warn!(run = %id, error = %error.message, "could not restore a run's resume");
                }
            }
        }
        Err(error) => warn!(error = %error.message, "could not find runs waiting to resume"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use jiff::{SignedDuration, Timestamp};

    use super::{Resumes, Timing, schedule};
    use crate::backend::{LimitStatus, LimitWindow};

    const EXACT: Timing = Timing {
        jitter: Duration::ZERO,
        backoff: Duration::from_mins(15),
    };

    fn minutes(minutes: i64) -> SignedDuration {
        SignedDuration::from_mins(minutes)
    }

    #[test]
    fn a_reset_still_ahead_is_waited_for_once() {
        let now: Timestamp = "2026-10-03T12:00:00Z".parse().unwrap();
        let reset = now + minutes(90);
        assert_eq!(schedule(Some(reset), 3, now, EXACT), (reset, 0));
        // At the reset, the limit was still on and the CLI reported the same time again.
        let later = reset + minutes(1);
        assert_eq!(
            schedule(Some(reset), 0, later, EXACT),
            (later + minutes(15), 1),
            "a reset that passed backs off instead"
        );
    }

    /// Cursor reports no reset: each resume in a row that finds the limit still on waits twice
    /// as long, up to 4 hours.
    #[test]
    fn with_no_reset_the_wait_doubles_up_to_a_cap() {
        let now: Timestamp = "2026-10-03T12:00:00Z".parse().unwrap();
        let mut tries = 0;
        let mut waits = Vec::new();
        for _ in 0..7 {
            let (at, next) = schedule(None, tries, now, EXACT);
            waits.push(at.duration_since(now).as_mins());
            tries = next;
        }
        assert_eq!(waits, [15, 30, 60, 120, 240, 240, 240]);
    }

    #[test]
    fn jitter_only_ever_adds_up_to_its_most() {
        let now: Timestamp = "2026-10-03T12:00:00Z".parse().unwrap();
        let reset = now + minutes(10);
        let timing = Timing {
            jitter: Duration::from_secs(60),
            ..EXACT
        };
        for _ in 0..100 {
            let (at, _) = schedule(Some(reset), 0, now, timing);
            assert!(at >= reset && at <= reset + minutes(1), "{at}");
        }
    }

    #[test]
    fn the_newest_refused_window_sets_the_reset() {
        let window = |status, minutes_ahead| LimitWindow {
            window: "five_hour".to_owned(),
            duration_minutes: None,
            used_percent: None,
            status,
            resets_at: Some(Timestamp::UNIX_EPOCH + minutes(minutes_ahead)),
        };
        let mut resumes = Resumes::default();
        resumes.saw(&window(LimitStatus::Allowed, 500));
        resumes.saw(&window(LimitStatus::Rejected, 60));
        resumes.saw(&window(LimitStatus::Rejected, 30));
        assert_eq!(
            resumes.take_reset(),
            Some(Timestamp::UNIX_EPOCH + minutes(60))
        );
        assert_eq!(resumes.take_reset(), None, "each CLI process starts over");
    }
}
