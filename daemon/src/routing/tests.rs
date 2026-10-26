use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::{AccountChoice, AccountId, Provider, Role};

use super::{BackendRegistry, Defaults, KeyAccounts, resolve, start};
use crate::backend::{
    AccountRef, Backend, CancelSwitch, Capabilities, Credential, EVENT_BUFFER, Event, EventSink,
    EventStream, Failure, FailureKind, Outcome, Resume, RunHandle, RunId, RunRequest, StartError,
    Started, ThreadTools, ToolPolicy, WorkerSandbox, claude,
};
use crate::keystore::{KeyStore, MemoryKeyStore};

fn root() -> PathBuf {
    PathBuf::from("/")
}

fn request(cwd: &Path) -> RunRequest {
    RunRequest {
        run_id: RunId::generate(),
        turn_id: None,
        cwd: cwd.to_owned(),
        prompt: "hi".into(),
        images: Vec::new(),
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: Some(WorkerSandbox::for_worktree(
            Path::new("/Users/u"),
            Path::new("/Users/u/parallax"),
            cwd,
            Path::new("/Users/u/src/app/.git"),
            Path::new("/Users/u/parallax/context/p"),
            Path::new("/tmp/parallax-1a2b3c4d/Ab12Cd"),
        )),
        account: AccountRef {
            id: "unset".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        coordinator_tools: None,
        thread_tools: None,
        approvals: false,
        thread: false,
        instructions: None,
    }
}

fn finished(outcome: Outcome) -> Event {
    Event::Finished {
        outcome,
        usage_totals: Vec::new(),
    }
}

fn failure(kind: FailureKind) -> Failure {
    Failure {
        failure: kind,
        message: format!("{kind:?}"),
        exit: None,
        stderr_tail: None,
    }
}

/// A [`Backend`] that emits one canned, pre-built event sequence per call to
/// [`Backend::start`], in order, and records each call's request and the [`CancelSwitch`] behind
/// its handle. Unlike [`crate::backend::fake::FakeBackend`], it spawns no process, so its
/// scripted attempts can differ from one call to the next: exactly what testing a fallback, which
/// restarts the same backend with a different credential, needs.
struct ScriptedBackend {
    attempts: Mutex<VecDeque<Vec<Event>>>,
    calls: Mutex<Vec<RunRequest>>,
    switches: Mutex<Vec<CancelSwitch>>,
}

impl ScriptedBackend {
    fn new(attempts: Vec<Vec<Event>>) -> Self {
        Self {
            attempts: Mutex::new(attempts.into()),
            calls: Mutex::new(Vec::new()),
            switches: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<RunRequest> {
        self.calls.lock().unwrap().clone()
    }

    /// Each call's cancel switch, in order, so a test can tell which attempt a `cancel()` reached.
    fn switches(&self) -> Vec<CancelSwitch> {
        self.switches.lock().unwrap().clone()
    }
}

impl Backend for ScriptedBackend {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.calls.lock().unwrap().push(request.clone());
        let events = self
            .attempts
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("the scripted backend has no more attempts queued"));
        let (mut sink, stream) = EventSink::channel(EVENT_BUFFER, Vec::new());
        tokio::spawn(async move {
            for event in events {
                if sink.emit(event).await.is_err() {
                    return;
                }
            }
        });
        let switch = CancelSwitch::new();
        self.switches.lock().unwrap().push(switch.clone());
        let (handle, _control) = RunHandle::new(request.run_id, false, switch);
        Ok(Started {
            run: Arc::new(handle),
            events: stream,
        })
    }
}

fn registry(backend: Arc<dyn Backend>) -> BackendRegistry {
    let mut registry = BackendRegistry::new();
    registry.register(Provider::Anthropic, backend);
    registry
}

#[derive(Default)]
struct FixedAccounts {
    providers: HashMap<AccountId, Provider>,
    fallbacks: HashMap<Provider, AccountId>,
}

impl KeyAccounts for FixedAccounts {
    fn provider_of(&self, id: AccountId) -> Option<Provider> {
        self.providers.get(&id).copied()
    }

    fn fallback_for(&self, provider: Provider) -> Option<AccountId> {
        self.fallbacks.get(&provider).copied()
    }
}

async fn next(events: &mut EventStream) -> Event {
    tokio::time::timeout(Duration::from_secs(10), events.next())
        .await
        .expect("no event within 10s")
        .expect("the stream ended")
}

async fn rest(events: &mut EventStream) -> Vec<Event> {
    let mut all = Vec::new();
    loop {
        let event = next(events).await;
        let terminal = event.is_terminal();
        all.push(event);
        if terminal {
            assert!(events.next().await.is_none(), "Finished must be last");
            return all;
        }
    }
}

fn subscription_choice() -> AccountChoice {
    AccountChoice::Subscription {
        backend: "claude".into(),
    }
}

/// A backend whose one attempt completes.
fn completing() -> Arc<ScriptedBackend> {
    Arc::new(ScriptedBackend::new(vec![vec![finished(
        Outcome::Completed { result: None },
    )]]))
}

fn no_keys() -> Arc<dyn KeyStore> {
    Arc::new(MemoryKeyStore::new())
}

// ---------------------------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// start() and its fallback
// ---------------------------------------------------------------------------------------------

fn key_store_with(id: AccountId, key: &str) -> Arc<dyn KeyStore> {
    let store = MemoryKeyStore::new();
    store.set(id, key).unwrap();
    Arc::new(store)
}

fn accounts_with_fallback(id: AccountId) -> FixedAccounts {
    let mut accounts = FixedAccounts::default();
    accounts.providers.insert(id, Provider::Anthropic);
    accounts.fallbacks.insert(Provider::Anthropic, id);
    accounts
}

fn resolved_subscription(backend: Arc<dyn Backend>) -> super::Resolved {
    resolved_for_role(backend, Role::Worker, ToolPolicy::WorkspaceWrite)
}

fn resolved_for_role(backend: Arc<dyn Backend>, role: Role, policy: ToolPolicy) -> super::Resolved {
    let registry = registry(backend);
    resolve(
        &registry,
        &FixedAccounts::default(),
        &Defaults::default(),
        role,
        Some(subscription_choice()),
        policy,
    )
    .unwrap()
}

#[tokio::test]
async fn start_sends_no_write_to_the_backend_for_a_coordinator() {
    let backend = completing();
    let resolved = resolved_for_role(
        backend.clone(),
        Role::Coordinator,
        ToolPolicy::WorkspaceWrite,
    );

    let mut started = start(
        no_keys(),
        &FixedAccounts::default(),
        resolved,
        request(&root()),
    )
    .unwrap();
    rest(&mut started.events).await;

    let sent = &backend.calls()[0];
    assert_eq!(sent.policy, ToolPolicy::NoWrite);
    assert_eq!(sent.sandbox, None, "a coordinator gets no worker sandbox");
    let mut settings = claude::no_write_settings();
    settings["showThinkingSummaries"] = true.into();
    let settings = settings.to_string();
    let mut expected: Vec<&str> = claude::BASE_ARGS.to_vec();
    expected.extend(claude::NO_WRITE_ARGS);
    expected.extend(["--settings", &settings]);
    assert_eq!(
        claude::arguments(sent).unwrap(),
        expected,
        "Claude runs a coordinator with exactly 0004's no-write flags, none of 0013's"
    );
}

fn coordinator_tools() -> ThreadTools {
    ThreadTools {
        program: PathBuf::from("/Applications/Parallax.app/Contents/Resources/plxd"),
        data_dir: PathBuf::from("/Users/u/Library/Application Support/parallax"),
        run: RunId::generate(),
    }
}

#[tokio::test]
async fn a_key_accounts_own_failure_never_falls_back_to_a_subscription() {
    let some_other_key = AccountId::generate();
    let key_id = AccountId::generate();
    let backend = Arc::new(ScriptedBackend::new(vec![vec![finished(Outcome::Failed(
        failure(FailureKind::NotSignedIn),
    ))]]));
    let registry = registry(backend.clone());
    let mut accounts = FixedAccounts::default();
    accounts.providers.insert(key_id, Provider::Anthropic);
    // A fallback is "configured", but starting from a key account must never use it: 0004 allows
    // only subscription-to-key fallback, never the reverse.
    accounts
        .fallbacks
        .insert(Provider::Anthropic, some_other_key);
    let resolved = resolve(
        &registry,
        &accounts,
        &Defaults::default(),
        Role::Worker,
        Some(AccountChoice::Key { id: key_id }),
        ToolPolicy::WorkspaceWrite,
    )
    .unwrap();
    let keys = key_store_with(key_id, "sk-ant-the-only-key");

    let mut started = start(keys, &accounts, resolved, request(&root())).unwrap();
    let events = rest(&mut started.events).await;

    assert_eq!(
        events,
        [finished(Outcome::Failed(failure(FailureKind::NotSignedIn)))]
    );
    assert_eq!(backend.calls().len(), 1, "must not have retried");
}

#[tokio::test]
async fn cancel_after_a_fallback_reaches_the_second_attempt() {
    let fallback_id = AccountId::generate();
    let backend = Arc::new(ScriptedBackend::new(vec![
        vec![finished(Outcome::Failed(failure(FailureKind::NotSignedIn)))],
        vec![finished(Outcome::Completed { result: None })],
    ]));
    let resolved = resolved_subscription(backend.clone());
    let accounts = accounts_with_fallback(fallback_id);
    let keys = key_store_with(fallback_id, "sk-ant-fallback-key");

    let mut started = start(keys, &accounts, resolved, request(&root())).unwrap();
    // The handle is swapped to the fallback's before `AccountFallback` is emitted, so seeing this
    // event guarantees the swap has already happened.
    assert_eq!(
        next(&mut started.events).await,
        Event::AccountFallback {
            from_account: "claude".into(),
            to_account: fallback_id.to_string(),
            reason: FailureKind::NotSignedIn,
        }
    );

    started.run.cancel();

    let switches = backend.switches();
    assert_eq!(switches.len(), 2);
    assert!(
        !switches[0].is_cancelled(),
        "the abandoned first attempt must be left alone"
    );
    assert!(
        switches[1].is_cancelled(),
        "cancel must reach the attempt that is actually running"
    );
}

// ---------------------------------------------------------------------------------------------
// start() and a lost session's new one (PLX-937)
// ---------------------------------------------------------------------------------------------

/// A request resuming `s-1`, with a packet to start a new session with if it's gone.
fn resuming() -> RunRequest {
    RunRequest {
        resume: Some(Resume {
            fallback: Some("packet".into()),
            ..Resume::new("s-1")
        }),
        ..request(&root())
    }
}

fn session(id: &str) -> Event {
    Event::SessionStarted {
        session_id: id.into(),
        model: None,
        api_key_source: None,
    }
}

fn said(text: &str) -> Event {
    Event::Text {
        message_id: None,
        text: text.into(),
    }
}

/// `resuming()` started on a backend playing `attempts`: its events and each attempt's request.
async fn run_resuming(attempts: Vec<Vec<Event>>) -> (Vec<Event>, Vec<RunRequest>) {
    let backend = Arc::new(ScriptedBackend::new(attempts));
    let resolved = resolved_subscription(backend.clone());
    let mut started = start(no_keys(), &FixedAccounts::default(), resolved, resuming()).unwrap();
    (rest(&mut started.events).await, backend.calls())
}

#[tokio::test]
async fn a_lost_session_starts_once_as_a_new_one_with_the_fallback() {
    let lost = finished(Outcome::Failed(failure(FailureKind::SessionNotFound)));
    let done = finished(Outcome::Completed { result: None });
    let (events, calls) = run_resuming(vec![
        vec![said("from the lost attempt"), lost],
        vec![session("s-2"), said("Picked up."), done.clone()],
    ])
    .await;

    assert_eq!(
        events,
        [session("s-2"), said("Picked up."), done],
        "the failed attempt's events are dropped"
    );
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].resume, None);
    assert_eq!(calls[1].prompt, "packet");
}

