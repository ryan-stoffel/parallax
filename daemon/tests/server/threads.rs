//! Normal threads end to end (#110): `thread/*` and `repo/*` against an in-process server whose
//! worker backend is the fake CLI, in real git repositories.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::jsonrpc::{ErrorObject, INVALID_PARAMS};
use parallax_protocol::methods::{
    AgentEvents, AgentList, AgentSend, EventsSubscribe, HostHealth, RepoAdd, ThreadArchive,
    ThreadDelete, ThreadList, ThreadStart, ThreadUpdate,
};
use parallax_protocol::{
    AccountChoice, AgentEffort, AgentEventsParams, AgentListParams, AgentPermission,
    AgentSendParams, AgentStatus, ErrorKind, EventsEventParams, EventsSubscribeParams,
    HostHealthParams, ParallaxEvent, Provider, RepoAddParams, RepoId, RunId, ScopeId,
    ThreadArchiveParams, ThreadDeleteParams, ThreadListParams, ThreadListResult, ThreadStartParams,
    ThreadUpdateParams, TurnId,
};
use plxd::backend::fake::{FakeBackend, Step};
use plxd::backend::{Backend, Capabilities, RunRequest, StartError, Started};
use plxd::routing::BackendRegistry;
use tempfile::TempDir;
use tokio::time::Instant;

use crate::agents::{
    Conn, end_turn, fake, fake_backend, git, init, named_repo, scope, send_params, text, until,
    updated_to,
};
use crate::support::{InProcess, PATIENCE, eventually, kind, temp_dir};

mod checkpoints;
mod context;
mod files;
mod fork;
mod from_threads;
mod orchestrator;
mod projects;
mod schedules;
mod scripts;
#[cfg(unix)]
mod sessions;

fn real_repo(dir: &Path, name: &str) -> PathBuf {
    named_repo(dir, name).canonicalize().unwrap()
}

/// A run's model, effort, permission, approvals, and whether it ran as a thread (0034), as its
/// backend got them.
type Options = (
    Option<String>,
    Option<AgentEffort>,
    Option<AgentPermission>,
    bool,
    bool,
);

/// The fake CLI as a backend that maps only `low` and `high` effort and the `plan` permission
/// (PLX-97), and records each run's options.
struct WithOptions {
    fake: FakeBackend,
    seen: Arc<Mutex<Vec<Options>>>,
}

impl Backend for WithOptions {
    fn name(&self) -> &str {
        self.fake.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        let options = (
            request.model.clone(),
            request.effort,
            request.permission,
            request.approvals,
            request.thread,
        );
        self.seen.lock().unwrap().push(options);
        self.fake.start(request)
    }

    fn efforts(&self) -> &'static [AgentEffort] {
        &[AgentEffort::Low, AgentEffort::High]
    }

    fn permissions(&self) -> &'static [AgentPermission] {
        &[AgentPermission::Plan]
    }
}

/// A host whose worker backend is [`WithOptions`] running `steps`, and what that backend saw.
fn with_options(steps: Vec<Step>) -> (Host, Arc<Mutex<Vec<Options>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(WithOptions {
            fake: fake_backend(steps),
            seen: Arc::clone(&seen),
        }),
    );
    (Host::start(backends), seen)
}

fn editing() -> Vec<Step> {
    vec![
        init("thread-1"),
        Step::WriteFile {
            path: "NOTES.md".to_owned(),
            content: "Written in a thread.\n".to_owned(),
        },
        text("Done."),
        end_turn("Done."),
    ]
}

fn hang() -> Vec<Step> {
    vec![init("hang-1"), Step::Hang]
}

/// `agent/send` params for `text`, changing no run options.
fn message(run_id: RunId, text: &str) -> AgentSendParams {
    send_params(run_id, TurnId::generate(), text)
}

/// `thread/update` params that mark `run_id` seen or snooze it (0033), and change nothing else.
fn attention(
    run_id: RunId,
    seen: bool,
    snoozed_until: Option<jiff::Timestamp>,
) -> ThreadUpdateParams {
    ThreadUpdateParams {
        run_id,
        seen,
        snoozed_until,
        title: None,
        settled: None,
        pinned: None,
    }
}

