//! The `gh` shim agents get first on `PATH` (PLX-1023, 0086), and the GitHub quota it guards.
//!
//! `plxd serve` [`install`]s plxd itself as `<data>/tools/gh-shim/gh` (`gh.exe` on Windows), and
//! [`Launcher::environment`](crate::backend::process::Launcher::environment) puts that folder
//! first on the `PATH` of every agent process ([`ProcessSpec::agent`]). Run as `gh`, plxd's
//! `main` calls [`main`], which:
//!
//! 1. refuses a command a plxd tool replaces, naming the tool, with exit code 2 ([`REDIRECTS`]);
//! 2. refuses a read when under [`LOW`] requests are left of the quota it spends, until it resets;
//! 3. runs the real `gh` with everything else unchanged: the next `gh` on `PATH` that isn't a shim,
//!    else plxd's own `tools/gh/bin/gh`.
//!
//! `PARALLAX_GH_SHIM=off` skips 1 and 2. The user's terminals and plxd's own `gh` calls never get
//! the shim.
//!
//! The quota lives in `<data>/github-budget.json`, which plxd writes on each read that reports it
//! (the PR watch query's `rateLimit`), and which the shim and `github_budget` refresh with
//! `gh api rate_limit`, which GitHub doesn't count, when it is over [`FRESH`] old, at most once
//! per [`FRESH`]. A file is simpler than asking plxd over its socket, works while plxd is down,
//! and costs a read of a few hundred bytes per `gh` call. A worker's sandbox can read it but not
//! write it, so there the shim keeps its own reads in `$TMPDIR`, when set and its own. A quota
//! seen in the future or resetting over an hour away is ignored. Anything missing or unreadable
//! lets the command run.
//!
//! [`ProcessSpec::agent`]: crate::backend::process::ProcessSpec::agent

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use jiff::{SignedDuration, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths::{DATA_DIR_ENV, DataDir};

#[cfg(test)]
mod tests;

/// Set to `off` to make the shim run the real `gh` for everything, for debugging.
pub const OFF_ENV: &str = "PARALLAX_GH_SHIM";

/// The shim's exit code when it refuses a command.
pub const EXIT_REFUSED: i32 = 2;

/// Below this many requests left, the shim refuses reads that spend that quota.
pub const LOW: u64 = 200;

/// How old a quota may be before the shim or `github_budget` reads it again.
const FRESH: SignedDuration = SignedDuration::from_secs(60);

/// How long `gh api rate_limit` may take before the shim gives up on it and lets the command run.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

/// The shim's (and the real `gh`'s) file name.
const GH: &str = if cfg!(windows) { "gh.exe" } else { "gh" };

/// A `gh` command a plxd tool replaces: `gh <command[0]> <command[1]>`, when `when` holds for
/// its arguments.
struct Redirect {
    command: [&'static str; 2],
    when: When,
    /// The plxd MCP tool to use instead.
    tool: &'static str,
}

/// When a [`Redirect`] applies.
enum When {
    Always,
    /// When any of these flags is given.
    Any(&'static [&'static str]),
    /// When the arguments name a pull request by number or URL, which the tool takes, and it
    /// answers everything they ask: none of `unless` is given, and each `--json` field is one of
    /// `fields`.
    Answers {
        unless: &'static [&'static str],
        fields: &'static [&'static str],
    },
}

/// The commands the shim refuses, first match first. Add one only once its tool is on `develop`.
const REDIRECTS: &[Redirect] = &[
    Redirect {
        command: ["pr", "checks"],
        when: When::Any(&["--watch"]),
        tool: "watch_pull_request",
    },
    Redirect {
        command: ["pr", "checks"],
        when: When::Always,
        tool: "pull_request_status",
    },
    // pull_request_status needs the pull request's number or URL, so finding one, with no
    // argument or a branch, runs, as do `--comments`, `--web`, and fields it doesn't return.
    Redirect {
        command: ["pr", "view"],
        when: When::Answers {
            unless: &["--web", "-w", "--comments", "-c"],
            fields: &[
                "title",
                "body",
                "state",
                "isDraft",
                "headRefName",
                "baseRefName",
                "headRefOid",
                "files",
                "additions",
                "deletions",
                "mergeable",
                "mergeStateStatus",
                "reviewDecision",
                "statusCheckRollup",
            ],
        },
        tool: "pull_request_status",
    },
    // Any form that names the pull request; with none, or a branch, the tool has no URL.
    Redirect {
        command: ["pr", "diff"],
        when: When::Answers {
            unless: &[],
            fields: &[],
        },
        tool: "pull_request_diff",
    },
    Redirect {
        command: ["run", "watch"],
        when: When::Always,
        tool: "watch_pull_request",
    },
    Redirect {
        command: ["run", "view"],
        when: When::Any(&["--log-failed"]),
        tool: "ci_failure_log",
    },
];

