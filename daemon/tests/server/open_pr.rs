//! `agent/openPr` end to end (PLX-168): a run's branch goes to a local bare `origin`, and a fake
//! `gh` stands in for GitHub. plxd's `PATH` holds only git and that fake, so no test can reach
//! the real GitHub.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use parallax_protocol::methods::{AgentList, AgentOpenPr, AgentStart};
use parallax_protocol::{
    AgentListParams, AgentOpenPrParams, AgentStatus, RepoId, RunId, ThreadStartParams,
};
use plxd::backend::fake::Step;
use plxd::backend::process::{Environment, find_program};
use tempfile::TempDir;

use crate::agents::{
    Host, create, end_turn, fake, git, init, orchestrator_params, start_params, subscribe, until,
    updated_to,
};
use crate::support::{InProcess, temp_dir};

const URL: &str = "https://github.com/example/app/pull/7";

/// A folder that is plxd's whole `PATH`: the real git, and a fake `gh` that logs its arguments to
/// `gh.log`, answers `pr list` with a fork's pull request from a branch of the same name, then the
/// one `pr create` made, answers `pr view` with what [`Tools::view`] wrote, or for `--jq=.state`
/// with what [`Tools::state`] wrote, else `OPEN`, `pr diff` with a one-line diff, succeeds at
/// `pr merge`, `pr ready`, and `pr close`, and fails as `gh-mode` says: `signed-out` (exit 4, as gh
/// does) or `fail`.
pub(crate) struct Tools(TempDir);

impl Tools {
    pub(crate) fn new() -> Self {
        let tools = Self(temp_dir());
        let bin = tools.0.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let git = find_program("git".as_ref(), std::env::var_os("PATH").as_deref()).unwrap();
        let git = format!("#!/bin/sh\nexec '{}' \"$@\"\n", git.display());
        let gh = format!(
            r#"#!/bin/sh
# Builtins only: nothing else is on the PATH.
dir='{dir}'
# A GraphQL read logs as `api graphql`, without its query.
case "$1 $2" in
  'api graphql') echo 'api graphql' >> "$dir/gh.log" ;;
  *) printf '%s\n' "$*" >> "$dir/gh.log" ;;
esac
mode=; [ -f "$dir/gh-mode" ] && read -r mode < "$dir/gh-mode"
case "$mode" in
  signed-out) echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4 ;;
  fail) echo 'GraphQL: Could not resolve to a Repository' >&2; exit 1 ;;
esac
case "$1 $2" in
  'pr list')
    list='{{"url":"https://github.com/someone/app/pull/3","isCrossRepository":true}}'
    if [ -f "$dir/pr" ]; then
      read -r url < "$dir/pr"
      list="$list,{{\"url\":\"$url\",\"isCrossRepository\":false}}"
    fi
    echo "[$list]" ;;
  'pr create') echo '{URL}' > "$dir/pr"; echo 'Creating pull request' >&2; echo '{URL}' ;;
  'pr view')
    case "$*" in
      *--jq=.state*)
        state=OPEN; [ -f "$dir/state" ] && read -r state < "$dir/state"; echo "$state" ;;
      *) while IFS= read -r line; do printf '%s\n' "$line"; done < "$dir/view.json" ;;
    esac ;;
  'pr diff') echo 'diff --git a/README.md b/README.md' ;;
  'pr merge' | 'pr ready' | 'pr close' | 'pr update-branch' | 'api -X') ;;
  'api graphql')
    case "$*" in
      *behindBy*) echo '{{"data":{{"repository":{{"ref":{{"compare":{{"behindBy":2}}}}}}}}}}' ;;
      *) while IFS= read -r line; do printf '%s\n' "$line"; done < "$dir/graphql.json" ;;
    esac ;;
  *) exit 1 ;;