pub(crate) fn start_params(repo: Option<RepoId>, prompt: &str) -> ThreadStartParams {
    ThreadStartParams {
        run_id: RunId::generate(),
        repo,
        orchestrator: None,
        parent: None,
        notify: None,
        title: None,
        prompt: prompt.to_owned(),
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        branch_slug: None,
        images: Vec::new(),
        approvals: false,
        checkout: false,
        base: None,
        checkout_ref: None,
        threads: Vec::new(),
        naming: None,
    }
}

struct Host {
    /// plxd's data folder.
    dir: TempDir,
    /// Where the tests' own repositories live: outside the data folder, which `repo/add` refuses.
    work: TempDir,
    server: InProcess,
}

impl Host {
    fn start(backends: BackendRegistry) -> Self {
        let dir = temp_dir();
        let server = serve(&dir, backends);
        Self {
            dir,
            work: temp_dir(),
            server,
        }
    }

    async fn client(&self) -> Conn {
        Conn::ready(&self.server.socket).await
    }

    fn data(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    /// Stops plxd and starts a new one on the same data folder.
    async fn restart(self, backends: BackendRegistry) -> Self {
        let Self { dir, work, server } = self;
        server.stop().await;
        Self {
            server: serve(&dir, backends),
            dir,
            work,
        }
    }
}

/// An in-process plxd on the data folder `dir`, running `backends`.
fn serve(dir: &TempDir, backends: BackendRegistry) -> InProcess {
    let mut config = InProcess::config(dir.path());
    config.backends = Some(backends);
    InProcess::start(config)
}

/// Thread-scoped calls on [`Conn`].
impl Conn {
    async fn subscribe(&mut self, after: u64, project: Option<ScopeId>) {
        self.call::<EventsSubscribe>(EventsSubscribeParams {
            after,
            project,
            run: None,
            shell: false,
        })
        .await
        .unwrap();
    }

    /// [`until`], as a method.
    async fn until(
        &mut self,
        done: impl FnMut(&EventsEventParams) -> bool,
    ) -> Vec<EventsEventParams> {
        until(self, done).await
    }

    async fn running_agents(&mut self) -> u32 {
        self.call::<HostHealth>(HostHealthParams {})
            .await
            .unwrap()
            .running_agents
    }

    async fn delete(&mut self, run_id: RunId) -> Result<(), ErrorObject> {
        self.call::<ThreadDelete>(ThreadDeleteParams { run_id })
            .await
            .map(|_| ())
    }

