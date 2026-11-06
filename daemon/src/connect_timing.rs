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
    for item in value.split(',').take(6) {
        let Some((name, duration)) = item.trim().split_once(";dur=") else {
            continue;
        };
        if !["auth", "host_open", "stream_join", "admit", "take", "spare"].contains(&name) {
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
