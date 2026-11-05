//! `relay/check` (PLX-1356): whether a client could reach this host through the relay, and if not,
//! which part failed and what to do about it.
//!
//! plxd keeps no account token, so it can't open a stream as the user. Its control socket already
//! proved its key, so it asks there for a ticket to itself, which the relay gives only as it would
//! the host's owner, and opens the stream as a client does. The relay joins it to plxd's own side,
//! usually the spare stream, which dials the listener. TLS inside it is pinned to this host's id,
//! so the answer read through it can only have come from this plxd.
//!
//! A relay from before this says nothing of checks in its `ready`, so plxd never asks it.

use std::fmt::Write as _;
use std::future::Future;
use std::sync::PoisonError;
use std::time::Duration;

use parallax_protocol::{RelayCheckPart, RelayCheckResult};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;

use super::{
    Relay, Status, cant_reach, http, joined, local_listener, pipe, serving, signer, upgrade, wanted,
};
use crate::remote::{self, Error, Pin};
use crate::server::Daemon;
use crate::store::store_error;

/// How long a check waits for plxd to connect to the relay, which it asks to try at once.
const CONNECTING: Duration = Duration::from_secs(5);

/// How many characters of the host id diagnostics show.
const SHORT_ID: usize = 8;

const FIX_NETWORK: &str = "Check this computer's internet connection and clock, then check again. \
                           If both are fine, the relay may be down, so try again in a few minutes.";
const FIX_REGISTER: &str = "Run plx connect on this computer, or turn Reach from anywhere off and \
                            on in Settings, to register it.";
const FIX_STREAM: &str = "Check again. If it keeps failing, check that no firewall or proxy here \
                          blocks WebSockets to the relay, then restart Parallax.";

/// The first part that failed.
#[derive(Debug, PartialEq, Eq)]
struct Failure {
    part: RelayCheckPart,
    problem: String,
    fix: &'static str,
}

fn failure(part: RelayCheckPart, problem: impl Into<String>, fix: &'static str) -> Failure {
    // A network error's text has no period, and the fix reads straight after it.
    let mut problem: String = problem.into();
    if !problem.ends_with('.') {
        problem.push('.');
    }
    Failure { part, problem, fix }
}

impl Relay {
    /// The relay's answer to a connection check, for whoever waits for it. One that came after its
    /// check gave up goes to the next, and is as good.
    pub(super) fn check_answered(&self, answer: Value) {
        let waiting = self.check_answer.lock();
        let waiting = waiting.unwrap_or_else(PoisonError::into_inner).take();
        if let Some(waiting) = waiting {
            let _ = waiting.send(answer);
        }
    }

    /// Asks the relay for a ticket to this host over the control socket: its answer, or `None`
    /// when it gave none in time.
    async fn ask_ticket(&self) -> Option<Value> {
        let (answer, answered) = oneshot::channel();
        *self
            .check_answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(answer);
        self.check_asked.notify_one();
        time::timeout(remote::REQUEST_TIMEOUT, answered)
            .await
            .ok()?
            .ok()
    }

