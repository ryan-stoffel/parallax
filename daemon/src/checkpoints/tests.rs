use jiff::Timestamp;
use parallax_protocol::{CheckpointStatus, ThreadRun, ThreadRunStatus, TurnCheckpoint, TurnId};

use super::{Check, SHARED};
use crate::backend::Capabilities;

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
        cursor: None,
        session_id: None,
    }
}

fn check(ordinal: u32) -> Check {
    Check {
        ordinal,
        restore_files: true,
        capabilities: Capabilities {
            rewind: true,
            ..Capabilities::default()
        },
        isolated: true,
        session_id: Some("session".to_owned()),
        forked: false,
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
    let (turns, undone) = check(1).run(&runs).unwrap();
    assert_eq!(turns, 2);
    assert_eq!(undone, [runs[1].id, runs[2].id, runs[4].id]);
    // To the thread's start, every run that wasn't undone already goes.
    assert_eq!(check(0).run(&runs).unwrap().0, 3);
    // To the newest checkpoint, nothing does.
    assert_eq!(check(5).run(&runs).unwrap(), (0, Vec::new()));
}

#[test]
fn a_revert_is_refused_before_anything_changes() {
    use ThreadRunStatus::{Completed, RolledBack, Running};
    let runs = vec![run(1, Completed, 0, 10), run(2, RolledBack, 20, 30)];
    let no_rewind = Check {
        capabilities: Capabilities::default(),
        ..check(1)
    };
    assert_eq!(
        no_rewind.run(&runs),
        Err("This provider does not support reverting conversation history. Start a new thread instead.".to_owned())
    );
    let shared = Check {
        isolated: false,
        ..check(1)
    };
    assert_eq!(shared.run(&runs), Err(SHARED.to_owned()));
    // Rewinding the conversation alone is fine in a shared folder.
    let conversation = Check {
        restore_files: false,
        ..shared
    };
    assert!(conversation.run(&runs).is_ok());
    assert!(
        check(2).run(&runs).is_err(),
        "an undone run's checkpoint is stale"
    );
    assert!(check(3).run(&runs).is_err(), "no run 3");
    let mut failed = run(1, Completed, 0, 10);
    failed.checkpoint.as_mut().unwrap().status = CheckpointStatus::Error;
    assert!(check(1).run(&[failed]).is_err());
    let running = vec![run(1, Completed, 0, 10), run(2, Running, 20, 30)];
    assert!(check(1).run(&running).is_err());
}

#[test]
fn a_boundary_inside_a_native_turn_group_is_refused() {
    use ThreadRunStatus::Completed;
    for later in [false, true] {
        let mut runs = vec![run(1, Completed, 0, 10), run(2, Completed, 5, 11)];
        if later {
            runs.push(run(3, Completed, 20, 30));
        }
        for restore_files in [false, true] {
            let boundary = Check {
                restore_files,
                ..check(1)
            };
            assert_eq!(
                boundary.run(&runs),
                Err("This checkpoint is inside a turn that includes a steered message. Revert to before that turn or after all its messages instead.".to_owned())
            );
        }
        // Whole-group boundaries still count one native turn for the overlapping runs.
        assert_eq!(check(0).run(&runs).unwrap().0, if later { 2 } else { 1 });
        assert_eq!(check(2).run(&runs).unwrap().0, u32::from(later));
    }
}

#[test]
fn a_cursor_backend_reverts_only_to_a_turn_of_its_session_with_a_cursor() {
    use ThreadRunStatus::Completed;
    let mut runs = vec![
        run(1, Completed, 0, 10),
        run(2, Completed, 20, 30),
        run(3, Completed, 40, 50),
        run(4, Completed, 60, 70),
    ];
    // Turn 1 ended before plxd kept cursors. Turn 2 ran in an earlier session, before the
    // thread moved to another provider (turn 3) and back.
    runs[1].cursor = Some("entry-2".to_owned());
    runs[1].session_id = Some("earlier".to_owned());
    runs[3].cursor = Some("entry-4".to_owned());
    runs[3].session_id = Some("session".to_owned());
    let claude = |ordinal| Check {
        capabilities: Capabilities {
            rewind: true,
            resume_at: true,
            ..Capabilities::default()
        },
        ..check(ordinal)
    };
    assert_eq!(
        claude(1).run(&runs),
        Err("Parallax didn't record where the conversation stood after turn 1, so it can't go back there. Edit from a later turn instead, or start a new thread.".to_owned())
    );
    assert_eq!(
        claude(2).run(&runs),
        Err("Turn 2 ran in an earlier session, before this thread moved between providers, so the conversation can't go back there. Edit from a later turn instead, or start a new thread.".to_owned())
    );
    assert!(claude(4).run(&runs).is_ok());
    // The thread's start needs no cursor, and a backend without cursors never does.
    assert!(claude(0).run(&runs).is_ok());
    assert!(check(1).run(&runs).is_ok());
    assert!(check(2).run(&runs).is_ok());
    // A fork's start is its parent's conversation, which a new session would lose.
    let fork = Check {
        forked: true,
        ..claude(0)
    };
    assert_eq!(
        fork.run(&runs),
        Err("A fork's conversation can't go back to before its own turns. Edit from a later turn instead, or fork the thread again.".to_owned())
    );
}
