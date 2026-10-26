use std::ffi::OsString;

use jiff::{SignedDuration, Timestamp};

use super::{Api, Budget, Quota, dir, low, parse_rate_limit, read_api, real_gh, redirect};
use crate::backend::process::{Environment, Launcher, ProcessSpec};
use crate::paths::DataDir;

fn args(line: &str) -> Vec<String> {
    line.split(' ').map(str::to_owned).collect()
}

/// The tool `line` is sent to, or `None` when it runs.
fn tool(line: &str) -> Option<&'static str> {
    let refusal = redirect(&args(line))?;
    [
        "watch_pull_request",
        "pull_request_status",
        "ci_failure_log",
    ]
    .into_iter()
    .find(|tool| refusal.contains(&format!("the {tool} tool")))
}

#[test]
fn the_redirect_table_sends_replaced_commands_to_their_tools() {
    let cases = [
        ("pr checks 12 --watch", "watch_pull_request"),
        ("pr checks 12 --watch=true", "watch_pull_request"),
        ("pr checks 12 --required", "pull_request_status"),
        ("pr checks", "pull_request_status"),
        ("pr view 12", "pull_request_status"),
        (
            "pr view https://github.com/o/r/pull/12",
            "pull_request_status",
        ),
        ("pr view #12 --json title", "pull_request_status"),
        (
            "pr view 12 --json state,mergeable,files,body",
            "pull_request_status",
        ),
        (
            "pr view 12 --json=statusCheckRollup --jq .x",
            "pull_request_status",
        ),
        ("run watch 99", "watch_pull_request"),
        ("run view 99 --log-failed", "ci_failure_log"),
        // gh takes `-R` between a command and its subcommand.
        ("pr -R o/r checks 12", "pull_request_status"),
        ("pr --repo o/r view 12 --json title", "pull_request_status"),
        ("run -R o/r view 99 --log-failed", "ci_failure_log"),
    ];
    for (line, expected) in cases {
        assert_eq!(tool(line), Some(expected), "{line}");
    }

    let refusal = redirect(&args("pr checks 12")).unwrap();
    assert_eq!(
        refusal,
        "plxd: agents don't run gh pr checks in Parallax; use the pull_request_status tool instead."
    );
}

#[test]
fn commands_no_tool_replaces_run() {
    for line in [
        // pull_request_status needs the pull request, and returns only some of its fields.
        "pr view",
        "pr view --json number,url",
        "pr view -R o/r --json url",
        "pr view feature/x --json number,url",
        // pull_request_status takes no branch.
        "pr view feature/x",
        "pr view feature/x --json state",
        "pr view 12 --json title,labels",
        "pr view 12 --json author,commits,reviewRequests,mergedAt",
        "pr view 12 --json reviews",
        "pr view 12 --comments",
        "pr view 12 -c",
        "pr view 12 --json=comments",
        "pr view 12 --web",
        // A run's log or list, which ci_failure_log (a pull request's failed checks) doesn't
        // replace.
        "run view 99",
        "run view 99 --log",
        "run view --job 7 --log",
        "run list --branch main --workflow release.yml",
        "run list -c abc123",
        "pr checks --help",
        "pr create --title x --body y",
        "pr merge 12 --squash",
        "pr list",
        "api rate_limit",
        "auth status",
        "pr",
        "--version",
    ] {
        assert_eq!(redirect(&args(line)), None, "{line}");
    }
}

#[test]
fn reads_are_told_apart_from_writes_by_the_quota_they_spend() {
    let cases = [
        ("pr list", Some(Api::Graphql)),
        ("pr -R o/r list", Some(Api::Graphql)),
        ("issue view 3", Some(Api::Graphql)),
        ("repo view", Some(Api::Graphql)),
        ("pr diff 3", Some(Api::Rest)),
        ("run list --workflow ci.yml", Some(Api::Rest)),
        ("release view v1", Some(Api::Rest)),
        ("api repos/o/r/pulls/1", Some(Api::Rest)),
        (
            "api -H Accept:x repos/o/r/pulls/1 --jq .title",
            Some(Api::Rest),
        ),
        ("api -X GET repos/o/r/issues -f state=open", Some(Api::Rest)),
        (
            "api --method=get repos/o/r/issues -F per_page=5",
            Some(Api::Rest),
        ),
        (
            "api graphql -f query=query{viewer{login}}",
            Some(Api::Graphql),
        ),
        // Writes: a method other than GET, fields with no method, a mutation, or a query from a
        // file the shim doesn't open.
        ("api graphql -f query=mutation{x}", None),
        ("api graphql --input q.json", None),
        ("api graphql -F query=@mutation.graphql", None),
        ("api repos/o/r/issues/1/comments -f body=hi", None),
        ("api repos/o/r/issues/1/comments -fbody=hi", None),
        ("api repos/o/r/issues/1/comments --raw-field=body=hi", None),
        ("api repos/o/r/pulls --input pr.json", None),
        ("api -X POST repos/o/r/merges", None),
        ("api --method=PATCH repos/o/r/pulls/1", None),
        ("api -XDELETE repos/o/r/git/refs/heads/x", None),
        // What spends no quota, or another one.
        ("api rate_limit", None),
        ("api /rate_limit", None),
        ("search prs is:open", None),
        ("pr list --help", None),
        ("pr create --title x", None),
        ("pr merge 1", None),
        ("auth status", None),
        ("--version", None),
    ];
    for (line, api) in cases {
        assert_eq!(read_api(&args(line)), api, "{line}");
    }
}