esac
"#,
            dir = tools.0.path().display()
        );
        for (name, script) in [("git", git), ("gh", gh)] {
            fs::write(bin.join(name), script).unwrap();
            fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        tools
    }

    pub(crate) fn environment(&self) -> Environment {
        let mut env = Environment::inherited();
        env.set("PATH", self.0.path().join("bin"));
        env
    }

    pub(crate) fn log(&self) -> Vec<String> {
        fs::read_to_string(self.0.path().join("gh.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// What `gh pr view` prints.
    pub(crate) fn view(&self, json: &str) {
        fs::write(self.0.path().join("view.json"), format!("{json}\n")).unwrap();
    }

    /// What `gh api graphql` prints for a pull request read, other than a compare.
    pub(crate) fn graphql(&self, json: &str) {
        fs::write(self.0.path().join("graphql.json"), format!("{json}\n")).unwrap();
    }

    /// What `gh pr view --jq=.state` prints.
    pub(crate) fn state(&self, state: &str) {
        fs::write(self.0.path().join("state"), format!("{state}\n")).unwrap();
    }

    pub(crate) fn mode(&self, mode: &str) {
        fs::write(self.0.path().join("gh-mode"), mode).unwrap();
    }
}

pub(crate) fn start(dir: TempDir, steps: Vec<Step>, tools: &Tools) -> Host {
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(steps));
    config.agent_environment = Some(tools.environment());
    Host {
        dir,
        server: InProcess::start(config),
    }
}

pub(crate) fn editing() -> Vec<Step> {
    vec![
        init("s"),
        Step::WriteFile {
            path: "README.md".to_owned(),
            content: "# App\n".to_owned(),
        },
        end_turn("Done."),
    ]
}

/// A bare repository under `dir`, added to `repo` as its `origin`.
pub(crate) fn add_origin(repo: &Path, dir: &Path) -> PathBuf {
    let origin = dir.join("origin.git");
    git(dir, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    git(repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
    origin
}

pub(crate) fn thread(repo: Option<RepoId>) -> ThreadStartParams {
    crate::threads::start_params(repo, "Rewrite the README")
}

pub(crate) fn open(run_id: RunId, title: &str, body: Option<&str>) -> AgentOpenPrParams {
    AgentOpenPrParams {
        run_id,
        title: title.to_owned(),
        body: body.map(str::to_owned),
    }
}

#[tokio::test]
async fn a_finished_run_pushes_its_branch_and_opens_one_pull_request() {
    let tools = Tools::new();
    let dir = temp_dir();
    let params = orchestrator_params(dir.path());
    let repo = PathBuf::from(&params.repo_path);
    let origin = add_origin(&repo, dir.path());
    let host = start(dir, editing(), &tools);
    let mut client = host.client().await;
    let project = create(&mut client, params).await;
    subscribe(&mut client, project.id, 0).await;
    let start = start_params(project.id, "Rewrite the README");
    let run_id = start.run_id;
    let run = client.call::<AgentStart>(start).await.unwrap().run;
    let branch = run.branch.unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    let opened = client
        .call::<AgentOpenPr>(open(
            run_id,
            "  Rewrite the README\nwith more",
            Some("Built in Parallax."),
        ))
        .await
        .unwrap();
    assert_eq!(opened.url, URL);
    let pushed = || git(&origin, &["rev-parse", &branch]);
    assert_eq!(pushed(), git(&repo, &["rev-parse", &branch]));
    let origin = origin.to_str().unwrap();
    assert_eq!(
        tools.log(),
        [
            format!(
                "pr list --repo={origin} --head={branch} --state=open \
                 --json=url,isCrossRepository"
            ),
            format!(
                "pr create --repo={origin} --head={branch} --title=Rewrite the README \
                 --body=Built in Parallax."
            ),
        ]
    );

    // Opening it again pushes a new commit and finds the same pull request.
    let worktree = PathBuf::from(run.worktree_path.unwrap());
    git(&worktree, &["commit", "-q", "--allow-empty", "-m", "More"]);
    let again = client
        .call::<AgentOpenPr>(open(run_id, "Rewrite the README", None))
        .await
        .unwrap();
    assert_eq!(again.url, URL);
    assert_eq!(pushed(), git(&worktree, &["rev-parse", "HEAD"]));
    assert_eq!(tools.log().len(), 3, "a list, and no second create");

    // The run links its pull request once (PLX-318).
    let runs = client
        .call::<AgentList>(AgentListParams::default())
        .await
        .unwrap()
        .runs;
    assert_eq!(runs[0].pull_requests, [URL]);
    host.server.stop().await;
}