/// Flags that take the next argument as their value, among those [`positionals`] skips: `-R` is
/// the one gh takes between a command and its subcommand.
const VALUE_FLAGS: &[&str] = &["-R", "--repo", "--json", "-q", "--jq", "-t", "--template"];

/// The indexes of `args`' arguments that aren't flags or a [`VALUE_FLAGS`] flag's value: the
/// command, the subcommand, and then the subcommand's own, such as a pull request.
fn positionals(args: &[String]) -> Vec<usize> {
    let mut found = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if VALUE_FLAGS.contains(&arg) {
            index += 1;
        } else if !arg.starts_with('-') {
            found.push(index);
        }
        index += 1;
    }
    found
}

/// Whether `flag` is among `args`, alone or as `flag=value`.
fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| {
        arg.strip_prefix(flag)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
    })
}

/// `args`' `--json` fields.
fn json_fields(args: &[String]) -> impl Iterator<Item = &str> {
    args.iter()
        .enumerate()
        .filter_map(|(index, arg)| match arg.strip_prefix("--json") {
            Some("") => args.get(index + 1).map(String::as_str),
            Some(inline) => inline.strip_prefix('='),
            None => None,
        })
        .flat_map(|fields| fields.split(','))
}

/// Whether `arg` names a pull request as `pull_request_status` takes one: a number (`12` or
/// `#12`) or a URL.
fn names_pull_request(arg: &str) -> bool {
    arg.trim_start_matches('#').parse::<u64>().is_ok()
        || arg.starts_with("https://")
        || arg.starts_with("http://")
}

/// Whether `args` asks for help, which runs without calling GitHub.
fn help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

/// The refusal for `args`, when a plxd tool replaces that command.
fn redirect(args: &[String]) -> Option<String> {
    if help(args) {
        return None;
    }
    let positionals = positionals(args);
    let command: Vec<&str> = positionals
        .iter()
        .take(2)
        .map(|&index| args[index].as_str())
        .collect();
    let found = REDIRECTS.iter().find(|redirect| {
        command == redirect.command
            && match redirect.when {
                When::Always => true,
                When::Any(flags) => flags.iter().any(|flag| has_flag(args, flag)),
                When::Answers { unless, fields } => {
                    positionals
                        .get(2)
                        .is_some_and(|&index| names_pull_request(&args[index]))
                        && !unless.iter().any(|flag| has_flag(args, flag))
                        && json_fields(args).all(|field| fields.contains(&field))
                }
            }
    })?;
    let [group, sub] = found.command;
    Some(format!(
        "plxd: agents don't run gh {group} {sub} in Parallax; use the {} tool instead.",
        found.tool
    ))
}

/// Which of GitHub's quotas a request spends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Api {
    Rest,
    Graphql,
}

/// The quota `args` spends when it is a read, or `None` for a write, or a command that doesn't
/// call GitHub's API, spends another quota (`search`), or that the shim doesn't know. Writes
/// always run, so a merge isn't held up by a low quota.
// ponytail: by command group, as gh mostly calls them (pr, issue, and repo through GraphQL);
// look at each subcommand if a read gets refused against the wrong quota.
fn read_api(args: &[String]) -> Option<Api> {
    if help(args) {
        return None;
    }
    let positionals = positionals(args);
    let group = args[*positionals.first()?].as_str();
    if group == "api" {
        return api_read(&args[positionals[0] + 1..]);
    }
    let sub = args[*positionals.get(1)?].as_str();
    if ![
        "view", "list", "status", "checks", "diff", "watch", "download",
    ]
    .contains(&sub)
    {
        return None;
    }
    match (group, sub) {
        (
            "run" | "workflow" | "release" | "cache" | "gist" | "secret" | "variable" | "ruleset",
            _,
        )
        | ("pr", "diff") => Some(Api::Rest),
        ("pr" | "issue" | "repo" | "project" | "label", _) => Some(Api::Graphql),
        _ => None,
    }
}

