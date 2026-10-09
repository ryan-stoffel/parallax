use jiff::{SignedDuration, Timestamp};

use super::{
    Change, Check, CheckState, Detail, Remark, WAKE_LIMIT, Watch, evaluate, message, parse, snippet,
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
fn the_required_checks_passing_wakes_even_while_others_run() {
    let checks = |lint, bot| vec![check("lint", lint, true), check("advisory-bot", bot, false)];
    let watch = seen(&checks(CheckState::Pending, CheckState::Pending));
    let report = evaluate(
        &watch,
        &open(
            checks(CheckState::Passed, CheckState::Pending),
            Vec::new(),
            "MERGEABLE",
        ),
    );
    assert_eq!(
        report.changes,
        [Change::ChecksPassed {
            count: 1,
            required: true
        }]
    );
    let text = message(
        "https://github.com/me/app/pull/1",
        &open(Vec::new(), Vec::new(), ""),
        &report,
    );
    assert!(
        text.contains("- All 1 required check passed on abc1234."),
        "{text}"
    );
    let quiet = evaluate(
        &report.next,
        &open(
            checks(CheckState::Passed, CheckState::Passed),
            Vec::new(),
            "MERGEABLE",
        ),
    );
    assert!(quiet.changes.is_empty(), "told already");
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
fn a_new_conflict_wakes_and_unknown_keeps_the_last_answer() {
    let watch = seen(&[]);
    let report = evaluate(&watch, &open(Vec::new(), Vec::new(), "CONFLICTING"));
    assert_eq!(report.changes, [Change::Conflicting]);
    let text = message("u", &open(Vec::new(), Vec::new(), "CONFLICTING"), &report);
    assert!(
        text.contains("- The branch now conflicts with develop."),
        "{text}"
    );
    let unknown = evaluate(&report.next, &open(Vec::new(), Vec::new(), "UNKNOWN"));
    assert!(unknown.changes.is_empty());
    assert!(unknown.next.conflicting);
    let clean = evaluate(&unknown.next, &open(Vec::new(), Vec::new(), "MERGEABLE"));
    assert!(!clean.next.conflicting);
}

#[test]
fn ten_comment_only_wakes_in_a_row_end_the_watch_and_other_news_resets_the_count() {
    let mut watch = seen(&[]);
    for wake in 1..=WAKE_LIMIT {
        let remarks = vec![remark(&format!("c{wake}"), "bot", i64::from(wake))];
        let report = evaluate(&watch, &open(Vec::new(), remarks, "MERGEABLE"));
        assert_eq!(report.next.wakes, wake);
        assert_eq!(report.exhausted, wake == WAKE_LIMIT);
        if report.exhausted {
            let text = message("u", &open(Vec::new(), Vec::new(), ""), &report);
            assert!(
                text.contains("stopped watching after 10 comment-only updates"),
                "{text}"
            );
        }
        watch = report.next;
    }

    // A conflict is progress, which starts the count again.
    let mut chatty = seen(&[]);
    chatty.wakes = 3;
    let report = evaluate(
        &chatty,
        &open(Vec::new(), vec![remark("c", "bot", 1)], "CONFLICTING"),
    );
    assert_eq!(report.next.wakes, 0);
}

#[test]
fn a_push_forgets_the_old_heads_checks() {
    let failed = vec![check("test", CheckState::Failed("failure"), false)];
    let watch = seen(&[]);
    let told = evaluate(&watch, &open(failed.clone(), Vec::new(), "MERGEABLE"));
    assert_eq!(told.changes.len(), 1);
    let mut pushed = open(failed.clone(), Vec::new(), "MERGEABLE");
    pushed.head_sha = Some("fff0000".to_owned());
    let report = evaluate(&told.next, &pushed);
    assert_eq!(
        report.changes,
        [Change::ChecksFailed(failed)],
        "the new head failed too"
    );
}

#[test]
fn githubs_answer_reads_into_a_detail() {
    let answer = r#"{"data": {
      "viewer": {"login": "agent-bot"},
      "repository": {"pullRequest": {
        "state": "OPEN", "author": {"login": "ryan"}, "baseRefName": "develop",
        "headRefOid": "abc1234def", "mergeable": "CONFLICTING",
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
        "reviewThreads": {"nodes": [{"path": "src/main.rs", "comments": {"nodes": [
          {"id": "t1", "author": null, "body": "nit", "createdAt": "2026-10-09T10:04:00Z",
           "lastEditedAt": "2026-10-09T10:08:00Z", "url": null}
        ]}}]}
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
        ["c1", "r2", "t1"],
        "oldest first; an empty COMMENTED review is skipped"
    );
    assert_eq!(detail.remarks[2].path.as_deref(), Some("src/main.rs"));

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
fn a_snippet_is_one_line_without_html_comments() {
    assert_eq!(snippet("a <!-- hidden -->\n\n b"), "a b");
    assert_eq!(snippet(&"x".repeat(300)).chars().count(), 200);
}
