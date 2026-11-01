use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

use jiff::{SignedDuration, Timestamp};

use super::{
    Change, Check, CheckState, Detail, Merging, Remark, Watch, Watches, blockers, evaluate, judged,
    message, parse, try_merge, verdict, viewed,
};
use crate::pr_write::Refusal;
use parallax_protocol::{
    PrCheckState, PrCommentKind, PrMergeMethod, PrMergeState, PrReviewDecision, PrReviewState,
    PrState, PrStatusCheck, PrStatusFile, PrStatusThread,
};

fn start() -> Timestamp {
    "2026-10-09T10:00:00Z".parse().unwrap()
}

fn check(name: &str, state: CheckState, required: bool) -> Check {
    Check {
        name: name.to_owned(),
        state,
        required,
        url: None,
        run_id: None,
    }
}

fn remark(id: &str, author: &str, minutes: i64) -> Remark {
    Remark {
        id: id.to_owned(),
        author: Some(author.to_owned()),
        body: format!("comment {id}"),
        at: start() + SignedDuration::from_mins(minutes),
        url: None,
        path: None,
        review: None,
    }
}

fn open(checks: Vec<Check>, remarks: Vec<Remark>, mergeable: &str) -> Detail {
    Detail {
        state: "OPEN".to_owned(),
        head_sha: Some("abc1234def".to_owned()),
        base_branch: "develop".to_owned(),
        checks,
        mergeable: mergeable.to_owned(),
        viewer: Some("agent-bot".to_owned()),
        author: Some("ryan".to_owned()),
        remarks,
        ..Detail::default()
    }
}

/// The watch after a first quiet read of the head with `checks` pending.
fn seen(checks: &[Check]) -> Watch {
    let first = evaluate(
        &Watch::new(start()),
        &open(checks.to_vec(), Vec::new(), "MERGEABLE"),
    );
    assert!(first.changes.is_empty(), "{:?}", first.changes);
    first.next
}

#[test]
fn a_check_that_fails_wakes_once_and_a_rerun_that_fails_again_wakes_again() {
    let pending = [check("lint", CheckState::Pending, true)];
    let watch = seen(&pending);
    let failed = vec![check("lint", CheckState::Failed("failure"), true)];
    let report = evaluate(&watch, &open(failed.clone(), Vec::new(), "MERGEABLE"));
    assert_eq!(report.changes, [Change::ChecksFailed(failed.clone())]);
    let again = evaluate(&report.next, &open(failed.clone(), Vec::new(), "MERGEABLE"));
    assert!(again.changes.is_empty(), "told already");
    let rerun = evaluate(
        &again.next,
        &open(pending.to_vec(), Vec::new(), "MERGEABLE"),
    );
    let refailed = evaluate(&rerun.next, &open(failed.clone(), Vec::new(), "MERGEABLE"));
    assert_eq!(refailed.changes, [Change::ChecksFailed(failed)]);
}

#[test]
fn only_someone_elses_new_comments_wake() {
    let watch = seen(&[]);
    let remarks = vec![
        remark("old", "reviewer", -5),
        remark("own", "agent-bot", 1),
        remark("new", "reviewer", 2),
    ];
    let report = evaluate(&watch, &open(Vec::new(), remarks.clone(), "MERGEABLE"));
    assert_eq!(report.changes, [Change::Remarks(vec![remarks[2].clone()])]);
    assert_eq!(report.next.wakes, 1);
    let quiet = evaluate(
        &report.next,
        &open(Vec::new(), remarks.clone(), "MERGEABLE"),
    );
    assert!(quiet.changes.is_empty(), "told already");

    // Another at the same second is told apart by its id; an edit counts as new.
    let mut more = remarks;
    more.push(remark("same-second", "reviewer", 2));
    let mut edited = remark("old", "reviewer", 3);
    edited.body = "edited".to_owned();
    more.push(edited.clone());
    let report = evaluate(&quiet.next, &open(Vec::new(), more, "MERGEABLE"));
    let Change::Remarks(told) = &report.changes[0] else {
        panic!("{:?}", report.changes);
    };
    let ids: Vec<&str> = told.iter().map(|remark| remark.id.as_str()).collect();
    assert_eq!(ids, ["same-second", "old"]);
}

