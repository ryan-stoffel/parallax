//! Bounded, opt-in Connect diagnostics. No routes, identities, credentials or payloads.
use std::sync::{
    OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Instant;

static START: OnceLock<Option<Instant>> = OnceLock::new();
static LINES: AtomicUsize = AtomicUsize::new(0);

/// Whether this process explicitly enabled timings. Cached before a dial starts.
#[must_use]
pub fn enabled() -> bool {
    START
        .get_or_init(|| {
            (std::env::var("PLXD_CONNECT_TIMINGS").as_deref() == Ok("1")).then(Instant::now)
        })
        .is_some()
}

/// A fixed code-defined checkpoint, in milliseconds since the first instrumented entry.
/// At most 64 lines per process, including retries and concurrent routes.
pub fn mark(stage: &'static str) {
    if !enabled() || LINES.fetch_add(1, Ordering::Relaxed) >= 64 {
        return;
    }
    if let Some(Some(start)) = START.get() {
        eprintln!(
            "connect-timing {stage} {:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );
    }
}

/// Relay durations are untrusted: emit only known names and bounded finite numbers.
/// These are durations, unlike the cumulative client checkpoints.
pub fn server(value: &str) {
    for item in value.split(',').take(24) {
        let Some((name, duration)) = item.trim().split_once(";dur=") else {
            continue;
        };
        if ![
            "auth",
            "host_open",
            "stream_join",
            "admit",
            "take",
            "spare",
            "join_read",
            "join_ready",
            "join_delete_alarm",
            "join_total",
            "taken_entry",
            "taken_read",
            "taken_alarm",
            "taken_outcome",
            "taken_total",
            "limit",
            "jwks",
            "host_hop",
            "worker",
        ]
        .contains(&name)
        {
            continue;
        }
        let Ok(ms) = duration.parse::<f64>() else {
            continue;
        };
        if enabled()
            && ms.is_finite()
            && (0.0..=60_000.0).contains(&ms)
            && LINES.fetch_add(1, Ordering::Relaxed) < 64
        {
            eprintln!("connect-server-timing {name} {ms:.3}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    // A child process gives each case its own cached opt-in and line budget.
    #[test]
    fn emit_server_timings_child() {
        if let Ok(value) = std::env::var("PLXD_TIMING_TEST_HEADER") {
            for _ in 0..8 {
                server(&value);
            }
        }
    }

    #[test]
    fn server_allowlist_is_opt_in_finite_and_bounded() {
        let capture = |header: &str, enabled: bool| {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["emit_server_timings_child", "--nocapture"])
                .env("PLXD_CONNECT_TIMINGS", if enabled { "1" } else { "0" })
                .env("PLXD_TIMING_TEST_HEADER", header)
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stderr).unwrap()
        };
        let names = [
            "auth",
            "host_open",
            "stream_join",
            "admit",
            "take",
            "spare",
            "join_read",
            "join_ready",
            "join_delete_alarm",
            "join_total",
            "taken_entry",
            "taken_read",
            "taken_alarm",
            "taken_outcome",
            "taken_total",
            "limit",
            "jwks",
            "host_hop",
            "worker",
        ];
        let header = names.map(|name| format!("{name};dur=1")).join(", ");
        assert!(capture(&header, false).is_empty());
        let output = capture(&header, true);
        assert_eq!(output.lines().count(), 64);
        for name in names {
            assert!(output.contains(&format!("connect-server-timing {name} 1.000\n")));
        }
        assert!(capture("unknown;dur=1,join_read;dur=NaN,join_ready;dur=inf,join_total;dur=-1,taken_total;dur=60001", true).is_empty());
        let output = capture("join_read;dur=0,join_total;dur=60000", true);
        assert_eq!(output.lines().count(), 16);
        assert!(output.contains("join_read 0.000\n"));
        assert!(output.contains("join_total 60000.000\n"));
        let header = format!("{}join_total;dur=1", "unknown;dur=1,".repeat(24));
        assert!(capture(&header, true).is_empty());
    }
}
