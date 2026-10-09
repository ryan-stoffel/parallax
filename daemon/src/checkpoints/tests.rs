use jiff::Timestamp;
use parallax_protocol::{CheckpointStatus, ThreadRun, ThreadRunStatus, TurnCheckpoint, TurnId};

use super::{Check, SHARED};

/// A started run that ran from `start` to `end` seconds, with a ready checkpoint.
fn run(ordinal: u32, status: ThreadRunStatus, start: i64, end: i64) -> ThreadRun {
    ThreadRun {
        id: TurnId::generate(),
        status,
        ordinal: Some(ordinal),
        position: None,
        attempt: Some(1),
        text: None,
        images: 0,
        threads: Vec::new(),
        from: None,
        wake: false,
        queue_held: false,
        started_at: Some(Timestamp::from_second(start).unwrap()),
        completed_at: Some(Timestamp::from_second(end).unwrap()),
        checkpoint: Some(TurnCheckpoint {
            status: CheckpointStatus::Ready,
            files: Vec::new(),
        }),
    }
}

fn check(ordinal: u32) -> Check {
    Check {
        ordinal,
        restore_files: true,
        can_rewind: true,
        isolated: true,
    }
}

#[test]
fn a_revert_undoes_the_later_runs_and_counts_a_steered_one_with_its_turn() {
    use ThreadRunStatus::{Completed, Interrupted, RolledBack};
    let runs = vec![
        run(1, Completed, 0, 10),
        run(2, Completed, 20, 30),
        // Steered into run 2's turn: it started before that turn ended.
        run(3, Completed, 25, 30),
        run(4, RolledBack, 40, 50),
        run(5, Interrupted, 60, 70),
    ];
    let (turns, undone) = check(1).run(&runs, "codex").unwrap();
    assert_eq!(turns, 2);
    assert_eq!(undone, [runs[1].id, runs[2].id, runs[4].id]);
    // To the thread's start, every run that wasn't undone already goes.
    assert_eq!(check(0).run(&runs, "codex").unwrap().0, 3);
    // To the newest checkpoint, nothing does.
    assert_eq!(check(5).run(&runs, "codex").unwrap(), (0, Vec::new()));
}

#[test]
fn a_revert_is_refused_before_anything_changes() {
    use ThreadRunStatus::{Completed, RolledBack, Running};
    let runs = vec![run(1, Completed, 0, 10), run(2, RolledBack, 20, 30)];
    let no_rewind = Check {
        can_rewind: false,
        ..check(1)
    };
    assert_eq!(
        no_rewind.run(&runs, "claude"),
        Err("claude can't rewind a conversation".to_owned())
    );
    let shared = Check {
        isolated: false,
        ..check(1)
    };
    assert_eq!(shared.run(&runs, "codex"), Err(SHARED.to_owned()));
    // Rewinding the conversation alone is fine in a shared folder.
    let conversation = Check {
        restore_files: false,
        ..shared
    };
    assert!(conversation.run(&runs, "codex").is_ok());
    assert!(
        check(2).run(&runs, "codex").is_err(),
        "an undone run's checkpoint is stale"
    );
    assert!(check(3).run(&runs, "codex").is_err(), "no run 3");
    let mut failed = run(1, Completed, 0, 10);
    failed.checkpoint.as_mut().unwrap().status = CheckpointStatus::Error;
    assert!(check(1).run(&[failed], "codex").is_err());
    let running = vec![run(1, Completed, 0, 10), run(2, Running, 20, 30)];
    assert!(check(1).run(&running, "codex").is_err());
}