/// `gh api`'s flags that take a value as the next argument.
const API_VALUE_FLAGS: &[&str] = &[
    "-H",
    "--header",
    "-X",
    "--method",
    "-f",
    "--raw-field",
    "-F",
    "--field",
    "--input",
    "-q",
    "--jq",
    "-t",
    "--template",
    "--hostname",
    "--cache",
    "-p",
    "--preview",
];

/// [`read_api`] for `gh api`'s arguments. A REST call is a read when its method is `GET`, given
/// or by default (no fields). A GraphQL call is a read unless it's a mutation, or its query comes
/// from a file (`--input`, `-F query=@file`) the shim doesn't open. `rate_limit` is free.
fn api_read(args: &[String]) -> Option<Api> {
    let mut endpoint = None;
    let mut method = None;
    let mut fields = false;
    let mut from_file = false;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if !arg.starts_with('-') {
            endpoint.get_or_insert(arg.as_str());
            continue;
        }
        // `--flag=value`, `--flag value`, `-f value`, or attached, as `-XPOST` or `-fbody=hi`.
        let (flag, value) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_owned())),
            _ if API_VALUE_FLAGS.contains(&arg.as_str()) => (arg.as_str(), rest.next().cloned()),
            _ if !arg.starts_with("--") => match (arg.get(..2), arg.get(2..)) {
                (Some(flag), Some(value)) if !value.is_empty() => (flag, Some(value.to_owned())),
                _ => continue,
            },
            _ => continue,
        };
        match flag {
            "-X" | "--method" => method = value,
            "-f" | "--raw-field" | "-F" | "--field" => {
                fields = true;
                from_file |= value.is_some_and(|value| value.contains("=@"));
            }
            "--input" => {
                fields = true;
                from_file = true;
            }
            _ => {}
        }
    }
    match endpoint?.trim_start_matches('/') {
        "rate_limit" => None,
        "graphql" => {
            (!from_file && !args.iter().any(|arg| arg.contains("mutation"))).then_some(Api::Graphql)
        }
        _ => {
            let get = match method {
                Some(method) => method.eq_ignore_ascii_case("GET"),
                // gh sends a POST when there are fields and no method.
                None => !fields,
            };
            get.then_some(Api::Rest)
        }
    }
}

/// One of GitHub's quotas, as last seen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    /// Requests left until `reset_at`.
    pub remaining: u64,
    /// When the quota resets to full.
    pub reset_at: Timestamp,
    /// When plxd saw it.
    pub seen_at: Timestamp,
}

impl Quota {
    /// Whether it needs reading again at `now`: over [`FRESH`] old, or past its reset.
    fn stale(self, now: Timestamp) -> bool {
        now.duration_since(self.seen_at) > FRESH || now >= self.reset_at
    }
}

/// `github-budget.json`: the REST and GraphQL quotas the host's `gh` login has left, and what
/// `github_budget` returns.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// The REST API's quota.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest: Option<Quota>,
    /// The GraphQL API's quota.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphql: Option<Quota>,
    /// When the shim or `github_budget` last ran `gh api rate_limit`, whether or not it answered.
    /// Neither runs it again within [`FRESH`], so a `gh` that fails or hangs costs one try a
    /// minute, and meanwhile commands run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<Timestamp>,
}

impl Budget {
    fn get(&self, api: Api) -> Option<Quota> {
        match api {
            Api::Rest => self.rest,
            Api::Graphql => self.graphql,
        }
    }

    /// The newer of `self`'s and `other`'s quotas and checks.
    fn newest(self, other: Self) -> Self {
        let newer = |a: Option<Quota>, b: Option<Quota>| match (a, b) {
            (Some(a), Some(b)) => Some(if b.seen_at > a.seen_at { b } else { a }),
            (a, b) => a.or(b),
        };
        Self {
            rest: newer(self.rest, other.rest),
            graphql: newer(self.graphql, other.graphql),
            checked_at: self.checked_at.max(other.checked_at),
        }
    }