    async fn list(&mut self) -> ThreadListResult {
        self.call::<ThreadList>(ThreadListParams {}).await.unwrap()
    }
}

#[tokio::test]
async fn a_thread_in_the_current_checkout_works_on_the_branch_the_user_has_out() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    git(&path, &["checkout", "-q", "-b", "my-feature"]);
    let head = git(&path, &["rev-parse", "HEAD"]);
    // The user's own uncommitted work, which the thread must neither commit nor lose.
    std::fs::write(path.join("README.md"), "hello, edited by the user\n").unwrap();
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(repo.id))).await;

    let params = ThreadStartParams {
        checkout: true,
        branch_slug: Some("not-used".to_owned()),
        ..start_params(Some(repo.id), "Write some notes")
    };
    let started = client.call::<ThreadStart>(params.clone()).await.unwrap();
    assert!(started.run.checkout);
    assert_eq!(started.run.branch, None, "no branch of its own");
    assert_eq!(started.run.worktree_path, None, "no worktree of its own");
    let retried = client.call::<ThreadStart>(params.clone()).await.unwrap();
    assert_eq!(retried.thread, started.thread, "idempotent on the run id");
    let in_worktree = ThreadStartParams {
        checkout: false,
        ..params.clone()
    };
    let conflict = client.call::<ThreadStart>(in_worktree).await.unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);

    let events = runs.until(updated_to(AgentStatus::Completed)).await;
    let seen = events.last().unwrap().seq;
    assert!(
        !events
            .iter()
            .any(|event| matches!(&event.event, ParallaxEvent::AgentUpdated { state, .. } if state.diff.is_some())),
        "nothing is committed, so there is no diff"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("NOTES.md")).unwrap(),
        "Written in a thread.\n",
        "the change lands in the user's checkout"
    );
    assert_eq!(git(&path, &["branch", "--show-current"]), "my-feature");
    assert_eq!(
        git(&path, &["rev-parse", "HEAD"]),
        head,
        "nothing is committed"
    );
    assert_eq!(
        git(&path, &["status", "--porcelain"]),
        "M README.md\n?? NOTES.md",
        "the user's own edit is kept, uncommitted, beside the thread's"
    );
    assert_eq!(
        git(&path, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|line| line.starts_with("worktree "))
            .count(),
        1,
        "no worktree was made"
    );
    assert!(!host.data().join("worktrees").join("app").exists());
    assert_eq!(git(&path, &["branch", "--list", "parallax/*"]), "");

    // After a restart, a message resumes it in the same checkout.
    drop((client, runs));
    let host = host.restart(fake(editing())).await;
    let mut client = host.client().await;
    let mut runs = host.client().await;
    runs.subscribe(seen, Some(scope(repo.id))).await;
    std::fs::remove_file(path.join("NOTES.md")).unwrap();
    client
        .call::<AgentSend>(message(params.run_id, "Write them again"))
        .await
        .unwrap();
    runs.until(updated_to(AgentStatus::Completed)).await;
    assert!(
        path.join("NOTES.md").is_file(),
        "the resumed run wrote here"
    );
    assert_eq!(git(&path, &["rev-parse", "HEAD"]), head);

    // Deleting the thread leaves the checkout and its changes alone.
    client.delete(params.run_id).await.unwrap();
    assert!(path.join("NOTES.md").is_file());
    assert_eq!(git(&path, &["branch", "--show-current"]), "my-feature");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "hello, edited by the user\n"
    );
}

#[tokio::test]
async fn deleting_a_running_thread_stops_its_agent_and_removes_everything() {
    let host = Host::start(fake(hang()));
    let mut client = host.client().await;
    let params = start_params(None, "Wait for me");
    let started = client.call::<ThreadStart>(params.clone()).await.unwrap();
    let repository = host.data().join("scratch").join(params.run_id.to_string());
    let context = host.data().join("context").join(params.run_id.to_string());
    let worktree = PathBuf::from(started.run.worktree_path.unwrap());
    client.subscribe(0, None).await;
    client.subscribe(0, Some(scope(started.thread.repo))).await;
    client.until(updated_to(AgentStatus::Running)).await;
    assert!(context.is_dir(), "a thread with no repo has its own notes");
    assert!(
        !host
            .data()
            .join("context")
            .join(started.thread.repo.to_string())
            .exists(),
        "quick chats share no notes"
    );

    let archived = client
        .call::<ThreadArchive>(ThreadArchiveParams {
            run_id: params.run_id,
            archived: true,
        })
        .await
        .unwrap()
        .thread;
    assert!(archived.archived);
    client
        .until(
            |event| matches!(&event.event, ParallaxEvent::ThreadUpdated { thread } if thread.archived),
        )
        .await;
    assert!(client.list().await.threads[0].archived);

    client.delete(params.run_id).await.unwrap();
    client
        .until(|event| matches!(&event.event, ParallaxEvent::ThreadDeleted { run_id, .. } if *run_id == params.run_id))
        .await;
    assert_eq!(client.running_agents().await, 0, "the agent was stopped");

    assert!(client.list().await.threads.is_empty());
    let runs = client
        .call::<AgentList>(AgentListParams {
            project: Some(scope(started.thread.repo)),
        })
        .await
        .unwrap()
        .runs;
    assert!(runs.is_empty());
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            before: None,
            run_id: params.run_id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&events), ErrorKind::RunNotFound);
    // The cleanup effect runs once the delete commits (0059).
    eventually(
        "the worktree, the scratch repository, and the thread's notes are removed",
        || !worktree.exists() && !repository.exists() && !context.exists(),
    )
    .await;

    let mut replay = host.client().await;
    replay.subscribe(0, Some(scope(started.thread.repo))).await;
    let health = replay.running_agents().await;
    assert_eq!(health, 0);
    assert!(
        replay
            .pending
            .iter()
            .all(|event| event.project != Some(scope(started.thread.repo))),
        "a deleted thread's transcript isn't replayed: {:#?}",
        replay.pending
    );

    let missing = client.delete(params.run_id).await.unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::ThreadNotFound);
}