/// GitHub's answer to `QUERY` for a pull request with a bit of everything.
const ANSWER: &str = r#"{"data": {
      "viewer": {"login": "agent-bot"},
      "repository": {"pullRequest": {
        "title": "Add a thing", "body": "Adds it.\n\nLinear: PLX-1",
        "state": "OPEN", "author": {"login": "ryan"}, "baseRefName": "develop",
        "headRefName": "feature/PLX-1-thing", "headRefOid": "abc1234def",
        "mergeable": "CONFLICTING", "isDraft": false,
        "mergeStateStatus": "DIRTY", "reviewDecision": "CHANGES_REQUESTED",
        "files": {"nodes": [{"path": "src/main.rs", "additions": 3, "deletions": 1}]},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
          {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE",
           "detailsUrl": "https://ci/1", "isRequired": true,
           "checkSuite": {"workflowRun": {"databaseId": 42}}},
          {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": null,
           "detailsUrl": null, "isRequired": false, "checkSuite": {"workflowRun": null}},
          {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS",
           "targetUrl": null, "isRequired": false},
          null
        ]}}}}]},
        "comments": {"nodes": [{"id": "c1", "author": {"login": "reviewer"}, "body": "Looks good",
          "createdAt": "2026-10-09T10:05:00Z", "lastEditedAt": null, "url": "https://gh/c1"}]},
        "reviews": {"nodes": [
          {"id": "r1", "author": {"login": "reviewer"}, "body": "", "state": "COMMENTED",
           "submittedAt": "2026-10-09T10:06:00Z", "lastEditedAt": null, "url": null},
          {"id": "r2", "author": {"login": "reviewer"}, "body": "", "state": "CHANGES_REQUESTED",
           "submittedAt": "2026-10-09T10:07:00Z", "lastEditedAt": null, "url": null}
        ]},
        "reviewThreads": {"nodes": [
          {"id": "th1", "path": "src/main.rs", "isResolved": false, "comments": {"nodes": [
            {"id": "t1", "author": null, "body": "nit", "createdAt": "2026-10-09T10:04:00Z",
             "lastEditedAt": "2026-10-09T10:08:00Z", "url": null}
          ]}},
          {"id": "th2", "path": "src/lib.rs", "isResolved": true, "comments": {"nodes": [
            {"id": "t2", "author": {"login": "reviewer"}, "body": "done", "createdAt":
             "2026-10-09T10:03:00Z", "lastEditedAt": null, "url": null}
          ]}}
        ]}
      }}
    }}"#;