    /// `self` without what can't be real at `now`: a quota seen in the future or resetting over
    /// an hour from now (GitHub's quotas reset hourly), or a check in the future. So a budget
    /// file someone else wrote can't hold reads back past the next reset.
    fn sane(self, now: Timestamp) -> Self {
        let latest_reset = now + SignedDuration::from_hours(1);
        let real = |quota: &Quota| quota.seen_at <= now && quota.reset_at <= latest_reset;
        Self {
            rest: self.rest.filter(real),
            graphql: self.graphql.filter(real),
            checked_at: self.checked_at.filter(|at| *at <= now),
        }
    }
}

/// The budget file's name in the data folder.
const BUDGET_FILE: &str = "github-budget.json";

/// `<data>/tools/gh-shim`, the folder agents get first on `PATH`.
#[must_use]
pub fn dir(data_dir: &DataDir) -> PathBuf {
    shim_dir(data_dir.root())
}

fn shim_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tools").join("gh-shim")
}

/// What a worker's sandbox lets its commands read in data folder `data_dir`, so they get the
/// shim: its folder and the budget file.
pub(crate) fn sandbox_readable(data_dir: &Path) -> [PathBuf; 2] {
    [shim_dir(data_dir), data_dir.join(BUDGET_FILE)]
}

/// Whether `dir` is a shim folder, of this data folder or another's, so the shim never runs
/// itself or another plxd's shim as the real `gh`.
fn is_shim_dir(dir: &Path) -> bool {
    dir.file_name() == Some(OsStr::new("gh-shim"))
        && dir.parent().and_then(Path::file_name) == Some(OsStr::new("tools"))
}

/// `<data>/github-budget.json`.
fn budget_file(data_dir: &DataDir) -> PathBuf {
    data_dir.root().join(BUDGET_FILE)
}

/// Where the shim keeps the budget when it can't write the data folder's, as in a worker's
/// sandbox, which can read it but not write it: `$TMPDIR`, the run's own folder in a sandbox and
/// the user's own on macOS. None without `TMPDIR`, since a shared `/tmp` would let another user
/// plant one.
fn fallback_file() -> Option<PathBuf> {
    let dir = std::env::var_os("TMPDIR").filter(|dir| !dir.is_empty())?;
    Some(Path::new(&dir).join(format!("plxd-{BUDGET_FILE}")))
}

/// Whether `file` belongs to this user, so a fallback file someone else made is ignored.
#[cfg(unix)]
fn owned_by_me(file: &Path) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::metadata(file)
        .is_ok_and(|metadata| metadata.uid() == rustix::process::getuid().as_raw())
}

/// Whether `file` belongs to this user; on Windows, every user's temp folder is their own.
#[cfg(not(unix))]
fn owned_by_me(_: &Path) -> bool {
    true
}

/// Puts the running plxd in [`dir`] as `gh`: a symlink, or on Windows a hard link (a copy when
/// that fails), so it follows a self-update on the next start. Does nothing when the running
/// executable isn't plxd, such as a test binary.
///
/// # Errors
///
/// When the link can't be made.
pub(crate) fn install(data_dir: &DataDir) -> io::Result<()> {
    let exe = crate::executable()?;
    if exe.file_stem() != Some(OsStr::new("plxd")) {
        return Ok(());
    }
    let dir = dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    // Made beside it and renamed over it, so a `gh` call never finds it missing.
    let temp = dir.join(format!("{GH}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&exe, &temp)?;
    #[cfg(windows)]
    std::fs::hard_link(&exe, &temp).or_else(|_| std::fs::copy(&exe, &temp).map(drop))?;
    std::fs::rename(&temp, dir.join(GH)).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// The real `gh`: the first on `path` outside any shim folder, else plxd's own install.
fn real_gh(path: Option<&OsStr>, data_dir: Option<&DataDir>) -> Option<PathBuf> {
    path.into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| !dir.as_os_str().is_empty() && !is_shim_dir(dir))
        .map(|dir| dir.join(GH))
        .chain(data_dir.map(|dir| crate::github::bin_dir(dir).join(GH)))
        .find(|gh| gh.is_file())
}

/// Serializes this process's writes to the budget file. Writes from other processes can race;
/// the loser's quota is read again within [`FRESH`].
static WRITING: Mutex<()> = Mutex::new(());

/// Reads the budget from `file` and this user's [`fallback_file`], the newest of each that is
/// [`sane`](Budget::sane); an empty budget when both are missing or unreadable.
fn load(file: &Path) -> Budget {
    let now = Timestamp::now();
    let read = |file: &Path| -> Budget {
        std::fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Budget>(&bytes).ok())
            .unwrap_or_default()
            .sane(now)
    };
    let fallback = fallback_file()
        .filter(|fallback| owned_by_me(fallback))
        .map(|fallback| read(&fallback))
        .unwrap_or_default();
    read(file).newest(fallback)
}

/// Writes `budget` to `file` through a rename, so a reader never sees half of it.
fn save(file: &Path, budget: &Budget) -> io::Result<()> {
    let temp = file.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, serde_json::to_vec(budget)?)?;
    std::fs::rename(&temp, file)
}

