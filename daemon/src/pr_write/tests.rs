use std::path::Path;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use parallax_protocol::{PrAction, PrDiffSide, PrMergeMethod, PrReviewEvent, PrWrite};
use tokio::sync::Mutex;
use tokio::time::Instant;

use super::{BUDGET, Failed, GAP, QUEUE_WAIT, act_args, commands, paced, refusal};
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
        ..params.clone()
    };
    assert!(act_args(&unknown, None).is_err());
    let auto = parallax_protocol::PrActParams {
        action: PrAction::AutoMerge,
        method: Some(PrMergeMethod::Squash),
        head_sha: Some("abc1234".to_owned()),
        ..params
    };
    assert_eq!(
        act_args(&auto, None).unwrap(),
        [
            "pr",
            "merge",
            "https://github.com/me/app/pull/7",
            "--auto",
            "--squash",
            "--match-head-commit=abc1234"
        ],
        "auto-merge is pinned to the head the user saw"
    );
}

/// Viewed goes to `markFileAsViewed` or `unmarkFileAsViewed` with GraphQL variables, so a path that
/// starts with `-` or `@` is only ever a value.
#[test]
fn viewed_marks_and_unmarks_a_file_with_graphql_variables() {
    let args = |viewed| {
        let write = PrWrite::SetFileViewed {
            pull_request_id: "PR_1".to_owned(),
            path: "@odd/-path.rs".to_owned(),
            viewed,
        };
        let (steps, body) = commands(
            "https://github.com/me/app/pull/7",
            write,
            Path::new("/tmp/body"),
        )
        .unwrap();
        assert_eq!(body, None);
        assert_eq!(steps.len(), 1);
        steps.into_iter().next().unwrap()
    };
    let marked = args(true);
    assert!(marked[3].contains("markFileAsViewed"), "{marked:?}");
    assert_eq!(marked[5], "pr=PR_1");
    assert_eq!(marked[6], "-f");
    assert_eq!(marked[7], "path=@odd/-path.rs");
    assert!(args(false)[3].contains("unmarkFileAsViewed"));
}

const PR: &str = "https://github.com/me/app/pull/7";

/// The one step `write` makes, and the body it reads from its file.
fn one_step(write: PrWrite) -> (Vec<String>, Option<String>) {
    let (mut steps, body) = commands(PR, write, Path::new("/tmp/body")).unwrap();
    assert_eq!(steps.len(), 1);
    (steps.remove(0), body)
}

/// The value after the flag that sets `name`, as `-f name=value` or `-F name=value`.
fn field<'a>(step: &'a [String], name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    step.iter()
        .find_map(|arg| arg.strip_prefix(prefix.as_str()))
}

fn comment(line: Option<u64>, start_line: Option<u64>, side: Option<PrDiffSide>) -> PrWrite {
    PrWrite::AddReviewComment {
        pull_request_id: "PR_1".to_owned(),
        path: "src/main.rs".to_owned(),
        body: "Why?".to_owned(),
        line,
        start_line,
        side,
        head_sha: None,
    }
}

#[test]
fn a_review_comment_goes_to_the_pending_review_with_its_range_and_side() {
    let (step, body) = one_step(comment(Some(14), Some(12), Some(PrDiffSide::Left)));
    assert_eq!(body.as_deref(), Some("Why?"));
    assert!(
        field(&step, "query")
            .unwrap()
            .contains("addPullRequestReviewThread")
    );
    assert_eq!(field(&step, "pr"), Some("PR_1"));
    assert_eq!(field(&step, "path"), Some("src/main.rs"));
    assert_eq!(field(&step, "body"), Some("@/tmp/body"));
    assert_eq!(field(&step, "subject"), Some("LINE"));
    assert_eq!(field(&step, "line"), Some("14"));
    assert_eq!(field(&step, "side"), Some("LEFT"));
    assert_eq!(field(&step, "startLine"), Some("12"));
    assert_eq!(field(&step, "startSide"), Some("LEFT"));
}

