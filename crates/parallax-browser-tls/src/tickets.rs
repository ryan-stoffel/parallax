//! One pin's TLS 1.3 session tickets, in the page's memory only, on 0091's PLX-1585 terms: at most
//! [`MAX_HELD`], each used once, and none older than [`LIFETIME`] by the wall clock. The 24 hours
//! rustls writes in a ticket aren't honoured. A reload drops them all.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use rustls::NamedGroup;
use rustls::client::{ClientSessionStore, Tls12ClientSessionValue, Tls13ClientSessionValue};
use rustls::pki_types::{ServerName, UnixTime};

/// How long a ticket works, as plxd's listener keeps it.
pub const LIFETIME: Duration = Duration::from_hours(1);

/// How many tickets a pin keeps.
const MAX_HELD: usize = 4;

/// A pin's tickets, newest last, each with when it came.
#[derive(Default)]
pub struct Held {
    tickets: Mutex<VecDeque<(UnixTime, Tls13ClientSessionValue)>>,
    group: Mutex<Option<NamedGroup>>,
}

// Each ticket holds its resumption secret, so this prints none of them, and ships no code that
// could.
impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Held")
    }
}

impl ClientSessionStore for Held {
    fn set_kx_hint(&self, _: ServerName<'static>, group: NamedGroup) {
        *self.group.lock().unwrap_or_else(PoisonError::into_inner) = Some(group);
    }

    fn kx_hint(&self, _: &ServerName<'_>) -> Option<NamedGroup> {
        *self.group.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_tls12_session(&self, _: ServerName<'static>, _: Tls12ClientSessionValue) {}

    fn tls12_session(&self, _: &ServerName<'_>) -> Option<Tls12ClientSessionValue> {
        None
    }

    fn remove_tls12_session(&self, _: &ServerName<'static>) {}

    fn insert_tls13_ticket(&self, _: ServerName<'static>, value: Tls13ClientSessionValue) {
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        keep(&mut tickets, UnixTime::now(), value);
    }

    fn take_tls13_ticket(&self, _: &ServerName<'static>) -> Option<Tls13ClientSessionValue> {
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        take_newest(&mut tickets, UnixTime::now())
    }
}

/// Whether a ticket that came at `made` still works at `now`. A clock that went back ends it.
fn fresh(made: UnixTime, now: UnixTime) -> bool {
    now.as_secs()
        .checked_sub(made.as_secs())
        .is_some_and(|age| age < LIFETIME.as_secs())
}

/// Adds a ticket that came at `made`, dropping expired ones and the oldest past [`MAX_HELD`].
fn keep<T>(tickets: &mut VecDeque<(UnixTime, T)>, made: UnixTime, value: T) {
    tickets.retain(|(at, _)| fresh(*at, made));
    if tickets.len() >= MAX_HELD {
        tickets.pop_front();
    }
    tickets.push_back((made, value));
}

/// The newest ticket that still works at `now`, which a connect then spends.
fn take_newest<T>(tickets: &mut VecDeque<(UnixTime, T)>, now: UnixTime) -> Option<T> {
    tickets.retain(|(at, _)| fresh(*at, now));
    tickets.pop_back().map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> UnixTime {
        UnixTime::since_unix_epoch(Duration::from_secs(seconds))
    }

    #[test]
    fn keeps_four_and_spends_the_newest_first() {
        let mut tickets = VecDeque::new();
        for n in 0..6 {
            keep(&mut tickets, at(1_000 + n), n);
        }
        assert_eq!(tickets.len(), 4);
        assert_eq!(take_newest(&mut tickets, at(1_010)), Some(5));
        assert_eq!(take_newest(&mut tickets, at(1_010)), Some(4));
    }

    #[test]
    fn a_ticket_ends_after_an_hour_or_when_the_clock_goes_back() {
        let mut tickets = VecDeque::new();
        keep(&mut tickets, at(10_000), 1);
        assert_eq!(take_newest(&mut tickets, at(10_000 + 3_600)), None);
        keep(&mut tickets, at(10_000), 2);
        assert_eq!(take_newest(&mut tickets, at(9_999)), None);
        keep(&mut tickets, at(10_000), 3);
        assert_eq!(take_newest(&mut tickets, at(10_000 + 3_599)), Some(3));
    }
}