#[tokio::test]
async fn repo_entries_and_threads_refuse_what_they_cant_run() {
    let host = Host::start(fake(editing()));
    let mut client = host.client().await;
    let plain = host.work.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let error = client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: plain.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::NotARepository);
    let relative = client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: "repos/app".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(relative.code, INVALID_PARAMS);

    let notes = host.data().join("context").join("planted");
    std::fs::create_dir_all(&notes).unwrap();
    git(&notes, &["init", "-q"]);
    let inside = client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: notes.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&inside), ErrorKind::NotARepository, "{inside:?}");
    let link = host.work.path().join("link");
    std::os::unix::fs::symlink(&notes, &link).unwrap();
    let linked = client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: link.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(
        kind(&linked),
        ErrorKind::NotARepository,
        "a link into the data folder"
    );

    let path = real_repo(host.work.path(), "app");
    let other = real_repo(host.work.path(), "other");
    let id = RepoId::generate();
    client
        .call::<RepoAdd>(RepoAddParams {
            id,
            path: path.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap();
    let conflict = client
        .call::<RepoAdd>(RepoAddParams {
            id,
            path: other.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);

    let unknown = client
        .call::<ThreadStart>(start_params(Some(RepoId::generate()), "Anything"))
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RepoNotFound);
    let empty = client
        .call::<ThreadStart>(start_params(None, "  "))
        .await
        .unwrap_err();
    assert_eq!(empty.code, INVALID_PARAMS);
    let archive = client
        .call::<ThreadArchive>(ThreadArchiveParams {
            run_id: RunId::generate(),
            archived: true,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&archive), ErrorKind::ThreadNotFound);
}

/// Commits a change to `file` in `repo`, committed at `date`.
fn commit_at(repo: &Path, file: &str, date: &str) {
    std::fs::write(repo.join(file), date).unwrap();
    git(repo, &["add", "-A"]);
    let output = Command::new("git")
        .args(["commit", "-q", "-m", file])
        .current_dir(repo)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .expect("git runs");
    assert!(output.status.success(), "{output:?}");
}

/// `thread/start`'s `checkoutRef` switches the checkout first, a remote-tracking ref to a local
/// branch that tracks it, and never over the user's changes.
#[tokio::test]
async fn a_checkout_thread_switches_to_the_ref_it_picks_but_never_over_changes() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    git(&path, &["checkout", "-q", "-b", "feature"]);
    commit_at(&path, "README.md", "2021-01-01T00:00:00Z");
    git(&path, &["checkout", "-q", "main"]);
    // Never fetched: git only needs the remote's refspec to set up tracking.
    git(
        &path,
        &["remote", "add", "origin", "https://example.invalid/app.git"],
    );
    git(
        &path,
        &["update-ref", "refs/remotes/origin/topic", "feature"],
    );
    git(&path, &["branch", "-q", "-D", "feature"]);
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(repo.id))).await;

    let params = ThreadStartParams {
        checkout: true,
        checkout_ref: Some("origin/topic".to_owned()),
        ..start_params(Some(repo.id), "Write some notes")
    };
    client.call::<ThreadStart>(params.clone()).await.unwrap();
    assert_eq!(git(&path, &["branch", "--show-current"]), "topic");
    assert_eq!(
        git(&path, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]),
        "origin/topic"
    );
    runs.until(updated_to(AgentStatus::Completed)).await;

    // The user's edit to a file `main` has otherwise: git refuses, and nothing starts.
    std::fs::write(path.join("README.md"), "the user's edit\n").unwrap();
    let refused = client
        .call::<ThreadStart>(ThreadStartParams {
            checkout: true,
            checkout_ref: Some("main".to_owned()),
            ..start_params(Some(repo.id), "Write more notes")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::WorktreeFailed);
    assert!(refused.message.contains("overwritten"), "{refused:?}");
    assert_eq!(git(&path, &["branch", "--show-current"]), "topic");
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "the user's edit\n"
    );
    assert_eq!(client.list().await.threads.len(), 1);
}

