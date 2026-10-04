//! A Project's children's questions end to end (PLX-402, decision 0043): a child asks and goes
//! on, the question wakes the coordinator, which answers or escalates, and the user answers or
//! changes an answer from the app.

use std::sync::{Arc, Mutex};

use parallax_protocol::methods::{
    AgentStart, ProjectStart, QuestionAnswer, QuestionAsk, QuestionEscalate, QuestionList,
    QueueList, ThreadStart,
};
use parallax_protocol::{
    AgentStatus, ErrorKind, InboxKind, ParallaxEvent, ProjectId, Question, QuestionAnswerParams,
    QuestionAskParams, QuestionEscalateParams, QuestionListParams, QuestionStatus, QueueListParams,
    QueuedMessage, RunId,
};
use plxd::backend::RunRequest;
use plxd::backend::fake::Step;
use plxd::mcp::question::{CHILD_TOOLS, COORDINATOR_TOOLS};
use plxd::mcp::thread::{CONTEXT_TOOLS, TOOLS};
use serde_json::json;

use crate::agents::{Conn, Host, create, end_turn, init, project_params, subscribe, until};
use crate::coordinator::{nth_launch, roles, sessions, spawn, start_params as coordinator_params};
use crate::inbox::added;
use crate::mcp::{Mcp, mcp_command};
use crate::support::{kind, temp_dir};

fn hang() -> Vec<Step> {
    vec![init("worker-1"), Step::Hang]
}

async fn ask(
    client: &mut Conn,
    run: RunId,
    question: &str,
    assumption: &str,
) -> Result<Question, parallax_protocol::jsonrpc::ErrorObject> {
    client
        .call::<QuestionAsk>(QuestionAskParams {
            run,
            question: question.to_owned(),
            assumption: assumption.to_owned(),
        })
        .await
        .map(|asked| asked.question)
}

async fn answer(
    client: &mut Conn,
    question: &Question,
    text: &str,
    from: Option<RunId>,
) -> Question {
    client
        .call::<QuestionAnswer>(QuestionAnswerParams {
            question: question.id,
            text: text.to_owned(),
            from,
        })
        .await
        .unwrap()
        .question
}

async fn queued(client: &mut Conn, run_id: RunId) -> Vec<QueuedMessage> {
    client
        .call::<QueueList>(QueueListParams { run_id })
        .await
        .unwrap()
        .messages
}

/// Waits until `run` is running, so a message to it waits in its queue.
async fn running(client: &mut Conn, run: RunId) {
    until(client, |event| {
        matches!(&event.event, ParallaxEvent::AgentUpdated { run_id, state }
            if *run_id == run && state.status == AgentStatus::Running)
    })
    .await;
}

