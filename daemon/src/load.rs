//! How much of this computer's CPU and memory is in use, and its cores, for `host/health` (0101).

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use parallax_protocol::HostLoad;
use sysinfo::System;

/// The shortest time a reading covers: CPU use is measured between two refreshes, and over a much
/// shorter time than this it means little.
const FRESH: Duration = Duration::from_secs(1);

/// The last reading, kept so a later one measures CPU use since then. `None` on a system `sysinfo`
/// can't read, whose `host/health` leaves `load` out.
pub(crate) struct Load(Option<Mutex<Reading>>);

struct Reading {
    system: System,
    at: Instant,
    load: HostLoad,
}

impl Default for Load {
    /// Starts measuring now, so the first read covers the time since plxd started.
    fn default() -> Self {
        Self(System::new().ok().map(|mut system| {
            system.refresh_cpu_usage();
            system.refresh_memory();
            let load = measured(&system);
            Mutex::new(Reading {
                system,
                at: Instant::now(),
                load,
            })
        }))
    }
}

impl Load {
    /// The load now, or as measured within the last [`FRESH`].
    pub(crate) fn read(&self) -> Option<HostLoad> {
        let mut reading = self
            .0
            .as_ref()?
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if reading.at.elapsed() >= FRESH {
            reading.system.refresh_cpu_usage();
            reading.system.refresh_memory();
            reading.load = measured(&reading.system);
            reading.at = Instant::now();
        }
        Some(reading.load)
    }
}

/// `part` as a whole percentage of `whole`.
fn percent(part: f64, whole: f64) -> u8 {
    if whole <= 0.0 {
        return 0;
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to 0 through 100"
    )]
    let rounded = (part / whole * 100.0).round().clamp(0.0, 100.0) as u8;
    rounded
}

fn measured(system: &System) -> HostLoad {
    // `used_memory` leaves out file caches everywhere: Linux and Windows answer total minus
    // available, and macOS answers Activity Monitor's Memory Used. `available_memory` is no more
    // honest, since on macOS it counts active pages as available.
    #[expect(
        clippy::cast_precision_loss,
        reason = "a percentage needs no exact byte count"
    )]
    let memory = percent(system.used_memory() as f64, system.total_memory() as f64);
    HostLoad {
        cpu: percent(f64::from(system.global_cpu_usage()), 100.0),
        memory,
        cores: u32::try_from(system.cpus().len()).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::{Load, percent};

    #[test]
    fn a_reading_is_a_percentage_of_a_computer_with_memory() {
        let load = Load::default().read().unwrap();
        assert!(load.cpu <= 100);
        assert!((1..=100).contains(&load.memory), "{load:?}");
        assert!(load.cores > 0, "{load:?}");
        assert_eq!(percent(1.0, 0.0), 0);
        assert_eq!(percent(3.0, 2.0), 100);
    }
}