/// Changes the budget file with `change`, logging a write that fails.
fn update(file: &Path, change: impl FnOnce(&mut Budget)) {
    let _writing = WRITING.lock().unwrap_or_else(PoisonError::into_inner);
    let mut budget = load(file);
    change(&mut budget);
    let saved = save(file, &budget).or_else(|error| match fallback_file() {
        Some(fallback) => save(&fallback, &budget),
        None => Err(error),
    });
    if let Err(error) = saved {
        tracing::debug!(%error, "couldn't save the GitHub budget");
    }
}

/// Records the GraphQL quota in a `gh api graphql` answer that asked for
/// `rateLimit { remaining resetAt }`, as the PR watch query does.
pub(crate) fn record_graphql(data_dir: &DataDir, answer: &str) {
    let Ok(answer) = serde_json::from_str::<Value>(answer) else {
        return;
    };
    let limit = &answer["data"]["rateLimit"];
    let (Some(remaining), Some(reset_at)) = (
        limit["remaining"].as_u64(),
        limit["resetAt"].as_str().and_then(|at| at.parse().ok()),
    ) else {
        return;
    };
    let seen_at = Timestamp::now();
    update(&budget_file(data_dir), |budget| {
        budget.graphql = Some(Quota {
            remaining,
            reset_at,
            seen_at,
        });
    });
}

/// `gh api rate_limit`'s answer as a budget seen at `seen_at`.
fn parse_rate_limit(answer: &[u8], seen_at: Timestamp) -> Option<Budget> {
    let answer: Value = serde_json::from_slice(answer).ok()?;
    let quota = |name: &str| {
        let resource = &answer["resources"][name];
        Some(Quota {
            remaining: resource["remaining"].as_u64()?,
            reset_at: Timestamp::from_second(resource["reset"].as_i64()?).ok()?,
            seen_at,
        })
    };
    Some(Budget {
        rest: Some(quota("core")?),
        graphql: Some(quota("graphql")?),
        checked_at: None,
    })
}

/// Reads both quotas with `gh api rate_limit` and saves them, with when it asked. `None` when
/// `gh` fails or takes over [`REFRESH_TIMEOUT`], which saves only when it asked.
fn refresh(gh: &Path, file: &Path, now: Timestamp) -> Option<Budget> {
    let budget = ask_rate_limit(gh).map(|budget| Budget {
        checked_at: Some(now),
        ..budget
    });
    update(file, |saved| match budget {
        Some(budget) => *saved = budget,
        None => saved.checked_at = Some(now),
    });
    budget
}

/// `gh api rate_limit`'s answer, unless it fails or takes over [`REFRESH_TIMEOUT`].
fn ask_rate_limit(gh: &Path) -> Option<Budget> {
    let mut child = Command::new(gh)
        .args(["api", "rate_limit"])
        .env(OFF_ENV, "off")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + REFRESH_TIMEOUT;
    // The answer is about 2 KB, well under a pipe's buffer, so `gh` can exit before it's read.
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    parse_rate_limit(&output.stdout, Timestamp::now()).filter(|_| output.status.success())
}

/// The budget, read again with `gh` when the quota `api` names, or either when `None`, is stale,
/// unless `gh` was asked within [`FRESH`].
fn current(gh: Option<&Path>, file: &Path, api: Option<Api>, now: Timestamp) -> Budget {
    let budget = load(file);
    let stale = |quota: Option<Quota>| quota.is_none_or(|quota| quota.stale(now));
    let wanted = match api {
        Some(api) => stale(budget.get(api)),
        None => stale(budget.rest) || stale(budget.graphql),
    } && budget
        .checked_at
        .is_none_or(|at| now.duration_since(at) > FRESH);
    match gh {
        Some(gh) if wanted => refresh(gh, file, now).unwrap_or(budget),
        _ => budget,
    }
}

