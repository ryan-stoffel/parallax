use std::path::Path;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use parallax_protocol::{PrAction, PrMergeMethod, PrReviewEvent, PrWrite};
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::{BUDGET, Failed, GAP, QUEUE_WAIT, act_args, commands, paced};
use crate::pr_media::{Limit, limit};
use crate::worktree::PrError;

const SECONDARY: &str = "`gh pr comment` failed: HTTP 403: You have exceeded a secondary rate limit (https://api.github.com/graphql)";

/// Two writes sent at once run one after the other, the second at least [`GAP`] after the first
/// ended.
#[tokio::test(start_paused = true)]
async fn writes_run_one_at_a_time_a_second_apart() {
    let queue = Mutex::new(None);
    let runs = StdMutex::new(Vec::new());
    let write = || async {
        let start = Instant::now();
        tokio::time::sleep(Duration::from_millis(300)).await;
        runs.lock().unwrap().push((start, Instant::now()));
        Ok::<_, PrError>(String::new())
    };
    let deadline = Instant::now() + BUDGET;
    let (first, second) = tokio::join!(
        paced(&queue, deadline, write),
        paced(&queue, deadline, write)
    );
    assert!(first.is_ok() && second.is_ok());
    let runs = runs.lock().unwrap().clone();
    assert_eq!(runs.len(), 2);
    assert!(
        runs[1].0 >= runs[0].1 + GAP,
        "the second started {:?} after the first ended",
        runs[1].0 - runs[0].1
    );

    // A write long after the last one doesn't wait.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let before = Instant::now();
    paced(&queue, Instant::now() + BUDGET, write).await.unwrap();
    assert_eq!(Instant::now() - before, Duration::from_millis(300));
}

/// A secondary limit backs off and tries again; one that outlasts the budget fails saying so.
#[tokio::test(start_paused = true)]
async fn a_secondary_limit_backs_off_within_the_budget() {
    let queue = Mutex::new(None);
    let tries = StdMutex::new(0);
    let start = Instant::now();
    let answer = paced(&queue, start + BUDGET, || async {
        let mut tries = tries.lock().unwrap();
        *tries += 1;
        if *tries == 1 {
            Err(PrError::Gh(SECONDARY.to_owned()))
        } else {
            Ok("done".to_owned())
        }
    })
    .await;
    assert_eq!(answer.unwrap(), "done");
    assert_eq!(*tries.lock().unwrap(), 2);
    assert_eq!(Instant::now() - start, Duration::from_secs(10));

    // With 25 s left after this write's turn, the 10 s wait fits and the 20 s one doesn't.
    tokio::time::sleep(GAP).await;
    let start = Instant::now();
    let tries = StdMutex::new(0);
    let answer = paced(&queue, start + Duration::from_secs(25), || async {
        *tries.lock().unwrap() += 1;
        Err::<String, _>(PrError::Gh(SECONDARY.to_owned()))
    })
    .await;
    assert!(matches!(answer, Err(Failed::Secondary(_))), "{answer:?}");
    assert_eq!(*tries.lock().unwrap(), 2);
    assert_eq!(Instant::now() - start, Duration::from_secs(10));
}

/// Any other failure comes back at once, untried.
#[tokio::test(start_paused = true)]
async fn other_failures_are_not_retried() {
    let queue = Mutex::new(None);
    let tries = StdMutex::new(0);
    let answer = paced(&queue, Instant::now() + BUDGET, || async {
        *tries.lock().unwrap() += 1;
        Err::<String, _>(PrError::GhUnavailable("not signed in".to_owned()))
    })
    .await;
    assert!(matches!(answer, Err(Failed::Gh(PrError::GhUnavailable(_)))));
    assert_eq!(*tries.lock().unwrap(), 1);
}

/// A write that can't get its turn within [`QUEUE_WAIT`] fails as busy instead of waiting on.
#[tokio::test(start_paused = true)]
async fn a_busy_queue_fails_after_the_wait() {
    let queue = Mutex::new(None);
    let held = queue.lock().await;
    let start = Instant::now();
    let answer = paced(&queue, start + BUDGET, || async {
        Ok::<_, PrError>(String::new())
    })
    .await;
    assert!(matches!(answer, Err(Failed::Busy)));
    assert_eq!(Instant::now() - start, QUEUE_WAIT);
    drop(held);
}

#[test]
fn a_comment_submitted_too_quickly_is_a_secondary_limit() {
    assert_eq!(
        limit("GraphQL: was submitted too quickly (addComment)"),
        Some(Limit::Secondary)
    );
}