#[tokio::test]
async fn only_a_coordinator_keeps_the_coordinator_tools() {
    for (role, policy) in [
        (Role::Coordinator, ToolPolicy::NoWrite),
        (Role::Worker, ToolPolicy::WorkspaceWrite),
    ] {
        let backend = Arc::new(ScriptedBackend::new(vec![vec![finished(
            Outcome::Completed { result: None },
        )]]));
        let resolved = resolved_for_role(backend.clone(), role, policy);
        let keys: Arc<dyn KeyStore> = Arc::new(MemoryKeyStore::new());
        let tools = coordinator_tools();
        let request = RunRequest {
            coordinator_tools: Some(tools.clone()),
            ..request(&root())
        };

        let mut started = start(keys, &FixedAccounts::default(), resolved, request).unwrap();
        rest(&mut started.events).await;

        let kept = backend.calls()[0].coordinator_tools.clone();
        assert_eq!(
            kept,
            (role == Role::Coordinator).then_some(tools),
            "{role:?}"
        );
    }
}
#[tokio::test]
async fn a_signed_out_or_rate_limited_subscription_falls_back_once_to_the_key_account() {
    for reason in [FailureKind::NotSignedIn, FailureKind::RateLimited] {
        let fallback_id = AccountId::generate();
        let backend = Arc::new(ScriptedBackend::new(vec![
            vec![finished(Outcome::Failed(failure(reason)))],
            vec![finished(Outcome::Completed { result: None })],
        ]));
        let resolved = resolved_subscription(backend.clone());
        let accounts = accounts_with_fallback(fallback_id);
        let keys = key_store_with(fallback_id, "sk-ant-fallback-key");

        let mut started = start(keys, &accounts, resolved, request(&root())).unwrap();
        let events = rest(&mut started.events).await;

        assert_eq!(
            events,
            [
                Event::AccountFallback {
                    from_account: "claude".into(),
                    to_account: fallback_id.to_string(),
                    reason,
                },
                finished(Outcome::Completed { result: None }),
            ]
        );
        let calls = backend.calls();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(
            calls[0].account.credential,
            Credential::Subscription { config_home: None }
        );
        assert_eq!(calls[1].account.id, fallback_id.to_string());
        let Credential::ApiKey(key) = &calls[1].account.credential else {
            panic!(
                "expected an API key credential, got {:?}",
                calls[1].account.credential
            );
        };
        assert_eq!(key.expose(), "sk-ant-fallback-key");
    }
}
