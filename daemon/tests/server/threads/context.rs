//! `thread/search` and threads attached to a message as context (PLX-372, decision 0047).

use parallax_protocol::methods::ThreadSearch;
use parallax_protocol::{AgentOutputItem, Thread, ThreadSearchParams};

use super::*;

/// The prompts [`Other`] got, and whether each resumed a session.
type Prompts = Arc<Mutex<Vec<(String, bool)>>>;

/// A host whose one backend is [`Other`] running [`editing`], recording each prompt it gets.
fn recording() -> (Host, Prompts) {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(Other::new(fake_backend(editing()), &prompts)),
    );
    (Host::start(backends), prompts)
}

/// `thread/start` params for a thread with no repo on [`Other`]'s account.
fn on_other(prompt: &str) -> ThreadStartParams {
    ThreadStartParams {
        account: Some(AccountChoice::Subscription {
            backend: "other".to_owned(),
        }),
        ..start_params(None, prompt)
    }
}

fn completed(run: RunId) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| {
        matches!(
            &event.event,
            ParallaxEvent::AgentUpdated { run_id, state }
                if *run_id == run && state.status == AgentStatus::Completed
        )
    }
}

impl Conn {
    /// Starts a thread with no repo and waits for its agent to finish.
    async fn finished_thread(&mut self, params: ThreadStartParams) -> RunId {
        let run = params.run_id;
        let started = self.call::<ThreadStart>(params).await.unwrap();
        self.subscribe(0, Some(scope(started.thread.repo))).await;
        self.until(completed(run)).await;
        run
    }

    /// Every `turnStarted` item `run` logged, oldest first.
    async fn turns_started(&mut self, run: RunId) -> Vec<AgentOutputItem> {
        let events = self
            .call::<AgentEvents>(AgentEventsParams {
                run_id: run,
                after: 0,
                limit: None,
            })
            .await
            .unwrap()
            .events;
        events
            .into_iter()
            .filter_map(|logged| match logged.event {
                ParallaxEvent::AgentOutput { items, .. } => Some(items),
                _ => None,
            })
            .flatten()
            .filter(|item| matches!(item, AgentOutputItem::TurnStarted { .. }))
            .collect()
    }
}

fn started_with(text: Option<&str>, threads: Vec<RunId>) -> impl Fn(&AgentOutputItem) -> bool {
    move |item| {
        matches!(item, AgentOutputItem::TurnStarted { text: t, threads: th, .. }
            if t.as_deref() == text && *th == threads)
    }
}

/// An attached thread's summary reaches the CLI ahead of the user's text, on the first message
/// and on a follow-up that resumes the session, while the run's prompt, the follow-up's
/// `turnStarted` text, and the transcript keep only the user's words.
#[tokio::test]
async fn an_attached_threads_summary_goes_ahead_of_the_message_and_its_turn_lists_it() {
    let (host, prompts) = recording();
    let mut client = host.client().await;
    let earlier = client
        .finished_thread(ThreadStartParams {
            title: Some("Flaky attach".to_owned()),
            ..on_other("Fix the flaky attach test")
        })
        .await;

    let params = ThreadStartParams {
        threads: vec![earlier, earlier],
        ..on_other("Use what we learned")
    };
    let run = params.run_id;
    let started = client.call::<ThreadStart>(params).await.unwrap();
    assert_eq!(started.run.prompt, "Use what we learned");
    client.until(completed(run)).await;
    client
        .call::<AgentSend>(AgentSendParams {
            threads: vec![earlier],
            ..message(run, "And again")
        })
        .await
        .unwrap();
    client.until(completed(run)).await;

    let summary = format!(
        "<thread id=\"{earlier}\">\nTitle: Flaky attach\nUser:\nFix the flaky attach test\n\n\
         Agent:\nDone.\n</thread>"
    );
    let prompts = prompts.lock().unwrap().clone();
    let [_, (first, false), (follow_up, true)] = prompts.as_slice() else {
        panic!("three CLIs: the earlier thread's, this one's, and its resume: {prompts:?}");
    };
    for (prompt, text) in [(first, "Use what we learned"), (follow_up, "And again")] {
        assert!(prompt.starts_with("The user attached these Parallax threads"));
        assert_eq!(prompt.matches(&summary).count(), 1, "once each: {prompt}");
        assert!(
            prompt.ends_with(&format!("The user's message:\n{text}")),
            "{prompt}"
        );
    }
    let turns = client.turns_started(run).await;
    assert!(
        turns.iter().any(started_with(None, vec![earlier])),
        "{turns:?}"
    );
    assert!(
        turns
            .iter()
            .any(started_with(Some("And again"), vec![earlier])),
        "{turns:?}"
    );
    host.server.stop().await;
}

/// A summary keeps a long thread's latest messages, cut from the front to the cap, and an id
/// that is no thread's is refused before anything starts.
#[tokio::test]
async fn a_summary_is_capped_and_an_unknown_thread_is_refused() {
    let (host, prompts) = recording();
    let mut client = host.client().await;
    let long = "x".repeat(40 * 1024);
    let earlier = client.finished_thread(on_other(&long)).await;

    let unknown = RunId::generate();
    let refused = client
        .call::<ThreadStart>(ThreadStartParams {
            threads: vec![unknown],
            ..on_other("Go")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::ThreadNotFound);
    let refused = client
        .call::<AgentSend>(AgentSendParams {
            threads: vec![earlier, unknown],
            ..message(earlier, "Go")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::ThreadNotFound);
    assert_eq!(prompts.lock().unwrap().len(), 1, "nothing else started");

    let run = client
        .finished_thread(ThreadStartParams {
            threads: vec![earlier],
            ..on_other("Go")
        })
        .await;
    let prompts = prompts.lock().unwrap().clone();
    let (prompt, _) = &prompts[1];
    assert!(
        prompt.contains(&format!(
            "<thread id=\"{earlier}\">\n(Earlier messages are left out.)\n\nAgent:\nDone.\n\
             </thread>"
        )),
        "{prompt}"
    );
    assert!(prompt.len() < long.len(), "{}", prompt.len());
    assert_eq!(client.list().await.threads.len(), 2, "{run} and {earlier}");
    host.server.stop().await;
}

/// `thread/search` finds threads by their messages, the newest first, up to its limit.
#[tokio::test]
async fn thread_search_finds_threads_by_their_messages_newest_first() {
    let (host, _) = recording();
    let mut client = host.client().await;
    let flaky = client
        .finished_thread(on_other("Fix the flaky attach test"))
        .await;
    let sidebar = client
        .finished_thread(on_other("Rename the sidebar's flaky menu"))
        .await;
    let search = |query: &str, limit| ThreadSearchParams {
        query: query.to_owned(),
        limit,
    };
    let ids = |found: Vec<Thread>| found.into_iter().map(|t| t.id).collect::<Vec<_>>();

    let found = client
        .call::<ThreadSearch>(search(" ATTACH ", None))
        .await
        .unwrap();
    assert_eq!(ids(found.threads), [flaky]);
    let found = client
        .call::<ThreadSearch>(search("flaky", None))
        .await
        .unwrap();
    assert_eq!(ids(found.threads), [sidebar, flaky], "newest first");
    let found = client
        .call::<ThreadSearch>(search("flaky", Some(1)))
        .await
        .unwrap();
    assert_eq!(ids(found.threads), [sidebar]);
    let empty = client
        .call::<ThreadSearch>(search("  ", None))
        .await
        .unwrap_err();
    assert_eq!(empty.code, INVALID_PARAMS);
    host.server.stop().await;
}
