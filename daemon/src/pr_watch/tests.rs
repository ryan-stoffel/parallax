use jiff::{SignedDuration, Timestamp};

use super::{Change, Check, CheckState, Detail, Remark, Watch, evaluate, message, parse, verdict};
use parallax_protocol::{PrStatusCheck, PrStatusThread};

fn start() -> Timestamp {
    "2026-10-09T10:00:00Z".parse().unwrap()
}

fn check(name: &str, state: CheckState, required: bool) -> Check {
    Check {
        name: name.to_owned(),
        state,
        required,
        url: None,
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

#[test]
fn githubs_answer_reads_into_a_detail() {
    let answer = r#"{"data": {
      "viewer": {"login": "agent-bot"},
      "repository": {"pullRequest": {
        "state": "OPEN", "author": {"login": "ryan"}, "baseRefName": "develop",
        "headRefOid": "abc1234def", "mergeable": "CONFLICTING", "isDraft": false,
        "mergeStateStatus": "DIRTY", "reviewDecision": "CHANGES_REQUESTED",
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
          {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE",
           "detailsUrl": "https://ci/1", "isRequired": true},
          {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": null,
           "detailsUrl": null, "isRequired": false},
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
          {"path": "src/main.rs", "isResolved": false, "comments": {"nodes": [
            {"id": "t1", "author": null, "body": "nit", "createdAt": "2026-10-09T10:04:00Z",
             "lastEditedAt": "2026-10-09T10:08:00Z", "url": null}
          ]}},
          {"path": "src/lib.rs", "isResolved": true, "comments": {"nodes": [
            {"id": "t2", "author": {"login": "reviewer"}, "body": "done", "createdAt":
             "2026-10-09T10:03:00Z", "lastEditedAt": null, "url": null}
          ]}}
        ]}
      }}
    }}"#;
    let detail = parse(answer).unwrap();
    assert_eq!(detail.state, "OPEN");
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
    let green = vec![check("lint", CheckState::Passed, true)];
    let ready = verdict(
        url.clone(),
        open(green.clone(), Vec::new(), "MERGEABLE"),
        0,
        true,
    );
    assert!(ready.ready, "{:?}", ready.reasons);
    assert!(ready.watching);
    assert_eq!(ready.passed, ["lint"]);

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
