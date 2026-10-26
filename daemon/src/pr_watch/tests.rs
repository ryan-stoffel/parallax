use std::time::{Duration, Instant};

use jiff::{SignedDuration, Timestamp};

use super::{
    Change, Check, CheckState, Detail, Remark, Watch, Watches, evaluate, message, parse, verdict,
};
use parallax_protocol::{PrStatusCheck, PrStatusFile, PrStatusThread};

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
    watches.compared(url, "abc1234def", 2);
    assert_eq!(watches.shared(url, later).unwrap().behind_by, Some(2));
    watches.compared(url, "pushed", 5);
    assert_eq!(watches.shared(url, later).unwrap().behind_by, Some(2));

    // A newer read drops ones too old to share.
    let next = at + Duration::from_secs(31);
    watches.share("https://github.com/me/app/pull/2", next, &Detail::default());
    assert!(!watches.reads().contains_key(url));
}