/// A `checkoutRef` never switches a checkout another thread is running in, which would move that
/// thread's work to a branch it never chose.
#[tokio::test]
async fn a_checkout_thread_never_switches_under_a_running_one() {
    let host = Host::start(fake(hang()));
    let path = real_repo(host.work.path(), "app");
    git(&path, &["branch", "-q", "other"]);
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(repo.id))).await;
    client
        .call::<ThreadStart>(ThreadStartParams {
            checkout: true,
            ..start_params(Some(repo.id), "Keep working")
        })
        .await
        .unwrap();
    runs.until(updated_to(AgentStatus::Running)).await;

    let refused = client
        .call::<ThreadStart>(ThreadStartParams {
            checkout: true,
            checkout_ref: Some("other".to_owned()),
            ..start_params(Some(repo.id), "Switch away")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::WorktreeFailed);
    assert_eq!(git(&path, &["branch", "--show-current"]), "main");
    assert_eq!(client.list().await.threads.len(), 1);
}

/// PLX-97, PLX-222: a thread's model, effort, permission, and approvals reach its backend when it
/// starts and when it resumes, come back on its run, and count for `thread/start`'s idempotency.
/// What the backend can't honor is refused before anything is made.
#[tokio::test]
async fn a_thread_keeps_its_model_effort_permission_and_approvals() {
    let (host, seen) = with_options(editing());
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(repo.id))).await;

    let params = ThreadStartParams {
        model: Some("opus".to_owned()),
        effort: Some(AgentEffort::High),
        permission: Some(AgentPermission::Plan),
        approvals: true,
        ..start_params(Some(repo.id), "Plan the notes")
    };
    let started = client.call::<ThreadStart>(params.clone()).await.unwrap();
    assert_eq!(started.run.model.as_deref(), Some("opus"));
    assert_eq!(started.run.effort, Some(AgentEffort::High));
    assert_eq!(started.run.permission, Some(AgentPermission::Plan));
    assert!(started.run.approvals);
    runs.until(updated_to(AgentStatus::Completed)).await;

    // The CLI has exited, so a message resumes the run, with the same options.
    client
        .call::<AgentSend>(message(params.run_id, "And a summary"))
        .await
        .unwrap();
    runs.until(updated_to(AgentStatus::Completed)).await;
    let options: Options = (
        Some("opus".to_owned()),
        Some(AgentEffort::High),
        Some(AgentPermission::Plan),
        true,
        true,
    );
    assert_eq!(*seen.lock().unwrap(), [options.clone(), options]);

    let retry = client.call::<ThreadStart>(params.clone()).await.unwrap();
    assert_eq!(retry.run.id, started.run.id);
    for changed in [
        ThreadStartParams {
            effort: None,
            ..params.clone()
        },
        ThreadStartParams {
            approvals: false,
            ..params
        },
    ] {
        let conflict = client.call::<ThreadStart>(changed).await.unwrap_err();
        assert_eq!(kind(&conflict), ErrorKind::IdConflict);
    }

    for refused in [
        ThreadStartParams {
            effort: Some(AgentEffort::Max),
            ..start_params(None, "Anything")
        },
        ThreadStartParams {
            permission: Some(AgentPermission::Edit),
            ..start_params(None, "Anything")
        },
        ThreadStartParams {
            model: Some("--dangerously-skip-permissions".to_owned()),
            ..start_params(None, "Anything")
        },
        ThreadStartParams {
            context_window: Some(200_000),
            ..start_params(None, "Anything")
        },
        ThreadStartParams {
            fast: Some(true),
            ..start_params(None, "Anything")
        },
    ] {
        let run_id = refused.run_id;
        let error = client.call::<ThreadStart>(refused).await.unwrap_err();
        assert_eq!(kind(&error), ErrorKind::UnsupportedOption, "{error:?}");
        let scratch = host.data().join("scratch").join(run_id.to_string());
        assert!(!scratch.exists(), "no scratch repository is left behind");
    }
    assert_eq!(
        client.list().await.threads.len(),
        1,
        "no other thread was made"
    );
    assert_eq!(seen.lock().unwrap().len(), 2, "no other run started");
}