/// The refusal for a read of `api` at `now`, when under [`LOW`] of its quota is left.
fn low(budget: &Budget, api: Api, now: Timestamp) -> Option<String> {
    let quota = budget
        .get(api)
        .filter(|quota| quota.remaining < LOW && now < quota.reset_at)?;
    let name = match api {
        Api::Rest => "REST",
        Api::Graphql => "GraphQL",
    };
    let minutes = now
        .duration_until(quota.reset_at)
        .as_secs()
        .unsigned_abs()
        .div_ceil(60);
    Some(format!(
        "plxd: GitHub's {name} quota is down to {} requests until it resets at {} (in {minutes} min); wait for the reset instead of spending the rest. The github_budget tool reports it.",
        quota.remaining, quota.reset_at
    ))
}

/// `github_budget`'s answer: the budget, read again with the real `gh` when over [`FRESH`] old.
#[must_use]
pub fn budget(data_dir: &DataDir) -> Budget {
    let gh = real_gh(std::env::var_os("PATH").as_deref(), Some(data_dir));
    current(
        gh.as_deref(),
        &budget_file(data_dir),
        None,
        Timestamp::now(),
    )
}

/// Whether plxd was run as `gh`, by `argv0`'s file name.
#[must_use]
pub fn invoked(argv0: Option<&OsStr>) -> bool {
    argv0
        .and_then(|program| Path::new(program).file_stem())
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("gh"))
}

/// What the shim does with `args`, `gh`'s arguments: an exit code and the line to print for a
/// refusal, or the real `gh` to run.
enum Decision {
    Refuse(String),
    Run(PathBuf),
    NotFound,
}

fn decide(
    args: &[OsString],
    path: Option<&OsStr>,
    data_dir: Option<&DataDir>,
    on: bool,
) -> Decision {
    let text: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if on && let Some(refusal) = redirect(&text) {
        return Decision::Refuse(refusal);
    }
    let Some(gh) = real_gh(path, data_dir) else {
        return Decision::NotFound;
    };
    if on && let (Some(api), Some(data_dir)) = (read_api(&text), data_dir) {
        let now = Timestamp::now();
        let budget = current(Some(&gh), &budget_file(data_dir), Some(api), now);
        if let Some(refusal) = low(&budget, api, now) {
            return Decision::Refuse(refusal);
        }
    }
    Decision::Run(gh)
}

/// Runs plxd as `gh` with `args`, its arguments after the program name.
pub fn main(args: &[OsString]) -> ! {
    let data_dir =
        DataDir::resolve(std::env::var_os(DATA_DIR_ENV).map(PathBuf::from).as_deref()).ok();
    let on = std::env::var_os(OFF_ENV).is_none_or(|value| value != "off");
    let path = std::env::var_os("PATH");
    match decide(args, path.as_deref(), data_dir.as_ref(), on) {
        Decision::Refuse(refusal) => {
            eprintln!("{refusal}");
            std::process::exit(EXIT_REFUSED)
        }
        Decision::NotFound => {
            eprintln!("plxd: gh isn't installed; Parallax can install it in Settings.");
            std::process::exit(127)
        }
        Decision::Run(gh) => run(&gh, args),
    }
}

/// Runs the real `gh` with `args` in this process's place, so stdin, stdout, stderr, signals,
/// and the exit code are its own.
#[cfg(unix)]
fn run(gh: &Path, args: &[OsString]) -> ! {
    use std::os::unix::process::CommandExt as _;
    let error = Command::new(gh).args(args).exec();
    eprintln!("plxd: couldn't run {}: {error}", gh.display());
    std::process::exit(127)
}

/// Runs the real `gh` with `args`, sharing this process's stdin, stdout, and stderr, and exits
/// with its exit code.
#[cfg(windows)]
fn run(gh: &Path, args: &[OsString]) -> ! {
    match Command::new(gh).args(args).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("plxd: couldn't run {}: {error}", gh.display());
            std::process::exit(127)
        }
    }
}