/// Through the tools: only a child gets `ask`, only the coordinator `answer` and `escalate`. The
/// question wakes the coordinator, and an answer that differs from the assumption waits in the
/// child's queue and adds `decided`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_question_wakes_the_coordinator_whose_different_answer_reaches_the_child() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let turn = |result: &str| vec![init("coordinator-1"), end_turn(result)];
    let backends = roles(hang(), vec![turn("Planned."), turn("Answered.")], &seen);
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(coordinator_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    let child = spawn(&mut client, &coordinator, "Add rate limits.").await;
    running(&mut client, child).await;

    let names = |listed: serde_json::Value| -> Vec<String> {
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let dir = host.dir.path();
    let mut asker = Mcp::spawn(mcp_command(dir, &["--thread", &child.to_string()])).await;
    let mut boss = Mcp::spawn(mcp_command(dir, &["--thread", &coordinator.id.to_string()])).await;
    let tools = asker.request("tools/list", json!({})).await;
    assert_eq!(names(tools), [TOOLS, CONTEXT_TOOLS, CHILD_TOOLS].concat());
    let tools = boss.request("tools/list", json!({})).await;
    assert_eq!(
        names(tools),
        [TOOLS, CONTEXT_TOOLS, COORDINATOR_TOOLS].concat()
    );

    let (said, is_error) = asker
        .tool(
            "ask",
            json!({"question": "Per user or per IP?", "assumption": "Per user"}),
        )
        .await;
    assert!(!is_error, "{said}");
    assert!(
        said.contains("Go on now with your assumption: Per user"),
        "{said}"
    );
    let listed = client
        .call::<QuestionList>(QuestionListParams {
            project: project.id,
        })
        .await
        .unwrap()
        .questions;
    let [question] = listed.as_slice() else {
        panic!("{listed:?}");
    };
    assert_eq!(
        (question.run, question.status),
        (child, QuestionStatus::Open)
    );

    let wake = nth_launch(&seen, 1).await;
    assert!(
        wake.prompt.contains(&format!(
            "- Run {child} (Add rate limits.) asked question {}: Per user or per IP? It went on \
             assuming: Per user",
            question.id
        )),
        "{}",
        wake.prompt
    );

    let not_its = boss
        .request(
            "tools/call",
            json!({"name": "ask", "arguments": {"question": "?", "assumption": "!"}}),
        )
        .await;
    assert_eq!(not_its["error"]["code"], -32602, "{not_its}");
    let answered = boss
        .ok("answer", json!({"question": question.id, "text": "Per IP"}))
        .await;
    assert_eq!(answered["status"], "decided");
    let item = added(&mut client, project.id).await;
    assert_eq!((item.kind, item.run), (InboxKind::Decided, child));
    assert!(item.text.ends_with("Went with: Per IP"), "{}", item.text);
    let waiting = queued(&mut client, child).await;
    assert_eq!(waiting.len(), 1, "{waiting:?}");
    assert!(
        waiting[0]
            .text
            .starts_with("Answer to your question \"Per user or per IP?\": Per IP"),
        "{}",
        waiting[0].text
    );
    let again = boss
        .refused(
            "answer",
            json!({"question": question.id, "text": "Per user"}),
        )
        .await;
    assert!(again.contains("not open"), "{again}");
    host.server.stop().await;
}

/// A project whose coordinator and its child run until stopped.
async fn project_with_child(
    seen: &Arc<Mutex<Vec<RunRequest>>>,
) -> (Host, Conn, ProjectId, RunId, RunId) {
    let backends = roles(hang(), vec![vec![init("coordinator-1"), Step::Hang]], seen);
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(coordinator_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    let child = spawn(&mut client, &coordinator, "Upgrade Node.").await;
    running(&mut client, child).await;
    (host, client, project.id, coordinator.id, child)
}

/// With no coordinator, a question goes straight to Needs you. Only a Project's child asks, and
/// only its coordinator escalates.
#[tokio::test]
async fn only_a_projects_child_asks_and_only_its_coordinator_escalates() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(hang(), vec![vec![init("coordinator-1"), Step::Hang]], &seen);
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let mine = client
        .call::<AgentStart>(crate::agents::start_params(project.id, "Tidy up."))
        .await
        .unwrap()
        .run
        .id;
    let alone = ask(&mut client, mine, "Delete the old docs?", "Keep them")
        .await
        .unwrap();
    assert_eq!(
        alone.status,
        QuestionStatus::Escalated,
        "nobody else to ask"
    );
    let item = added(&mut client, project.id).await;
    assert_eq!((item.kind, item.run), (InboxKind::NeedsYou, mine));

    let coordinator = client
        .call::<ProjectStart>(coordinator_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    let refused = ask(&mut client, coordinator.id, "?", "!")
        .await
        .unwrap_err();
    assert!(refused.message.contains("coordinator"), "{refused:?}");
    let unknown = ask(&mut client, RunId::generate(), "?", "!")
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RunNotFound);
    let thread = client
        .call::<ThreadStart>(crate::open_pr::thread(None))
        .await
        .unwrap()
        .run
        .id;
    let outside = ask(&mut client, thread, "?", "!").await.unwrap_err();
    assert!(
        outside.message.contains("isn't in a Project"),
        "{outside:?}"
    );

    let open = ask(&mut client, mine, "Keep Node 18?", "Keep it")
        .await
        .unwrap();
    assert_eq!(
        open.status,
        QuestionStatus::Open,
        "the coordinator has it now"
    );
    let not_coordinator = client
        .call::<QuestionEscalate>(QuestionEscalateParams {
            question: open.id,
            from: mine,
        })
        .await
        .unwrap_err();
    assert!(
        not_coordinator.message.contains("coordinator"),
        "{not_coordinator:?}"
    );
    let missing = client
        .call::<QuestionList>(QuestionListParams {
            project: ProjectId::generate(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::ProjectNotFound);
    host.server.stop().await;
}

/// The coordinator escalates to Needs you, an answer that matches what the child was told sends
/// nothing, and the user changing a decided answer sends a correction.
#[tokio::test]
async fn the_coordinator_escalates_and_the_user_answers_or_corrects() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, project, coordinator, child) = project_with_child(&seen).await;

    let keep = ask(&mut client, child, "Keep Node 18?", "Keep it")
        .await
        .unwrap();
    let escalated = client
        .call::<QuestionEscalate>(QuestionEscalateParams {
            question: keep.id,
            from: coordinator,
        })
        .await
        .unwrap()
        .question;
    assert_eq!(escalated.status, QuestionStatus::Escalated);
    let item = added(&mut client, project).await;
    assert_eq!((item.kind, item.run), (InboxKind::NeedsYou, child));
    assert!(item.text.contains("Keep Node 18?"), "{}", item.text);
    let kept = answer(&mut client, &keep, " keep  IT", None).await;
    assert_eq!(kept.status, QuestionStatus::Answered);
    assert!(
        queued(&mut client, child).await.is_empty(),
        "its assumption stands"
    );

    let port = ask(&mut client, child, "Which port?", "8080")
        .await
        .unwrap();
    let decided = answer(&mut client, &port, "8080", Some(coordinator)).await;
    assert_eq!(decided.status, QuestionStatus::Decided);
    assert_eq!(added(&mut client, project).await.kind, InboxKind::Decided);
    assert!(
        queued(&mut client, child).await.is_empty(),
        "it confirmed the assumption"
    );
    let changed = answer(&mut client, &port, "9090", None).await;
    assert_eq!(
        (changed.status, changed.answer.as_deref()),
        (QuestionStatus::Answered, Some("9090"))
    );
    let waiting = queued(&mut client, child).await;
    assert_eq!(waiting.len(), 1, "{waiting:?}");
    assert!(
        waiting[0]
            .text
            .starts_with("The user changed the answer to your question \"Which port?\": 9090"),
        "{}",
        waiting[0].text
    );
    let listed = client
        .call::<QuestionList>(QuestionListParams { project })
        .await
        .unwrap()
        .questions;
    assert_eq!(listed, [kept, changed]);
    host.server.stop().await;
}

/// A question still open when plxd restarts, whose wake-up was waiting behind the coordinator's
/// turn, is named in the wake-up after the restart.
#[tokio::test]
async fn an_open_question_wakes_the_coordinator_after_a_restart() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(hang(), vec![vec![init("coordinator-1"), Step::Hang]], &seen);
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(coordinator_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    let child = spawn(&mut client, &coordinator, "Add rate limits.").await;
    sessions(&mut client, &[coordinator.id, child]).await;
    let question = ask(&mut client, child, "Per user or per IP?", "Per user")
        .await
        .unwrap();

    let later = vec![vec![init("coordinator-1"), end_turn("Picked up.")]];
    let host = host.restart(roles(hang(), later, &seen)).await;
    let wake = nth_launch(&seen, 1).await;
    assert!(
        wake.prompt.contains(&format!(
            "asked question {}: Per user or per IP?",
            question.id
        )),
        "{}",
        wake.prompt
    );
    host.server.stop().await;
}