    /// The status once plxd is connected, or as it stands after [`CONNECTING`], with plxd told to
    /// try now rather than wait out its backoff.
    async fn connecting(&self) -> Status {
        if self.get().connected.is_none() {
            self.changed.notify_one();
        }
        let deadline = Instant::now() + CONNECTING;
        loop {
            let status = self.get();
            if status.connected.is_some() || Instant::now() >= deadline {
                return status;
            }
            time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Runs the check, one at a time, and reports it. `token` also checks the user's sign-in.
pub(crate) async fn run(daemon: &Daemon, token: Option<&str>) -> RelayCheckResult {
    let _running = daemon.relay.check_running.lock().await;
    let outcome = parts(daemon, token).await;
    let account = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.relay_account().map_err(|e| store_error(&e))
        })
        .await
        .ok()
        .flatten();
    let sessions = crate::server::remote::listed_with_status(daemon, Vec::new());
    let host_id = signer(daemon).await.ok().map(|key| key.thumbprint());
    let facts = Facts {
        at: jiff::Timestamp::now().to_string(),
        relay_url: &daemon.relay.url,
        host_id: host_id.as_deref(),
        checked_token: token.is_some(),
        account_recorded: account.is_some(),
        connected: daemon.relay.get().connected.is_some(),
        listening: sessions.listening,
        clock_offset_ms: daemon.relay.clock_offset_ms(),
    };
    report(outcome, &facts)
}

/// Each part in the order a client's connection needs it: how long the stream took, or the first
/// that failed.
async fn parts(daemon: &Daemon, token: Option<&str>) -> Result<u64, Failure> {
    use RelayCheckPart::Relay as RelayPart;
    if !wanted(daemon).await {
        return Err(failure(
            RelayPart,
            "This computer's connection to the relay is off.",
            "Turn on Reach from anywhere in Settings, or run plx connect.",
        ));
    }
    let key = signer(daemon).await.map_err(|e| {
        failure(
            RelayPart,
            format!("plxd can't read its host key: {e}"),
            FIX_REGISTER,
        )
    })?;
    let host_id = key.thumbprint();
    if let Some(token) = token {
        sign_in(daemon, token, &host_id).await?;
    }
    relay_connection(daemon).await?;
    listener(daemon, &host_id).await?;
    let started = Instant::now();
    through_relay(daemon, &host_id).await?;
    Ok(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
}

/// Whether the relay takes the Clerk `token` and lists this host under its user.
async fn sign_in(daemon: &Daemon, token: &str, host_id: &str) -> Result<(), Failure> {
    use RelayCheckPart::{Relay as RelayPart, SignIn};
    let url = &daemon.relay.url;
    let timed = time::timeout(
        remote::REQUEST_TIMEOUT,
        http(url, "GET", "/v1/hosts", Some(token), None),
    );
    let body = match timed.await {
        Ok(Ok((200, body))) => body,
        Ok(Ok((401, _))) => {
            return Err(failure(
                SignIn,
                "The relay didn't accept this sign-in.",
                "Sign in again from Profile in the sidebar.",
            ));
        }
        Ok(Ok((503, body))) if body["error"] == "clerk_unreachable" => {
            return Err(failure(
                SignIn,
                "The relay can't reach Clerk to check this sign-in.",
                "Try again in a few minutes.",
            ));
        }
        Ok(Ok((status, _))) => {
            return Err(failure(
                RelayPart,
                format!("The relay answered {status}."),
                FIX_NETWORK,
            ));
        }
        Ok(Err(error)) => return Err(failure(RelayPart, cant_reach(&error), FIX_NETWORK)),
        Err(_) => {
            return Err(failure(
                RelayPart,
                "The relay didn't answer in time.",
                FIX_NETWORK,
            ));
        }
    };
    let listed = body["hosts"]
        .as_array()
        .is_some_and(|hosts| hosts.iter().any(|host| host["hostId"] == host_id));
    if listed {
        return Ok(());
    }
    Err(failure(
        SignIn,
        "This computer isn't on the account you're signed in to.",
        FIX_REGISTER,
    ))
}

/// Whether plxd's control socket is up, which proves the relay accepts its key, and whether the
/// relay is new enough to answer a check.
async fn relay_connection(daemon: &Daemon) -> Result<(), Failure> {
    use RelayCheckPart::{Relay as RelayPart, SignIn};
    let status = daemon.relay.connecting().await;
    if status.unregistered {
        return Err(failure(
            SignIn,
            "The relay doesn't know this computer.",
            FIX_REGISTER,
        ));
    }
    if status.connected.is_none() {
        let problem = status
            .problem
            .unwrap_or_else(|| "plxd isn't connected to the relay.".to_owned());
        return Err(failure(RelayPart, problem, FIX_NETWORK));
    }
    if !status.checks {
        return Err(failure(
            RelayPart,
            "The relay is too old to run this check.",
            "The relay needs updating. Its owner deploys the latest version, then check again.",
        ));
    }
    Ok(())
}

/// Whether plxd's remote listener answers on this computer, as this host.
async fn listener(daemon: &Daemon, host_id: &str) -> Result<(), Failure> {
    use RelayCheckPart::Listener;
    let fix_port = "Check again. If it keeps failing, quit whatever else uses this port, or \
                    restart Parallax.";
    if !serving(daemon).await {
        return Err(failure(
            Listener,
            "This computer's listener is off, so a stream has nowhere to go.",
            "Turn on Pair computers on this network in Settings, or run plx connect.",
        ));
    }
    let sessions = crate::server::remote::listed_with_status(daemon, Vec::new());
    if !sessions.listening {
        let problem = sessions
            .problem
            .unwrap_or_else(|| "plxd isn't listening yet.".to_owned());
        return Err(failure(Listener, problem, fix_port));
    }
    let read = async {
        let tcp = TcpStream::connect(local_listener(daemon)).await?;
        let _ = tcp.set_nodelay(true);
        remote::read_descriptor(Box::new(tcp), &Pin::HostId(host_id.to_owned())).await
    };
    match within(read).await {
        Some(Ok(_)) => Ok(()),
        Some(Err(Error::WrongHost)) => Err(failure(
            Listener,
            "Another program answers on plxd's port, with a different key.",
            fix_port,
        )),
        Some(Err(error)) => Err(failure(
            Listener,
            format!("plxd's listener didn't answer: {error}"),
            fix_port,
        )),
        None => Err(failure(
            Listener,
            "plxd's listener didn't answer in time.",
            fix_port,
        )),
    }
}

/// `work`, unless it takes longer than one request may.
async fn within<T>(work: impl Future<Output = T>) -> Option<T> {
    time::timeout(remote::REQUEST_TIMEOUT, work).await.ok()
}

/// A real stream through the relay back to this host's listener, with TLS pinned to its id.
async fn through_relay(daemon: &Daemon, host_id: &str) -> Result<(), Failure> {
    use RelayCheckPart::{Relay as RelayPart, Stream};
    let relay = &daemon.relay;
    let Some(answer) = relay.ask_ticket().await else {
        return Err(failure(
            RelayPart,
            "The relay stopped answering over plxd's connection.",
            FIX_NETWORK,
        ));
    };
    let Some(ticket) = answer["ticket"].as_str() else {
        let error = answer["error"].as_str().unwrap_or("no ticket");
        return Err(refused(error));
    };
    let path = format!("/v1/hosts/{host_id}/connect?ticket={ticket}");
    let socket = within(upgrade(&relay.url, &path, &[])).await;
    let mut socket = match socket {
        Some(Ok(socket)) => socket,
        Some(Err((Some(429), _))) => return Err(refused("rate_limited")),
        // Says nothing of the ticket, whose URL it failed at.
        Some(Err((Some(status), _))) => {
            return Err(failure(
                Stream,
                format!("The relay refused the stream with HTTP {status}."),
                FIX_STREAM,
            ));
        }
        Some(Err((None, error))) => return Err(failure(Stream, cant_reach(&error), FIX_STREAM)),
        None => {
            return Err(failure(
                Stream,
                "The relay didn't open the stream in time.",
                FIX_STREAM,
            ));
        }
    };
    let didnt_join = "The relay opened a stream, but this computer's plxd didn't join it.";
    if !matches!(within(joined(&mut socket)).await, Some(Ok(()))) {
        return Err(failure(Stream, didnt_join, FIX_STREAM));
    }
    let pin = Pin::HostId(host_id.to_owned());
    let stream: super::Stream = Box::new(pipe(socket, None, super::EndSlot::default()));
    match within(remote::read_descriptor(stream, &pin)).await {
        Some(Ok(_)) => Ok(()),
        Some(Err(Error::WrongHost)) => Err(failure(
            Stream,
            "A different key answered inside the stream, so nothing was sent through it.",
            "Don't sign in from this computer until this is explained. Copy the diagnostics into a \
             bug report.",
        )),
        Some(Err(error)) => Err(failure(
            Stream,
            format!("The stream opened, but no answer came back: {error}"),
            FIX_STREAM,
        )),
        None => Err(failure(
            Stream,
            "The stream opened, but no answer came back in time.",
            FIX_STREAM,
        )),
    }
}

/// The relay's refusal of a new stream, by its reason.
fn refused(error: &str) -> Failure {
    use RelayCheckPart::Stream;
    match error {
        "rate_limited" | "too_many_streams" => failure(
            Stream,
            "The relay refused a new stream: this computer has 16 open, or opened 30 this minute.",
            "Close a connection or wait a minute, then check again.",
        ),
        "daily_limit" => failure(
            Stream,
            "This computer used its 2 GiB through the relay for today.",
            "Streams come back at midnight UTC. Computers on the same network still connect directly.",
        ),
        other => failure(
            Stream,
            format!("The relay refused a new stream: {other}."),
            FIX_STREAM,
        ),
    }
}

/// What a report says besides the outcome. Nothing here is secret: see [`report`].
#[expect(
    clippy::struct_excessive_bools,
    reason = "lines of a report, not a state"
)]
struct Facts<'a> {
    at: String,
    relay_url: &'a str,
    host_id: Option<&'a str>,
    checked_token: bool,
    account_recorded: bool,
    connected: bool,
    listening: bool,
    clock_offset_ms: i64,
}

