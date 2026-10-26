use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::{CAP, Failed, excerpt, parse, spent_until, trim};
use crate::worktree::PrError;

#[test]
fn trim_keeps_the_lines_around_errors_without_timestamps_or_colors() {
    let mut log: Vec<String> = [
        "\u{feff}2026-10-25T10:00:00.0000000Z ##[group]Run actions/cache@v4",
        "2026-10-25T10:00:00.0000000Z   fail-on-cache-miss: false",
        "2026-10-25T10:00:00.0000000Z ##[endgroup]",
    ]
    .map(str::to_owned)
    .into();
    log.extend((0..30).map(|i| format!("2026-10-25T10:00:01.0000000Z setup line {i}")));
    log.push("2026-10-25T10:00:02.0000000Z    Compiling thiserror v2.0.12".to_owned());
    log.push("2026-10-25T10:00:02.0000000Z test pr_watch::a_failed_read ... ok".to_owned());
    log.extend((0..10).map(|i| format!("2026-10-25T10:00:03.0000000Z quiet line {i}")));
    log.push(
        "2026-10-25T10:00:04.0000000Z \u{1b}[1m\u{1b}[31merror[E0308]\u{1b}[0m: mismatched types"
            .to_owned(),
    );
    log.extend((0..20).map(|i| format!("2026-10-25T10:00:05.0000000Z after line {i}")));
    log.push("2026-10-25T10:00:06.0000000Z thread 'a' panicked at src/a.rs:1:2:".to_owned());
    let trimmed = trim(&log.join("\n"));

    let lines: Vec<&str> = trimmed.lines().collect();
    assert_eq!(lines[0], "quiet line 7", "{trimmed}");
    assert_eq!(lines[3], "error[E0308]: mismatched types");
    assert_eq!(lines[11], "after line 7");
    assert_eq!(lines[12], "...");
    assert_eq!(lines.last(), Some(&"thread 'a' panicked at src/a.rs:1:2:"));
    // A step's inputs, a crate, or a passing test named after errors isn't one.
    assert!(!trimmed.contains("fail-on-cache-miss"));
    assert!(!trimmed.contains("thiserror") && !trimmed.contains("a_failed_read"));
    assert!(!trimmed.contains("setup line"));
}

#[test]
fn trim_keeps_the_end_when_nothing_matches_and_caps_the_size() {
    let log: Vec<String> = (0..100).map(|i| format!("line {i}")).collect();
    let trimmed = trim(&log.join("\n"));
    assert!(trimmed.starts_with("line 60\n") && trimmed.ends_with("line 99"));

    let log: Vec<String> = (0..2000).map(|i| format!("error number {i}")).collect();
    let trimmed = trim(&log.join("\n"));
    assert!(trimmed.len() <= CAP + 40, "{}", trimmed.len());
    assert!(trimmed.starts_with("error number 0\n"));
    assert!(trimmed.contains(" bytes cut) ..."));
    assert!(trimmed.ends_with("error number 1999"));
}

#[tokio::test]
async fn a_jobs_log_is_read_once_per_head() {
    let dir = tempfile::tempdir().unwrap();
    let reads = AtomicUsize::new(0);
    let fetch = || async {
        reads.fetch_add(1, Ordering::SeqCst);
        Ok::<_, PrError>("ok\nerror: could not compile `plxd`\nmore".to_owned())
    };
    let first = excerpt(dir.path(), "abc123", 42, fetch).await.unwrap();
    let second = excerpt(dir.path(), "abc123", 42, fetch).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(dir.path().join("abc123").join("42.log").is_file());

    // Another head, or a sha that isn't one, reads again.
    excerpt(dir.path(), "def456", 42, fetch).await.unwrap();
    excerpt(dir.path(), "../x", 42, fetch).await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 3);
}

#[test]
fn a_head_with_no_failed_checks_has_no_failures() {
    let answer = |nodes: serde_json::Value| {
        json!({"data": {"repository": {"pullRequest": {"commits": {"nodes": [{"commit": {
            "oid": "abc123",
            "statusCheckRollup": {"contexts": {"nodes": nodes}},
        }}]}}}}})
        .to_string()
    };
    let passing = answer(json!([
        {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS", "databaseId": 1},
        {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": null},
        {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS"},
    ]));
    assert_eq!(
        parse(&passing).unwrap(),
        (Some("abc123".to_owned()), Vec::new())
    );

    let failing = answer(json!([
        {"__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "FAILURE",
         "detailsUrl": "https://github.com/o/r/actions/runs/7/job/9", "databaseId": 9,
         "checkSuite": {"workflowRun": {"databaseId": 7}}},
        {"__typename": "CheckRun", "name": "external", "status": "COMPLETED", "conclusion": "TIMED_OUT",
         "databaseId": 5, "checkSuite": {"workflowRun": null}},
    ]));
    let (_, failed) = parse(&failing).unwrap();
    assert_eq!(
        failed,
        vec![
            Failed {
                name: "external".to_owned(),
                how: "timed out".to_owned(),
                workflow_run_id: None,
                job_id: None,
                url: None,
            },
            Failed {
                name: "rust".to_owned(),
                how: "failure".to_owned(),
                workflow_run_id: Some(7),
                job_id: Some(9),
                url: Some("https://github.com/o/r/actions/runs/7/job/9".to_owned()),
            },
        ]
    );
}

#[test]
fn a_spent_limit_says_when_it_resets() {
    let answer = json!({"resources": {
        "core": {"remaining": 0, "reset": 1_761_400_000},
        "graphql": {"remaining": 4000, "reset": 1_761_401_000},
    }})
    .to_string();
    assert_eq!(spent_until(&answer).unwrap().as_second(), 1_761_400_000);
    let fine = json!({"resources": {"core": {"remaining": 5, "reset": 1}}}).to_string();
    assert_eq!(spent_until(&fine), None);
}