/// The fake CLI under another name, as another provider's backend, recording each prompt it gets
/// and whether it resumed a session. Each start takes the next of `first`, where `None` refuses
/// to start, then `fake` once `first` is empty.
struct Other {
    fake: FakeBackend,
    first: Mutex<VecDeque<Option<FakeBackend>>>,
    prompts: Arc<Mutex<Vec<(String, bool)>>>,
}

impl Other {
    fn new(fake: FakeBackend, prompts: &Arc<Mutex<Vec<(String, bool)>>>) -> Self {
        Self {
            fake,
            first: Mutex::new(VecDeque::new()),
            prompts: Arc::clone(prompts),
        }
    }
}

impl Backend for Other {
    fn name(&self) -> &'static str {
        "other"
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        let prompt = (request.prompt.clone(), request.resume.is_some());
        self.prompts.lock().unwrap().push(prompt);
        match self.first.lock().unwrap().pop_front() {
            Some(Some(fake)) => fake.start(request),
            Some(None) => Err(StartError::Unsupported("refused".to_owned())),
            None => self.fake.start(request),
        }
    }
}

/// A message on another backend's account moves the thread there: the same run, worktree, and
/// transcript, on a new session that's told the conversation so far.
#[tokio::test]
async fn a_message_on_another_backends_account_moves_the_thread_there() {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut backends = fake(editing());
    backends.register(
        Provider::Openai,
        Arc::new(Other::new(fake_backend(editing()), &prompts)),
    );
    let host = Host::start(backends);
    let mut client = host.client().await;
    let params = start_params(None, "Write the notes");
    let started = client.call::<ThreadStart>(params.clone()).await.unwrap();
    let scope = scope(started.thread.repo);
    client.subscribe(0, Some(scope)).await;
    client.until(updated_to(AgentStatus::Completed)).await;

    let moved = client
        .call::<AgentSend>(AgentSendParams {
            model: Some("gpt-6".to_owned()),
            account: Some(AccountChoice::Subscription {
                backend: "other".to_owned(),
            }),
            ..message(params.run_id, "Now the tests")
        })
        .await
        .unwrap()
        .run;
    assert_eq!(moved.id, params.run_id, "the same thread");
    assert_eq!(moved.backend, "other");
    assert_eq!(moved.account_id, "other");
    assert_eq!(moved.model.as_deref(), Some("gpt-6"));
    assert_eq!(moved.branch, started.run.branch, "the same worktree");
    let events = client.until(updated_to(AgentStatus::Completed)).await;
    assert!(
        events.iter().any(|event| matches!(
            &event.event,
            ParallaxEvent::AgentUpdated { state, .. } if state.backend.as_deref() == Some("other")
        )),
        "agent.updated reports the move: {events:?}"
    );
    let prompts = prompts.lock().unwrap().clone();
    let [(prompt, resumed)] = prompts.as_slice() else {
        panic!("one CLI started on the other backend: {prompts:?}");
    };
    assert!(!resumed, "a new session");
    assert!(
        prompt.contains("User:\nWrite the notes\n\nAgent:\nDone.\n</conversation>"),
        "{prompt}"
    );
    assert!(
        prompt.ends_with("which is yours to answer:\nNow the tests"),
        "{prompt}"
    );
    host.server.stop().await;
}