#[test]
fn each_write_becomes_gh_commands_with_the_body_in_a_file() {
    let url = "https://github.com/me/app/pull/7";
    let file = Path::new("/tmp/body.md");
    let commands = |write| commands(url, write, file);
    let text = |text: &str| Some(text.to_owned());

    let (steps, body) = commands(PrWrite::Comment {
        body: "--looks like a flag".to_owned(),
    })
    .unwrap();
    assert_eq!(steps, [["pr", "comment", url, "--body-file=/tmp/body.md"]]);
    assert_eq!(body, text("--looks like a flag"));

    let (steps, body) = commands(PrWrite::Review {
        event: PrReviewEvent::RequestChanges,
        body: "Verdict: changes needed".to_owned(),
    })
    .unwrap();
    assert_eq!(
        steps,
        [[
            "pr",
            "review",
            url,
            "--request-changes",
            "--body-file=/tmp/body.md"
        ]]
    );
    assert_eq!(body, text("Verdict: changes needed"));
    let (steps, body) = commands(PrWrite::Review {
        event: PrReviewEvent::Approve,
        body: String::new(),
    })
    .unwrap();
    assert_eq!(steps, [["pr", "review", url, "--approve"]]);
    assert_eq!(body, None);

    // Empty bodies GitHub would refuse are refused before the queue.
    for write in [
        PrWrite::Comment {
            body: " ".to_owned(),
        },
        PrWrite::Review {
            event: PrReviewEvent::Comment,
            body: String::new(),
        },
        PrWrite::Review {
            event: PrReviewEvent::RequestChanges,
            body: "\n".to_owned(),
        },
        PrWrite::Review {
            event: PrReviewEvent::Unknown,
            body: "x".to_owned(),
        },
        PrWrite::Edit {
            title: None,
            body: None,
        },
        PrWrite::ReplyToThread {
            review_thread_id: "PRRT_1".to_owned(),
            body: None,
            resolve: false,
        },
    ] {
        assert!(commands(write.clone()).is_err(), "{write:?}");
    }

    let (steps, body) = commands(PrWrite::Edit {
        title: text("New"),
        body: text(""),
    })
    .unwrap();
    assert_eq!(
        steps,
        [["pr", "edit", url, "--title=New", "--body-file=/tmp/body.md"]]
    );
    assert_eq!(body, text(""), "an empty body clears it");

    // A reply then a resolve are two steps, so a failed resolve can be retried alone.
    let (steps, body) = commands(PrWrite::ReplyToThread {
        review_thread_id: "PRRT_1".to_owned(),
        body: text("Done."),
        resolve: true,
    })
    .unwrap();
    assert_eq!(steps.len(), 2);
    assert!(steps[0][3].contains("addPullRequestReviewThreadReply"));
    assert_eq!(
        steps[0][4..],
        ["-f", "thread=PRRT_1", "-F", "body=@/tmp/body.md"]
    );
    assert!(steps[1][3].contains("resolveReviewThread"));
    assert_eq!(steps[1][4..], ["-f", "thread=PRRT_1"]);
    assert_eq!(body, text("Done."));
    let (steps, _) = commands(PrWrite::ReplyToThread {
        review_thread_id: "PRRT_1".to_owned(),
        body: None,
        resolve: true,
    })
    .unwrap();
    assert_eq!(steps.len(), 1);
    assert!(steps[0][3].contains("resolveReviewThread"));
}

#[test]
fn deleting_a_branch_names_it_in_its_own_repository() {
    let params = parallax_protocol::PrActParams {
        run_id: parallax_protocol::RunId::generate(),
        url: "https://github.com/me/app/pull/7".to_owned(),
        action: PrAction::DeleteBranch,
        method: None,
        delete_branch: false,
        head_sha: None,
        workflow_run_id: None,
        job_id: None,
    };
    let head = Some(("fork/app".to_owned(), "feature/a b#1".to_owned()));
    assert_eq!(
        act_args(&params, head).unwrap(),
        [
            "api",
            "-X",
            "DELETE",
            "repos/fork/app/git/refs/heads/feature/a%20b%231"
        ],
        "a fork's branch is deleted from the fork, its name escaped"
    );
    let unknown = parallax_protocol::PrActParams {
        action: PrAction::AutoMerge,
        method: Some(PrMergeMethod::Unknown),
        ..params
    };
    assert!(act_args(&unknown, None).is_err());
}
