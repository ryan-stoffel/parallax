//! `thread/search` and threads attached to a message as context (PLX-372, decision 0047).

use parallax_protocol::AgentOutputItem;

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
                before: None,
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
    assert!(first.starts_with("The user attached these Parallax threads"));
    assert_eq!(first.matches(&summary).count(), 1, "{first}");
    assert!(
        first.ends_with("The user's message:\nUse what we learned"),
        "{first}"
    );
    // A later attach sends only what the source logged since the last summary (0052).
    assert!(follow_up.starts_with("The user attached these Parallax threads"));
    assert!(
        follow_up.contains(&format!("<thread id=\"{earlier}\">\nTitle: Flaky attach\n")),
        "{follow_up}"
    );
    assert!(
        !follow_up.contains("Fix the flaky attach test"),
        "the last summary already covered it: {follow_up}"
    );
    assert!(
        follow_up.ends_with("The user's message:\nAnd again"),
        "{follow_up}"
    );
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