fn quota(remaining: u64, reset_in: i64) -> Quota {
    let now = Timestamp::now();
    Quota {
        remaining,
        reset_at: now + SignedDuration::from_secs(reset_in),
        seen_at: now,
    }
}

#[test]
fn a_read_is_refused_under_200_left_until_the_reset() {
    let now = Timestamp::now();
    let budget = Budget {
        rest: Some(quota(4000, 600)),
        graphql: Some(quota(199, 600)),
        checked_at: None,
    };
    let refusal = low(&budget, Api::Graphql, now).unwrap();
    assert!(
        refusal.starts_with(
            "plxd: GitHub's GraphQL quota is down to 199 requests until it resets at "
        ),
        "{refusal}"
    );
    assert!(refusal.contains("(in 10 min)"), "{refusal}");
    assert_eq!(low(&budget, Api::Rest, now), None);
    // Once the reset has passed, the quota is full again.
    let reset = Budget {
        graphql: Some(quota(10, -1)),
        ..budget
    };
    assert_eq!(low(&reset, Api::Graphql, now), None);
    assert_eq!(low(&Budget::default(), Api::Graphql, now), None);
}

#[test]
fn a_budget_that_cant_be_real_is_ignored() {
    let now = Timestamp::now();
    let hours = |n: i64| now + SignedDuration::from_hours(n);
    let planted = Budget {
        // Seen in the future, and resetting in a year.
        rest: Some(Quota {
            remaining: 0,
            reset_at: hours(10),
            seen_at: hours(-1),
        }),
        graphql: Some(Quota {
            remaining: 0,
            reset_at: hours(8760),
            seen_at: hours(8760),
        }),
        checked_at: Some(hours(1)),
    };
    assert_eq!(planted.sane(now), Budget::default());

    let real = Budget {
        rest: Some(quota(0, 3000)),
        graphql: Some(quota(0, 60)),
        checked_at: Some(now),
    };
    assert_eq!(real.sane(Timestamp::now()), real);
}

#[test]
fn gh_api_rate_limit_answers_both_quotas() {
    let seen = Timestamp::from_second(1_800_000_000).unwrap();
    let answer = br#"{"resources":{"core":{"limit":5000,"remaining":4321,"reset":1800003600},
        "graphql":{"limit":5000,"remaining":12,"reset":1800001800}},"rate":{}}"#;
    let budget = parse_rate_limit(answer, seen).unwrap();
    assert_eq!(budget.rest.unwrap().remaining, 4321);
    assert_eq!(
        budget.graphql.unwrap().reset_at,
        Timestamp::from_second(1_800_001_800).unwrap()
    );
    assert_eq!(budget.graphql.unwrap().seen_at, seen);
    assert_eq!(parse_rate_limit(b"not json", seen), None);
}

#[test]
fn the_real_gh_is_the_first_outside_any_shim_folder() {
    let temp = tempfile::tempdir().unwrap();
    let data = DataDir::new(temp.path().join("data")).unwrap();
    let gh = if cfg!(windows) { "gh.exe" } else { "gh" };
    let shim = dir(&data);
    let other_shim = temp.path().join("other/tools/gh-shim");
    let bin = temp.path().join("bin");
    let installed = crate::github::bin_dir(&data);
    for folder in [&shim, &other_shim, &bin, &installed] {
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join(gh), "").unwrap();
    }

    let path = std::env::join_paths([&shim, &other_shim, &bin]).unwrap();
    assert_eq!(real_gh(Some(&path), Some(&data)), Some(bin.join(gh)));
    let path = std::env::join_paths([&shim, &shim]).unwrap();
    assert_eq!(real_gh(Some(&path), Some(&data)), Some(installed.join(gh)));
    assert_eq!(real_gh(Some(&path), None), None);
}

#[test]
fn only_agent_processes_get_the_shim_first_on_path() {
    let data = DataDir::new(std::env::temp_dir().join("plxd-test-data")).unwrap();
    let path = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
    let launcher = Launcher::new(
        data.clone(),
        [("PATH", path.clone())]
            .into_iter()
            .collect::<Environment>(),
    );
    let mut spec = ProcessSpec::new("claude", std::env::temp_dir());

    let first = |spec: &ProcessSpec| {
        let env = launcher.environment(spec);
        std::env::split_paths(env.get("PATH").unwrap()).next()
    };
    assert_eq!(first(&spec), Some("/usr/bin".into()));
    spec.agent = true;
    assert_eq!(first(&spec), Some(dir(&data)));
    let rest: Vec<OsString> =
        std::env::split_paths(launcher.environment(&spec).get("PATH").unwrap())
            .skip(1)
            .take(2)
            .map(Into::into)
            .collect();
    assert_eq!(rest, ["/usr/bin", "/bin"]);
}
