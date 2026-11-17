//! TLS 1.3 session tickets for 0-RTT (PLX-1585, 0091): kept in memory only, single-use, and for at
//! most [`LIFETIME`].
//!
//! - [`Issued`] is the listener's: the sessions behind the tickets it handed out. rustls takes one
//!   on first use, so a replayed `ClientHello` finds nothing and gets a full handshake, and it
//!   accepts early data only from such a session. A restart drops them all.
//! - [`Held`] is a client's, for one pinned key: a dial's config for that pin is the only one that
//!   holds it, so a ticket is never offered to another host. Only a plxd that dials for
//!   `plxd dial` keeps one past its connection ([`super::keep_tickets`]).

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use rustls::NamedGroup;
use rustls::client::{ClientSessionStore, Tls12ClientSessionValue, Tls13ClientSessionValue};
use rustls::pki_types::ServerName;
use rustls::server::StoresServerSessions;

/// How long a ticket works. A connect more than this after the last handshake with that computer
/// does a full handshake. The wall clock counts, so time asleep counts too, and a clock that went
/// back ends a ticket.
pub const LIFETIME: Duration = Duration::from_hours(1);

/// How many sessions the listener keeps. Past it, a new one pushes out the oldest.
const MAX_ISSUED: usize = 1024;

/// How many tickets a client keeps for one host.
const MAX_HELD: usize = 4;

fn fresh(made: SystemTime) -> bool {
    made.elapsed().is_ok_and(|age| age < LIFETIME)
}

/// Sessions by ticket, each with when it was made.
type Sessions = HashMap<Vec<u8>, (SystemTime, Vec<u8>)>;

/// The listener's sessions, by ticket. Each holds its resumption secret, so its `Debug` says only
/// how many there are.
#[derive(Default)]
pub struct Issued(Mutex<Sessions>);

impl std::fmt::Debug for Issued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = self.0.lock().unwrap_or_else(PoisonError::into_inner).len();
        f.debug_struct("Issued").field("held", &held).finish()
    }
}

impl StoresServerSessions for Issued {
    fn put(&self, key: Vec<u8>, value: Vec<u8>) -> bool {
        let mut issued = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        issued.retain(|_, (made, _)| fresh(*made));
        if issued.len() >= MAX_ISSUED
            && let Some(oldest) = issued
                .iter()
                .min_by_key(|(_, (made, _))| *made)
                .map(|(key, _)| key.clone())
        {
            issued.remove(&oldest);
        }
        issued.insert(key, (SystemTime::now(), value));
        true
    }

    fn get(&self, _: &[u8]) -> Option<Vec<u8>> {
        // Only TLS 1.2 looks a session up without taking it, and plxd builds only TLS 1.3.
        None
    }

    fn take(&self, key: &[u8]) -> Option<Vec<u8>> {
        let mut issued = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        issued
            .remove(key)
            .and_then(|(made, value)| fresh(made).then_some(value))
    }

    fn can_cache(&self) -> bool {
        true
    }
}

/// A client's tickets for one pinned host, newest last.
#[derive(Debug, Default)]
pub struct Held {
    tickets: Mutex<VecDeque<(SystemTime, Tls13ClientSessionValue)>>,
    group: Mutex<Option<NamedGroup>>,
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
        keep(&mut tickets, SystemTime::now(), value);
    }

    fn take_tls13_ticket(&self, _: &ServerName<'static>) -> Option<Tls13ClientSessionValue> {
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        take_newest(&mut tickets)
    }
}

/// Adds a ticket made at `made` to a client's `tickets`, dropping expired ones and the oldest
/// past [`MAX_HELD`].
fn keep<T>(tickets: &mut VecDeque<(SystemTime, T)>, made: SystemTime, value: T) {
    tickets.retain(|(made, _)| fresh(*made));
    if tickets.len() >= MAX_HELD {
        tickets.pop_front();
    }
    tickets.push_back((made, value));
}

/// Takes a client's newest ticket that hasn't expired.
fn take_newest<T>(tickets: &mut VecDeque<(SystemTime, T)>) -> Option<T> {
    tickets.retain(|(made, _)| fresh(*made));
    tickets.pop_back().map(|(_, value)| value)
}

/// A wrapper that keeps a dial's new tickets in `Held` but offers none, for a route the dial
/// didn't pick to resume on, so racing routes don't spend each other's tickets.
#[derive(Debug)]
pub struct KeepOnly(pub std::sync::Arc<Held>);

impl ClientSessionStore for KeepOnly {
    fn set_kx_hint(&self, name: ServerName<'static>, group: NamedGroup) {
        self.0.set_kx_hint(name, group);
    }

    fn kx_hint(&self, name: &ServerName<'_>) -> Option<NamedGroup> {
        self.0.kx_hint(name)
    }

    fn set_tls12_session(&self, _: ServerName<'static>, _: Tls12ClientSessionValue) {}

    fn tls12_session(&self, _: &ServerName<'_>) -> Option<Tls12ClientSessionValue> {
        None
    }

    fn remove_tls12_session(&self, _: &ServerName<'static>) {}

    fn insert_tls13_ticket(&self, name: ServerName<'static>, value: Tls13ClientSessionValue) {
        self.0.insert_tls13_ticket(name, value);
    }

    fn take_tls13_ticket(&self, _: &ServerName<'static>) -> Option<Tls13ClientSessionValue> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listener_hands_out_each_session_once() {
        let issued = Issued::default();
        assert!(issued.put(b"ticket".to_vec(), b"session".to_vec()));
        assert_eq!(issued.take(b"ticket"), Some(b"session".to_vec()));
        assert_eq!(issued.take(b"ticket"), None, "a replay finds nothing");
        assert_eq!(issued.get(b"ticket"), None);
    }

    #[test]
    fn the_listener_drops_a_session_past_its_lifetime() {
        let issued = Issued::default();
        let old = SystemTime::now() - LIFETIME;
        issued
            .0
            .lock()
            .unwrap()
            .insert(b"old".to_vec(), (old, b"session".to_vec()));
        assert_eq!(issued.take(b"old"), None);
    }

    #[test]
    fn the_listener_prints_no_session() {
        let issued = Issued::default();
        issued.put(b"ticket".to_vec(), b"secret".to_vec());
        assert_eq!(format!("{issued:?}"), "Issued { held: 1 }");
    }

    #[test]
    fn a_client_offers_its_newest_ticket_under_an_hour_old_and_keeps_at_most_four() {
        let now = SystemTime::now();
        let mut tickets = VecDeque::new();
        keep(&mut tickets, now - LIFETIME, "expired");
        keep(&mut tickets, now, "fresh");
        assert_eq!(take_newest(&mut tickets), Some("fresh"));
        assert_eq!(
            take_newest(&mut tickets),
            None,
            "an hour-old ticket isn't offered"
        );
        let mut many = VecDeque::new();
        for n in 0..=MAX_HELD {
            keep(&mut many, now, n);
        }
        assert_eq!(many.len(), MAX_HELD);
        assert_eq!(take_newest(&mut many), Some(MAX_HELD));
    }

    #[test]
    fn the_listener_keeps_at_most_its_limit() {
        let issued = Issued::default();
        for n in 0..=MAX_ISSUED {
            issued.put(n.to_be_bytes().to_vec(), Vec::new());
        }
        assert_eq!(issued.0.lock().unwrap().len(), MAX_ISSUED);
    }
}