#[test]
fn a_review_comment_with_no_side_is_on_the_new_side_and_with_no_line_on_the_file() {
    let (step, _) = one_step(comment(Some(14), None, None));
    assert_eq!(field(&step, "side"), Some("RIGHT"));
    assert_eq!(field(&step, "startLine"), None);
    let (step, _) = one_step(comment(None, None, None));
    assert_eq!(field(&step, "subject"), Some("FILE"));
    assert_eq!(field(&step, "line"), None);
    assert_eq!(field(&step, "side"), None);
}

#[test]
fn a_single_comment_posts_at_once_on_the_head_commit() {
    let single = |line| PrWrite::AddReviewComment {
        pull_request_id: "PR_1".to_owned(),
        path: "src/main.rs".to_owned(),
        body: "Why?".to_owned(),
        line,
        start_line: None,
        side: Some(PrDiffSide::Right),
        head_sha: Some("abc123".to_owned()),
    };
    let (step, _) = one_step(single(Some(14)));
    assert!(step.contains(&"repos/me/app/pulls/7/comments".to_owned()));
    assert_eq!(field(&step, "commit_id"), Some("abc123"));
    assert_eq!(field(&step, "line"), Some("14"));
    assert_eq!(field(&step, "side"), Some("RIGHT"));
    assert_eq!(field(&step, "subject_type"), None);
    let (step, _) = one_step(single(None));
    assert_eq!(field(&step, "subject_type"), Some("file"));
}

#[test]
fn an_empty_review_comment_or_a_range_with_no_end_is_refused() {
    let empty = PrWrite::AddReviewComment {
        pull_request_id: "PR_1".to_owned(),
        path: "a".to_owned(),
        body: "  ".to_owned(),
        line: Some(1),
        start_line: None,
        side: None,
        head_sha: None,
    };
    assert!(commands(PR, empty, Path::new("/tmp/body")).is_err());
    assert!(commands(PR, comment(None, Some(1), None), Path::new("/tmp/body")).is_err());
}

#[test]
fn a_pending_comment_is_edited_and_deleted_by_its_id() {
    let (step, body) = one_step(PrWrite::EditReviewComment {
        comment_id: "PRRC_1".to_owned(),
        body: "Better".to_owned(),
    });
    assert!(
        field(&step, "query")
            .unwrap()
            .contains("updatePullRequestReviewComment")
    );
    assert_eq!(field(&step, "comment"), Some("PRRC_1"));
    assert_eq!(body.as_deref(), Some("Better"));
    let (step, body) = one_step(PrWrite::DeleteReviewComment {
        comment_id: "PRRC_1".to_owned(),
    });
    assert!(
        field(&step, "query")
            .unwrap()
            .contains("deletePullRequestReviewComment")
    );
    assert_eq!(body, None);
}

#[test]
fn a_pending_review_is_submitted_with_its_verdict_or_discarded() {
    let submit = |event| PrWrite::SubmitReview {
        review_id: "PRR_1".to_owned(),
        event,
        body: String::new(),
    };
    for (event, name) in [
        (PrReviewEvent::Comment, "COMMENT"),
        (PrReviewEvent::Approve, "APPROVE"),
        (PrReviewEvent::RequestChanges, "REQUEST_CHANGES"),
    ] {
        let (step, _) = one_step(submit(event));
        assert!(
            field(&step, "query")
                .unwrap()
                .contains("submitPullRequestReview")
        );
        assert_eq!(field(&step, "review"), Some("PRR_1"));
        assert_eq!(field(&step, "event"), Some(name));
    }
    assert!(commands(PR, submit(PrReviewEvent::Unknown), Path::new("/tmp/body")).is_err());
    let (step, _) = one_step(PrWrite::DiscardReview {
        review_id: "PRR_1".to_owned(),
    });
    assert!(
        field(&step, "query")
            .unwrap()
            .contains("deletePullRequestReview")
    );
}

/// GitHub answers a line outside the diff with a null thread and no error.
#[test]
fn a_null_thread_is_a_refusal() {
    let null = r#"{"data":{"addPullRequestReviewThread":{"thread":null}}}"#;
    assert!(refusal(null).is_some());
    let taken = r#"{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_1"}}}}"#;
    assert!(refusal(taken).is_none());
    assert!(refusal("").is_none());
}