fn part_name(part: RelayCheckPart) -> &'static str {
    match part {
        RelayCheckPart::SignIn => "sign-in",
        RelayCheckPart::Relay => "relay",
        RelayCheckPart::Listener => "listener",
        RelayCheckPart::Stream => "stream",
    }
}

fn yes_no(yes: bool) -> &'static str {
    if yes { "yes" } else { "no" }
}

/// The result, with its text for a bug report. That text holds what's in [`Facts`] and the
/// failure's own words, which plxd writes without any token, ticket, or user id. The host id isn't
/// secret, as it's in every webhook URL, but only its start is needed.
fn report(outcome: Result<u64, Failure>, facts: &Facts<'_>) -> RelayCheckResult {
    let mut text = String::from("Parallax connection check\n");
    let (failed, problem, fix, round_trip_ms) = match outcome {
        Ok(ms) => {
            let _ = writeln!(
                text,
                "Result: passed, a stream through the relay took {ms} ms"
            );
            (None, None, None, Some(ms))
        }
        Err(Failure { part, problem, fix }) => {
            let _ = writeln!(text, "Result: failed at {}", part_name(part));
            let _ = writeln!(text, "Problem: {problem}");
            let _ = writeln!(text, "Fix: {fix}");
            (Some(part), Some(problem), Some(fix.to_owned()), None)
        }
    };
    let host: String = facts
        .host_id
        .unwrap_or("unknown")
        .chars()
        .take(SHORT_ID)
        .collect();
    let sign_in = if facts.checked_token {
        "account token"
    } else {
        "host key only"
    };
    let _ = write!(
        text,
        "Time: {}\nplxd: {}\nOS: {} {}\nRelay: {}\nHost: {host}\nSign-in checked with: {sign_in}\n\
         Account recorded: {}\nConnected to the relay: {}\nListening: {}\nClock offset: {} ms\n",
        facts.at,
        crate::version(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        facts.relay_url,
        yes_no(facts.account_recorded),
        yes_no(facts.connected),
        yes_no(facts.listening),
        facts.clock_offset_ms,
    );
    RelayCheckResult {
        failed,
        problem,
        fix,
        round_trip_ms,
        diagnostics: text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    fn facts() -> Facts<'static> {
        Facts {
            at: "2026-11-04T00:00:00Z".to_owned(),
            relay_url: "https://relay.parallax.codes",
            host_id: Some(HOST),
            checked_token: true,
            account_recorded: true,
            connected: true,
            listening: false,
            clock_offset_ms: 0,
        }
    }

    #[test]
    fn a_failure_names_its_part_and_fix_and_shows_only_the_start_of_the_host_id() {
        let failed = failure(RelayCheckPart::Listener, "It's off.", "Turn it on.");
        let result = report(Err(failed), &facts());
        assert_eq!(result.failed, Some(RelayCheckPart::Listener));
        assert_eq!(result.round_trip_ms, None);
        assert!(result.diagnostics.contains("Result: failed at listener\n"));
        assert!(
            result
                .diagnostics
                .contains("Problem: It's off.\nFix: Turn it on.\n")
        );
        assert!(result.diagnostics.contains("Host: abcdefgh\n"));
        assert!(!result.diagnostics.contains(HOST));
    }

    #[test]
    fn a_pass_says_how_long_the_stream_took() {
        let result = report(Ok(12), &facts());
        assert_eq!(result.failed, None);
        assert_eq!(result.round_trip_ms, Some(12));
        assert!(result.diagnostics.contains("took 12 ms\n"));
    }

    #[test]
    fn the_relays_reasons_for_refusing_a_stream_each_say_what_to_do() {
        for reason in ["rate_limited", "too_many_streams", "daily_limit", "other"] {
            let refusal = refused(reason);
            assert_eq!(refusal.part, RelayCheckPart::Stream);
            assert!(!refusal.fix.is_empty());
        }
        assert!(refused("daily_limit").problem.contains("2 GiB"));
    }
}