#[test]
fn githubs_answer_reads_into_a_detail() {
    let detail = parse(ANSWER).unwrap();
    assert_eq!(detail.state, "OPEN");
    assert_eq!(detail.title, "Add a thing");
    assert_eq!(detail.body, "Adds it.\n\nLinear: PLX-1");
    assert_eq!(detail.head_branch, "feature/PLX-1-thing");
    assert_eq!(
        detail.files,
        [PrStatusFile {
            path: "src/main.rs".to_owned(),
            additions: 3,
            deletions: 1,
        }]
    );
    assert_eq!(detail.viewer.as_deref(), Some("agent-bot"));
    assert_eq!(detail.mergeable, "CONFLICTING");
    assert_eq!(
        detail.checks,
        [
            Check {
                name: "lint".to_owned(),
                state: CheckState::Failed("failure"),
                required: true,
                url: Some("https://ci/1".to_owned()),
                run_id: Some(42),
            },
            check("test", CheckState::Pending, false),
            check("deploy", CheckState::Passed, false),
        ]
    );
    let ids: Vec<&str> = detail
        .remarks
        .iter()
        .map(|remark| remark.id.as_str())
        .collect();
    assert_eq!(
        ids,
        ["t2", "c1", "r2", "t1"],
        "oldest first; an empty COMMENTED review is skipped"
    );
    assert_eq!(detail.remarks[3].path.as_deref(), Some("src/main.rs"));
    assert_eq!(detail.merge_state, "DIRTY");
    assert_eq!(detail.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
    assert_eq!(
        detail.unresolved,
        [PrStatusThread {
            id: Some("th1".to_owned()),
            path: Some("src/main.rs".to_owned()),
            author: None,
            body: "nit".to_owned(),
            url: None,
        }],
        "a resolved thread is left out"
    );

    let report = evaluate(&Watch::new(start()), &detail);
    let text = message("https://github.com/me/app/pull/1", &detail, &report);
    assert!(
        text.contains("- Checks failed on abc1234:\n  - lint https://ci/1"),
        "{text}"
    );
    assert!(text.contains("  - reviewer: changes_requested"), "{text}");
    assert!(
        text.contains("  - someone on src/main.rs: \"nit\""),
        "{text}"
    );
    assert!(
        text.contains("- The branch now conflicts with develop."),
        "{text}"
    );

    let error =
        parse(r#"{"data": null, "errors": [{"message": "API rate limit exceeded"}]}"#).unwrap_err();
    assert!(error.to_string().contains("rate limit"));
}

#[test]
fn a_pull_request_is_ready_only_when_nothing_holds_it_back() {
    let url = "https://github.com/me/app/pull/1".to_owned();
    let green = vec![Check {
        url: Some("https://ci/2".to_owned()),
        run_id: Some(7),
        ..check("lint", CheckState::Passed, true)
    }];
    let mut detail = open(green.clone(), Vec::new(), "MERGEABLE");
    detail.title = "Add a thing".to_owned();
    detail.head_branch = "feature/PLX-1-thing".to_owned();
    let ready = verdict(url.clone(), detail, 0, true);
    assert!(ready.ready, "{:?}", ready.reasons);
    assert!(ready.watching);
    assert_eq!(ready.title.as_deref(), Some("Add a thing"));
    assert_eq!(ready.body, None, "an empty body is left out");
    assert_eq!(ready.head_branch.as_deref(), Some("feature/PLX-1-thing"));
    assert_eq!(ready.passed, ["lint"]);
    assert_eq!(
        ready.checks,
        [PrStatusCheck {
            name: "lint".to_owned(),
            how: "passed".to_owned(),
            required: true,
            url: Some("https://ci/2".to_owned()),
            run_id: Some(7),
        }]
    );

    let mut held = open(
        vec![
            check("test", CheckState::Pending, false),
            Check {
                url: Some("https://ci/1".to_owned()),
                ..check("lint", CheckState::Failed("timed out"), true)
            },
        ],
        Vec::new(),
        "CONFLICTING",
    );
    held.draft = true;
    held.review_decision = Some("CHANGES_REQUESTED".to_owned());
    held.unresolved = vec![PrStatusThread {
        id: Some("th1".to_owned()),
        path: None,
        author: None,
        body: "nit".to_owned(),
        url: None,
    }];
    let held = verdict(url.clone(), held, 1, false);
    assert!(!held.ready);
    assert_eq!(
        held.reasons,
        [
            "it is a draft",
            "it conflicts with develop",
            "1 commit behind develop",
            "failing: lint",
            "pending: test",
            "1 unresolved review thread",
            "changes requested",
        ]
    );
    assert_eq!(
        held.failing,
        [PrStatusCheck {
            name: "lint".to_owned(),
            how: "timed out".to_owned(),
            required: true,
            url: Some("https://ci/1".to_owned()),
            run_id: None,
        }]
    );

    // Right after a push the head has no checks yet: that is not green.
    let fresh = verdict(
        url.clone(),
        open(Vec::new(), Vec::new(), "UNKNOWN"),
        0,
        false,
    );
    assert_eq!(
        fresh.reasons,
        [
            "GitHub is still working out whether it conflicts",
            "no checks have reported on its head yet",
        ]
    );

    let mut merged = open(green, Vec::new(), "UNKNOWN");
    merged.state = "MERGED".to_owned();
    assert_eq!(verdict(url, merged, 0, false).reasons, ["it is merged"]);
}

#[test]
fn a_read_serves_every_read_of_its_pull_request_for_thirty_seconds() {
    let url = "https://github.com/me/app/pull/1";
    let watches = Watches::default();
    let at = Instant::now();
    watches.share(url, at, &open(Vec::new(), Vec::new(), "MERGEABLE"));

    let later = at + Duration::from_secs(29);
    assert!(watches.shared(url, later).is_some());
    assert!(
        watches
            .shared("https://github.com/me/app/pull/2", later)
            .is_none()
    );
    assert!(watches.shared(url, at + Duration::from_secs(30)).is_none());

    // A status's comparison sticks to the read it compared, and not to a newer head's.
    watches.compared(url, "abc1234def", Ok(2));
    assert_eq!(watches.shared(url, later).unwrap().compared, Some(Ok(2)));
    watches.compared(url, "pushed", Ok(5));
    assert_eq!(watches.shared(url, later).unwrap().compared, Some(Ok(2)));

    // A read that started earlier but finished later doesn't replace a newer one.
    let mut older = open(Vec::new(), Vec::new(), "MERGEABLE");
    older.head_sha = Some("older".to_owned());
    let before = at.checked_sub(Duration::from_secs(1)).unwrap();
    watches.share(url, before, &older);
    assert_eq!(
        watches.shared(url, later).unwrap().head_sha.as_deref(),
        Some("abc1234def")
    );

    // A newer read drops ones too old to share.
    let next = at + Duration::from_secs(31);
    watches.share("https://github.com/me/app/pull/2", next, &Detail::default());
    assert!(!watches.reads().contains_key(url));
}

#[tokio::test]
async fn a_shared_read_never_answers_ready() {
    let url = "https://github.com/me/app/pull/1";
    let green = open(
        vec![check("lint", CheckState::Passed, true)],
        Vec::new(),
        "MERGEABLE",
    );
    // Pushed since the shared read: a new head with no checks yet.
    let mut pushed = green.clone();
    pushed.head_sha = Some("pushed".to_owned());
    pushed.checks.clear();
    let reads = Cell::new(0);
    let fetch = |detail: Detail| {
        let reads = &reads;
        move || {
            reads.set(reads.get() + 1);
            async move { Ok::<_, ()>(detail) }
        }
    };
    let judge = move |detail: Detail| async move { Ok(verdict(url.to_owned(), detail, 0, false)) };

    let result = judged(Some(green.clone()), fetch(pushed.clone()), judge)
        .await
        .unwrap();
    assert!(!result.ready, "judged from the fresh read");
    assert_eq!(result.head_sha.as_deref(), Some("pushed"));
    assert_eq!(reads.get(), 1);

    // A shared read that isn't ready answers alone, and no shared read means one read.
    let result = judged(Some(pushed.clone()), fetch(green.clone()), judge)
        .await
        .unwrap();
    assert!(!result.ready);
    assert_eq!(reads.get(), 1);
    let result = judged(None, fetch(green), judge).await.unwrap();
    assert!(result.ready);
    assert_eq!(reads.get(), 2);
}

#[test]
fn a_field_github_cant_answer_leaves_the_rest_of_the_read() {
    let partial = ANSWER
        .replace(
            r#""checkSuite": {"workflowRun": {"databaseId": 42}}"#,
            r#""checkSuite": {"workflowRun": {"databaseId": null}}"#,
        )
        .replace(
            r#""files": {"nodes": [{"path": "src/main.rs", "additions": 3, "deletions": 1}]}"#,
            r#""files": null"#,
        );
    let partial = format!(
        r#"{}, "errors": [{{"message": "Resource not accessible by integration"}}]}}"#,
        partial.trim_end().strip_suffix('}').unwrap()
    );
    let detail = parse(&partial).unwrap();
    assert_eq!(detail.title, "Add a thing");
    assert!(detail.files.is_empty());
    assert_eq!(detail.checks[0].run_id, None);

    let error = parse(
        r#"{"data": {"viewer": null, "repository": {"pullRequest": null}},
            "errors": [{"message": "Could not resolve to a PullRequest"}]}"#,
    )
    .unwrap_err();
    assert!(error.to_string().contains("Could not resolve"), "{error}");
}

#[tokio::test]
async fn merge_when_ready_waits_for_green() {
    let url = "https://github.com/me/app/pull/1";
    let green = Detail {
        merge_state: "CLEAN".to_owned(),
        ..open(
            vec![check("lint", CheckState::Passed, true)],
            Vec::new(),
            "MERGEABLE",
        )
    };
    assert!(blockers(url, &green).is_empty());
    let held = |change: fn(&mut Detail)| {
        let mut detail = green.clone();
        change(&mut detail);
        blockers(url, &detail)
    };
    assert_eq!(
        held(|d| d.checks.push(check("test", CheckState::Pending, false))),
        ["pending: test"]
    );
    assert_eq!(
        held(|d| d.checks[0].state = CheckState::Failed("failure")),
        ["failing: lint"]
    );
    assert_eq!(
        held(|d| d.checks.clear()),
        ["no checks have reported on its head yet"]
    );
    assert_eq!(held(|d| d.draft = true), ["it is a draft"]);
    assert_eq!(
        held(|d| d.review_decision = Some("CHANGES_REQUESTED".to_owned())),
        ["changes requested"]
    );
    assert_eq!(
        held(|d| d.mergeable = "CONFLICTING".to_owned()),
        ["it conflicts with develop"]
    );
    // Behind its base holds a merge only where the base requires an up-to-date branch.
    assert!(held(|d| d.compared = Some(Ok(3))).is_empty());
    assert_eq!(
        held(|d| d.merge_state = "BEHIND".to_owned()),
        ["develop requires it to be up to date"]
    );
    assert_eq!(held(|d| d.merge_state = "BLOCKED".to_owned()).len(), 1);

    let mut pending = green.clone();
    pending.checks[0].state = CheckState::Pending;
    let mut pushed = green.clone();
    pushed.head_sha = Some("pushed".to_owned());
    pushed.checks.clear();
    let reads = Cell::new(0);
    let merges = RefCell::new(Vec::<String>::new());
    let fetch = |detail: &Detail| {
        let (reads, detail) = (&reads, detail.clone());
        move || {
            reads.set(reads.get() + 1);
            let detail = detail.clone();
            async move { Ok(detail) }
        }
    };
    let merge = |answer: fn() -> Result<(), Refusal>| {
        let merges = &merges;
        move |head: String| {
            merges.borrow_mut().push(head);
            async move { answer() }
        }
    };

    // Not green: no fresh read, no merge.
    let waiting = try_merge(url, &pending, fetch(&green), merge(|| Ok(()))).await;
    assert_eq!(waiting, Merging::Waiting(vec!["pending: lint".to_owned()]));
    assert_eq!(reads.get(), 0);
    assert!(merges.borrow().is_empty());

    // Green in a shared read, but pushed since: the fresh read decides, and it isn't green.
    let waiting = try_merge(url, &green, fetch(&pushed), merge(|| Ok(()))).await;
    assert!(matches!(waiting, Merging::Waiting(_)), "{waiting:?}");
    assert_eq!(reads.get(), 1);
    assert!(merges.borrow().is_empty());

    // Green in both: merged, pinned to the head the fresh read judged.
    let done = try_merge(url, &green, fetch(&green), merge(|| Ok(()))).await;
    assert_eq!(done, Merging::Merged("abc1234def".to_owned()));
    assert_eq!(*merges.borrow(), ["abc1234def"]);

    let later = || Err(Refusal::Later("secondary rate limit".to_owned()));
    let refused = || Err(Refusal::Final("Pull request is not mergeable".to_owned()));
    let again = try_merge(url, &green, fetch(&green), merge(later)).await;
    assert_eq!(again, Merging::Later);
    let refused = try_merge(url, &green, fetch(&green), merge(refused)).await;
    assert_eq!(
        refused,
        Merging::Refused("Pull request is not mergeable".to_owned())
    );
}

#[tokio::test]
async fn merge_when_ready_tells_a_merge_made_elsewhere_queued_or_unsure() {
    let url = "https://github.com/me/app/pull/1";
    let green = Detail {
        merge_state: "CLEAN".to_owned(),
        ..open(
            vec![check("lint", CheckState::Passed, true)],
            Vec::new(),
            "MERGEABLE",
        )
    };
    let read = |detail: &Detail| {
        let detail = detail.clone();
        move || {
            let detail = detail.clone();
            async move { Ok(detail) }
        }
    };
    let answer = |answer: fn() -> Result<(), Refusal>| move |_: String| async move { answer() };

    // Another run's merge got there first, before this pass merged or as it did.
    let gone = Detail {
        state: "MERGED".to_owned(),
        ..green.clone()
    };
    let first = try_merge(url, &green, read(&gone), answer(|| Ok(()))).await;
    assert_eq!(first, Merging::AlreadyMerged);
    let raced = || {
        Err(Refusal::Final(
            "Pull request #1 was already merged".to_owned(),
        ))
    };
    let raced = try_merge(url, &green, read(&green), answer(raced)).await;
    assert_eq!(raced, Merging::AlreadyMerged);

    // A merge that ran out of time is told by a read after it.
    let unsure = || Err(Refusal::Unsure("timed out".to_owned()));
    let still_open = try_merge(url, &green, read(&green), answer(unsure)).await;
    assert_eq!(still_open, Merging::Later);
    let landed = try_merge(url, &green, read_twice(&green, &gone), answer(unsure)).await;
    assert_eq!(landed, Merging::Merged("abc1234def".to_owned()));

    // A base with a merge queue queues it rather than merging it.
    let queue = Detail {
        merge_queue: true,
        ..green.clone()
    };
    let queued = try_merge(url, &queue, read(&queue), answer(|| Ok(()))).await;
    assert_eq!(queued, Merging::Queued("abc1234def".to_owned()));
}

/// A fetch that reads `first`, then `then` ever after.
fn read_twice(
    first: &Detail,
    then: &Detail,
) -> impl Fn() -> std::future::Ready<Result<Detail, crate::worktree::PrError>> {
    let reads = Cell::new(0);
    let (first, then) = (first.clone(), then.clone());
    move || {
        reads.set(reads.get() + 1);
        std::future::ready(Ok(if reads.get() == 1 {
            first.clone()
        } else {
            then.clone()
        }))
    }
}

/// Jobs behind `needs:` aren't checks until they start, so after the first wave every listed
/// check can pass while the workflow still runs: its check suite holds the merge.
#[tokio::test]
async fn merge_when_ready_waits_for_a_running_workflow() {
    let url = "https://github.com/me/app/pull/1";
    let suites = |status: &str| {
        with_suites(&format!(
            r#"{{"nodes": [
              {{"status": "{status}", "workflowRun": {{"databaseId": 42}}}},
              {{"status": "QUEUED", "workflowRun": null}}
            ]}}"#
        ))
    };
    let running = parse(&suites("IN_PROGRESS")).unwrap();
    assert!(running.actions_hold.is_some());
    assert!(
        running
            .checks
            .iter()
            .all(|check| check.state == CheckState::Passed)
    );
    let merges = Cell::new(0);
    let merge = |_head: String| {
        merges.set(merges.get() + 1);
        async { Ok(()) }
    };
    let held = try_merge(url, &running, || async { Ok(running.clone()) }, merge).await;
    assert_eq!(
        held,
        Merging::Waiting(vec![
            "a GitHub Actions workflow on its head is still running".to_owned()
        ])
    );
    assert_eq!(merges.get(), 0);

    // Done, with an app's suite left queued: that one never holds it.
    let done = parse(&suites("COMPLETED")).unwrap();
    assert_eq!(done.actions_hold, None);
    let finished = try_merge(url, &done, || async { Ok(done.clone()) }, merge).await;
    assert_eq!(finished, Merging::Merged("abc1234def".to_owned()));
}

/// [`ANSWER`] made green: mergeable, clean, every listed check passed, nothing unresolved, as
/// after a workflow's first wave of jobs. Its commit has no `checkSuites`.
fn first_wave() -> String {
    ANSWER
        .replace(
            r#""mergeable": "CONFLICTING""#,
            r#""mergeable": "MERGEABLE""#,
        )
        .replace(
            r#""mergeStateStatus": "DIRTY""#,
            r#""mergeStateStatus": "CLEAN""#,
        )
        .replace(
            r#""reviewDecision": "CHANGES_REQUESTED""#,
            r#""reviewDecision": null"#,
        )
        .replace(r#""state": "CHANGES_REQUESTED""#, r#""state": "COMMENTED""#)
        .replace(r#""isResolved": false"#, r#""isResolved": true"#)
        .replace(r#""conclusion": "FAILURE""#, r#""conclusion": "SUCCESS""#)
        .replace(
            r#""status": "IN_PROGRESS", "conclusion": null"#,
            r#""status": "COMPLETED", "conclusion": "SUCCESS""#,
        )
}

/// [`first_wave`] with its head's `checkSuites` as `suites`, JSON.
fn with_suites(suites: &str) -> String {
    first_wave().replace(
        r#""commit": {"statusCheckRollup""#,
        &format!(r#""commit": {{"checkSuites": {suites}, "statusCheckRollup""#),
    )
}

/// The check-suite gate fails closed: suites GitHub left out, or more than one page of them,
/// hold a merge as a running workflow does.
#[tokio::test]
async fn merge_when_ready_holds_when_it_cant_read_every_suite() {
    let url = "https://github.com/me/app/pull/1";
    let done = r#"{"status": "COMPLETED", "workflowRun": {"databaseId": 1}}"#;
    let many = vec![done; 50].join(", ");
    for (answer, reason) in [
        (first_wave(), "GitHub didn't list its head's check suites"),
        (
            with_suites(&format!(
                r#"{{"pageInfo": {{"hasNextPage": true}}, "nodes": [{done}]}}"#
            )),
            "its head has more than 50 check suites, more than Parallax reads",
        ),
        (
            with_suites(&format!(
                r#"{{"pageInfo": {{"hasNextPage": false}}, "nodes": [{many}]}}"#
            )),
            "its head has more than 50 check suites, more than Parallax reads",
        ),
    ] {
        let detail = parse(&answer).unwrap();
        let merges = Cell::new(0);
        let merge = |_: String| {
            merges.set(merges.get() + 1);
            async { Ok(()) }
        };
        let held = try_merge(url, &detail, || async { Ok(detail.clone()) }, merge).await;
        assert_eq!(held, Merging::Waiting(vec![reason.to_owned()]));
        assert_eq!(merges.get(), 0);
    }
}

#[test]
fn a_watch_stored_before_merge_when_ready_still_reads() {
    let stored = serde_json::to_string(&Watch::new(start())).unwrap();
    assert!(!stored.contains("merge"), "{stored}");
    let read: Watch = serde_json::from_str(&stored).unwrap();
    assert_eq!(read.merge, None);
}

/// GitHub's answer to `QUERY` with everything `pr/view` reads (PLX-1151).
const FULL: &str = r#"{"data": {
      "viewer": {"login": "agent-bot"},
      "rateLimit": {"remaining": 4990, "resetAt": "2026-10-09T11:00:00Z"},
      "repository": {
        "mergeCommitAllowed": false, "squashMergeAllowed": true, "rebaseMergeAllowed": true,
        "pullRequest": {
          "number": 7, "url": "https://github.com/me/app/pull/7", "title": "Add a thing",
          "body": "Adds it.", "state": "OPEN", "isDraft": false,
          "createdAt": "2026-10-09T09:00:00Z", "updatedAt": "2026-10-09T10:09:00Z",
          "closedAt": null, "mergedAt": null, "mergedBy": null,
          "mergeStateStatus": "BLOCKED", "reviewDecision": "CHANGES_REQUESTED",
          "author": {"login": "ryan", "avatarUrl": "https://avatars/ryan"},
          "baseRefName": "develop", "headRefName": "feature/PLX-7-thing",
          "headRefOid": "abc1234def", "headRepository": {"nameWithOwner": "me/app"},
          "mergeable": "MERGEABLE", "isMergeQueueEnabled": false,
          "additions": 3, "deletions": 1, "changedFiles": 1,
          "autoMergeRequest": {"mergeMethod": "SQUASH"},
          "labels": {"nodes": [{"name": "daemon", "color": "0e8a16"}]},
          "reviewRequests": {"nodes": [
            {"requestedReviewer": {"login": "rev"}},
            {"requestedReviewer": {"name": "docs"}},
            {"requestedReviewer": null}
          ]},
          "files": {"nodes": [{"path": "src/main.rs", "additions": 3, "deletions": 1}]},
          "history": {"nodes": [
            {"commit": {"oid": "abc1234def", "messageHeadline": "feat: a thing",
              "committedDate": "2026-10-09T09:58:00Z",
              "author": {"name": "Ryan", "user": {"login": "ryan"}}}},
            {"commit": {"oid": "fff0000", "messageHeadline": "fix: it",
              "committedDate": "2026-10-09T09:59:00Z", "author": {"name": "Ann", "user": null}}}
          ]},
          "commits": {"nodes": [{"commit": {
            "checkSuites": {"pageInfo": {"hasNextPage": false}, "nodes": []},
            "statusCheckRollup": {"contexts": {"nodes": [
              {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED",
               "conclusion": "FAILURE", "detailsUrl": "https://ci/1", "databaseId": 501,
               "startedAt": "2026-10-09T10:01:00Z", "completedAt": "2026-10-09T10:03:00Z",
               "isRequired": true,
               "checkSuite": {"workflowRun": {"databaseId": 42, "workflow": {"name": "CI"}}}},
              {"__typename": "CheckRun", "name": "docs", "status": "COMPLETED",
               "conclusion": "SKIPPED", "detailsUrl": "", "databaseId": 502,
               "startedAt": null, "completedAt": null, "isRequired": false,
               "checkSuite": {"workflowRun": {"databaseId": 42, "workflow": {"name": "CI"}}}},
              {"__typename": "CheckRun", "name": "app", "status": "QUEUED", "conclusion": null,
               "detailsUrl": null, "databaseId": 900, "isRequired": false,
               "checkSuite": {"workflowRun": null}},
              {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS",
               "targetUrl": "https://deploy/1", "createdAt": "2026-10-09T10:02:00Z",
               "isRequired": false}
            ]}}
          }}]},
          "comments": {"nodes": [
            {"id": "IC_1", "author": {"login": "bot", "avatarUrl": "https://avatars/bot"},
             "body": "Deployed.", "createdAt": "2026-10-09T10:05:00Z", "lastEditedAt": null,
             "url": "https://github.com/me/app/pull/7#issuecomment-1"}
          ]},
          "reviews": {"nodes": [
            {"id": "PRR_1", "author": {"login": "rev", "avatarUrl": "https://avatars/rev"},
             "body": "Please split it.", "state": "CHANGES_REQUESTED",
             "submittedAt": "2026-10-09T10:04:00Z", "lastEditedAt": null,
             "url": "https://github.com/me/app/pull/7#pullrequestreview-1"},
            {"id": "PRR_2", "author": {"login": "rev"}, "body": "draft", "state": "PENDING",
             "submittedAt": null, "lastEditedAt": null, "url": null}
          ]},
          "reviewThreads": {"pageInfo": {"hasPreviousPage": true}, "nodes": [
            {"id": "PRRT_1", "path": "src/main.rs", "line": 12, "originalLine": 10,
             "isOutdated": false, "isResolved": false, "comments": {
              "pageInfo": {"hasNextPage": true}, "nodes": [
              {"id": "PRRC_1", "author": {"login": "rev", "avatarUrl": "https://avatars/rev"},
               "body": "nit", "createdAt": "2026-10-09T10:04:00Z", "lastEditedAt": null,
               "url": "https://github.com/me/app/pull/7#discussion_r1",
               "diffHunk": "@@ -8,3 +8,5 @@ fn main() {"},
              {"id": "PRRC_2", "author": null, "body": "fixed", "createdAt":
               "2026-10-09T10:06:00Z", "lastEditedAt": null, "url": null,
               "diffHunk": "@@ -8,3 +8,5 @@ fn main() {"}
            ]}},
            {"id": "PRRT_2", "path": "src/lib.rs", "line": null, "originalLine": 4,
             "isOutdated": true, "isResolved": true, "comments": {"nodes": [
              {"id": "PRRC_3", "author": {"login": "rev"}, "body": "done", "createdAt":
               "2026-10-09T10:03:00Z", "lastEditedAt": null, "url": null, "diffHunk": "@@"}
            ]}}
          ]}
        }
      }
    }}"#;

#[test]
fn githubs_answer_reads_into_what_pr_view_serves() {
    let detail = parse(FULL).unwrap();
    assert_eq!(detail.head_repo.as_deref(), Some("me/app"));
    let pr = viewed("https://github.com/me/app/pull/7", detail, Some(3)).unwrap();
    assert_eq!((pr.number, pr.repo.as_str()), (7, "me/app"));
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.author, "ryan");
    assert_eq!(pr.head_sha.as_deref(), Some("abc1234def"));
    assert_eq!(pr.review_decision, Some(PrReviewDecision::ChangesRequested));
    assert_eq!(pr.mergeable, Some(true));
    assert_eq!(pr.merge_state, Some(PrMergeState::Blocked));
    assert_eq!(pr.auto_merge, Some(PrMergeMethod::Squash));
    assert_eq!(
        pr.merge_methods,
        [PrMergeMethod::Squash, PrMergeMethod::Rebase]
    );
    assert_eq!(pr.labels, ["daemon"]);
    assert_eq!(pr.label_colors[0].color, "0e8a16");
    assert_eq!(pr.review_requests, ["rev", "docs"]);
    let commits: Vec<_> = pr
        .commits
        .iter()
        .map(|commit| (commit.oid.as_str(), commit.author.as_str()))
        .collect();
    assert_eq!(commits, [("abc1234def", "ryan"), ("fff0000", "Ann")]);
    assert_eq!(pr.behind_by, Some(3));
    assert_eq!(pr.ready, Some(false));
    assert_eq!(
        pr.reasons,
        [
            "3 commits behind develop",
            "failing: lint",
            "pending: app",
            "1 unresolved review thread",
            "changes requested"
        ]
    );
}

/// The `pr/view` that [`FULL`] reads into, with its head 3 commits behind its base.
fn full() -> parallax_protocol::PullRequest {
    viewed(
        "https://github.com/me/app/pull/7",
        parse(FULL).unwrap(),
        Some(3),
    )
    .unwrap()
}

#[test]
fn pr_view_s_checks_carry_whether_required_and_their_run_and_job() {
    let pr = full();
    let checks: Vec<_> = pr
        .checks
        .iter()
        .map(|check| {
            (
                check.name.as_str(),
                check.state,
                check.required,
                check.run_id,
                check.job_id,
            )
        })
        .collect();
    assert_eq!(
        checks,
        [
            ("lint", PrCheckState::Failed, true, Some(42), Some(501)),
            ("docs", PrCheckState::Skipped, false, Some(42), Some(502)),
            ("app", PrCheckState::Pending, false, None, None),
            ("deploy", PrCheckState::Passed, false, None, None),
        ],
        "only an Actions check run is a job"
    );
    assert_eq!(pr.checks[0].workflow.as_deref(), Some("CI"));
    assert_eq!(pr.checks[0].conclusion.as_deref(), Some("failure"));
    assert_eq!(pr.checks[1].url, None, "an empty link is none");
    assert_eq!(
        pr.checks[3].started_at,
        Some("2026-10-09T10:02:00Z".parse().unwrap())
    );
    assert_eq!(pr.checks_state, Some(PrCheckState::Failed));
}

#[test]
fn pr_view_s_comments_and_review_threads_carry_their_ids() {
    let pr = full();
    let comments: Vec<_> = pr
        .comments
        .iter()
        .map(|comment| (comment.id.as_deref(), comment.kind, comment.url.is_some()))
        .collect();
    assert_eq!(
        comments,
        [
            (Some("PRR_1"), Some(PrCommentKind::Review), true),
            (Some("IC_1"), Some(PrCommentKind::Comment), true),
        ],
        "oldest first, without the pending review"
    );
    assert_eq!(
        pr.comments[0].avatar_url.as_deref(),
        Some("https://avatars/rev")
    );
    assert_eq!(pr.reviews.len(), 1);
    assert_eq!(pr.reviews[0].state, PrReviewState::ChangesRequested);

    let open = &pr.review_threads[0];
    assert_eq!(
        (
            open.id.as_str(),
            open.line,
            open.is_resolved,
            open.is_outdated
        ),
        ("PRRT_1", Some(12), false, false)
    );
    assert_eq!(
        open.diff_hunk.as_deref(),
        Some("@@ -8,3 +8,5 @@ fn main() {")
    );
    let replies: Vec<_> = open
        .comments
        .iter()
        .map(|comment| (comment.id.as_str(), comment.author.as_str()))
        .collect();
    assert_eq!(replies, [("PRRC_1", "rev"), ("PRRC_2", "ghost")]);
    let resolved = &pr.review_threads[1];
    assert_eq!(
        (resolved.line, resolved.is_resolved, resolved.is_outdated),
        (Some(4), true, true),
        "an outdated thread keeps the line it was written on"
    );
    assert!(pr.review_threads_truncated, "older threads are on GitHub");
    assert_eq!(
        (open.truncated, resolved.truncated),
        (true, false),
        "only the thread GitHub has more comments on says so"
    );
}

#[test]
fn a_failed_compare_isn_t_ready_and_is_kept_for_the_read() {
    let url = "https://github.com/me/app/pull/7";
    let pr = viewed(url, parse(FULL).unwrap(), None).unwrap();
    assert_eq!(pr.behind_by, None);
    assert_eq!(pr.ready, Some(false));
    assert!(
        pr.reasons
            .iter()
            .any(|reason| reason.starts_with("couldn't tell how far it is behind")),
        "{:?}",
        pr.reasons
    );

    let watches = Watches::default();
    let at = Instant::now();
    watches.share(url, at, &parse(FULL).unwrap());
    watches.compared(url, "abc1234def", Err("ref: null".to_owned()));
    assert_eq!(
        watches.shared(url, at).unwrap().compared,
        Some(Err("ref: null".to_owned())),
        "the next caller within the read's 30 s doesn't compare again"
    );
}

#[test]
fn an_answer_without_what_pr_view_needs_still_serves_the_watches() {
    let detail = parse(ANSWER).unwrap();
    assert!(detail.view.is_none());
    let error = viewed("https://github.com/me/app/pull/1", detail, None).unwrap_err();
    assert!(error.to_string().contains("left out"), "{error}");
}

/// 0093: news from a pull request an archived orchestrator watches brings its thread back,
/// naming the pull request.
#[tokio::test]
async fn a_watch_wakes_an_archived_orchestrator_thread() {
    use crate::agents::orchestrator::tests::{archive, orchestrator, reason, thread};

    let dir = tempfile::tempdir().unwrap();
    let daemon =
        crate::server::Daemon::for_tests(dir.path(), 10, std::time::Duration::from_secs(90));
    let (_, run) = orchestrator(&daemon, Some("/src/app")).await;
    archive(&daemon, run, true).await;
    let url = "https://github.com/o/r/pull/1";
    let watch = Watch::new(start());
    let payload = serde_json::to_string(&watch).unwrap();
    crate::threads::store(&daemon, move |db| {
        db.put_pr_watch(run.into(), url, &payload)
            .map_err(|e| crate::store::store_error(&e))?;
        let next = Some(Watch::new(start()));
        let text = Some("A check failed.".to_owned());
        super::record_job(db, run.into(), url, (start(), None), next, text)
    })
    .await
    .unwrap();
    let woken = thread(&daemon, run).await;
    assert!(!woken.archived);
    assert_eq!(
        reason(&woken),
        Some(parallax_protocol::WakeReason::PullRequest {
            url: url.to_owned()
        })
    );
}

/// 0093: a watch held by a run that Start over replaced still brings the orchestrator's thread
/// back, since the watch stays with the run that made it.
#[tokio::test]
async fn a_replaced_runs_watch_wakes_the_orchestrators_thread() {
    use crate::agents::orchestrator::tests::{archive, orchestrator, replace, thread};

    let dir = tempfile::tempdir().unwrap();
    let daemon =
        crate::server::Daemon::for_tests(dir.path(), 10, std::time::Duration::from_secs(90));
    let (id, old) = orchestrator(&daemon, Some("/src/app")).await;
    let new = replace(&daemon, id).await;
    archive(&daemon, new, true).await;
    let url = "https://github.com/o/r/pull/1";
    let payload = serde_json::to_string(&Watch::new(start())).unwrap();
    crate::threads::store(&daemon, move |db| {
        db.put_pr_watch(old.into(), url, &payload)
            .map_err(|e| crate::store::store_error(&e))?;
        let next = Some(Watch::new(start()));
        let text = Some("A check failed.".to_owned());
        super::record_job(db, old.into(), url, (start(), None), next, text)
    })
    .await
    .unwrap();
    assert!(!thread(&daemon, new).await.archived);
}
