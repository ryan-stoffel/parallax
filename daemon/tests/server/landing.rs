//! A Project's landing queue end to end (PLX-410, decision 0045): `land/queue`, `land/approve`,
//! and `land/sendBack` on the fake CLI, with two children touching the same file, across a
//! restart.

use std::path::{Path, PathBuf};
use std::time::Duration;

use parallax_protocol::methods::{
    AgentEvents, AgentList, AgentStart, InboxList, LandApprove, LandQueue, LandSendBack,
    ProjectUpdate,
};
use parallax_protocol::{
    AgentEventsParams, AgentListParams, AgentOutputItem, AgentRun, AgentStartParams, AgentStatus,
    ErrorKind, InboxItem, InboxKind, InboxListParams, LandApproveParams, LandQueueParams,
    LandSendBackParams, LandingStatus, ParallaxEvent, ProjectId, ProjectUpdateParams, RunId,
};
use plxd::backend::fake::Step;
use plxd::routing::BackendRegistry;
use tokio::time::{Instant, sleep};

use crate::agents::{Conn, Host, create, end_turn, fake, git, init, project_params, start_params};
use crate::support::{PATIENCE, kind, temp_dir};

/// Every child's script: it writes `notes.txt` and finishes.
fn notes() -> BackendRegistry {
    fake(vec![
        init("land-1"),
        Step::WriteFile {
            path: "notes.txt".to_owned(),
            content: "from the agent\n".to_owned(),
        },
        end_turn("Done."),
    ])
}

async fn runs(client: &mut Conn, project: ProjectId) -> Vec<AgentRun> {
    client
        .call::<AgentList>(AgentListParams {
            project: Some(project),
        })
        .await
        .unwrap()
        .runs
}

/// Starts a run in `project` and waits until it has completed.
async fn finished(client: &mut Conn, params: AgentStartParams) -> AgentRun {
    let (project, id) = (params.project, params.run_id);
    client.call::<AgentStart>(params).await.unwrap();
    let deadline = Instant::now() + PATIENCE;
    loop {
        let run = runs(client, project)
            .await
            .into_iter()
            .find(|run| run.id == id)
            .unwrap();
        if run.status == AgentStatus::Completed {
            return run;
        }
        assert!(Instant::now() < deadline, "never completed: {run:?}");
        sleep(Duration::from_millis(50)).await;
    }
}

/// The first item of `project`'s inbox about `run` that `wanted` picks, once there is one.
async fn item(
    client: &mut Conn,
    project: ProjectId,
    run: RunId,
    mut wanted: impl FnMut(&InboxItem) -> bool,
) -> InboxItem {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let items = client
            .call::<InboxList>(InboxListParams { project })
            .await
            .unwrap()
            .items;
        if let Some(item) = items.iter().find(|item| item.run == run && wanted(item)) {
            return item.clone();
        }
        assert!(Instant::now() < deadline, "no such item: {items:#?}");
        sleep(Duration::from_millis(50)).await;
    }
}

/// The text of the messages `run`'s turns started with.
async fn messages(client: &mut Conn, run_id: RunId) -> Vec<String> {
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            run_id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap()
        .events;
    events
        .iter()
        .filter_map(|logged| match &logged.event {
            ParallaxEvent::AgentOutput { items, .. } => Some(items),
            _ => None,
        })
        .flatten()
        .filter_map(|item| match item {
            AgentOutputItem::TurnStarted {
                text: Some(text), ..
            } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn worktree(run: &AgentRun) -> PathBuf {
    PathBuf::from(run.worktree_path.as_deref().expect("a worktree"))
}

/// Commits `content` as `notes.txt` and `extra` in `dir`, as the user would by hand.
fn commit(dir: &Path, content: &str, extra: &str) {
    std::fs::write(dir.join("notes.txt"), content).unwrap();
    std::fs::write(dir.join(extra), "more\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "by hand"]);
}

/// Two children write the same file. The first lands as one commit after approval, across a
/// restart. The second conflicts: it gets a message with the merge started in its worktree, and
/// is queued again when that turn ends. When it conflicts again, it goes to the user.
#[tokio::test]
async fn two_children_touching_one_file_land_in_turn_and_a_conflict_goes_back_then_to_the_user() {
    let host = Host::start(temp_dir(), notes());
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    let integration = host
        .dir
        .path()
        .join("integration")
        .join(project.id.to_string());
    let a = finished(
        &mut client,
        start_params(project.id, "Write the notes\nShort ones."),
    )
    .await;
    let b = finished(&mut client, start_params(project.id, "Rewrite the notes")).await;
    commit(&worktree(&b), "from b\n", "b.txt");

    let queued = client
        .call::<LandQueue>(LandQueueParams { run_id: a.id })
        .await
        .unwrap()
        .landing;
    assert_eq!(queued.status, LandingStatus::Waiting, "off by default");
    let waiting = item(&mut client, project.id, a.id, |item| {
        item.kind == InboxKind::NeedsYou
    })
    .await;
    assert_eq!(waiting.kind, InboxKind::NeedsYou);
    assert_eq!(
        waiting.text,
        "Write the notes: ready to land, waiting for your approval"
    );
    let tip = git(&repo, &["rev-parse", "parallax/app"]);

    // The queue is stored: a restart keeps the child waiting.
    let host = host.restart(notes()).await;
    let mut client = host.client().await;
    let approved = client
        .call::<LandApprove>(LandApproveParams { run_id: a.id })
        .await
        .unwrap()
        .landing;
    assert_eq!(approved.status, LandingStatus::Queued);
    let done = item(&mut client, project.id, a.id, |item| {
        item.text.contains("landed on the integration branch")
    })
    .await;
    let landed = git(&repo, &["rev-parse", "parallax/app"]);
    assert_eq!(
        done.text,
        format!(
            "Write the notes: landed on the integration branch, as {}",
            &landed[..7]
        )
    );
    assert_eq!(
        git(&repo, &["rev-parse", "parallax/app^"]),
        tip,
        "one commit"
    );
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s", "parallax/app"]),
        "Write the notes"
    );
    let body = git(&repo, &["log", "-1", "--format=%b", "parallax/app"]);
    assert!(body.contains(&a.id.to_string()), "names the run: {body}");
    let again = client
        .call::<LandApprove>(LandApproveParams { run_id: a.id })
        .await
        .unwrap_err();
    assert_eq!(kind(&again), ErrorKind::LandRefused, "it isn't waiting");

    // The second child conflicts on notes.txt: plxd starts the merge in its worktree and sends it
    // back. Its turn writes the file, which resolves it, and plxd commits the merge.
    client
        .call::<LandQueue>(LandQueueParams { run_id: b.id })
        .await
        .unwrap();
    client
        .call::<LandApprove>(LandApproveParams { run_id: b.id })
        .await
        .unwrap();
    let requeued = item(&mut client, project.id, b.id, |item| {
        item.text.ends_with("again, waiting for your approval")
    })
    .await;
    assert_eq!(requeued.kind, InboxKind::NeedsYou);
    assert_eq!(
        git(&repo, &["rev-parse", "parallax/app"]),
        landed,
        "the conflict left the branch untouched"
    );
    let sent = messages(&mut client, b.id).await;
    assert!(
        sent.last()
            .unwrap()
            .contains("conflicts with the Project's integration branch"),
        "{sent:?}"
    );
    let b_head = &worktree(&b);
    assert_eq!(
        git(b_head, &["rev-parse", "HEAD^2"]),
        landed,
        "the merge is concluded"
    );

    send_back_then_conflict_again(&mut client, project.id, &b, &integration).await;
    host.server.stop().await;
}

/// The user sends `b`, waiting again after its conflict, back with a message: its turn ends, and
/// it waits again. Then both sides change `notes.txt` again, and the second conflict goes to the
/// user.
async fn send_back_then_conflict_again(
    client: &mut Conn,
    project: ProjectId,
    b: &AgentRun,
    integration: &Path,
) {
    let sent_back = client
        .call::<LandSendBack>(LandSendBackParams {
            run_id: b.id,
            text: "Keep both notes.".to_owned(),
        })
        .await
        .unwrap()
        .landing;
    assert_eq!(sent_back.status, LandingStatus::SentBack);
    let deadline = Instant::now() + PATIENCE;
    while !messages(client, b.id)
        .await
        .contains(&"Keep both notes.".to_owned())
    {
        assert!(Instant::now() < deadline, "the child never got it");
        sleep(Duration::from_millis(50)).await;
    }
    let deadline = Instant::now() + PATIENCE;
    loop {
        let waiting = client
            .call::<LandQueue>(LandQueueParams { run_id: b.id })
            .await
            .unwrap()
            .landing;
        if waiting.status == LandingStatus::Waiting {
            break;
        }
        assert!(Instant::now() < deadline, "never queued again: {waiting:?}");
        sleep(Duration::from_millis(50)).await;
    }

    commit(integration, "from the tip\n", "tip.txt");
    commit(&worktree(b), "from b again\n", "b2.txt");
    client
        .call::<LandApprove>(LandApproveParams { run_id: b.id })
        .await
        .unwrap();
    let stuck = item(client, project, b.id, |item| {
        item.text.ends_with("again, in notes.txt")
    })
    .await;
    assert_eq!(stuck.kind, InboxKind::NeedsYou);
    assert_eq!(
        stuck.text,
        "Rewrite the notes: conflicts with the integration branch again, in notes.txt"
    );
}

/// With automatic landing on, a queued child lands without waiting for approval, and an
/// exploration never lands.
#[tokio::test]
async fn a_project_that_lands_automatically_needs_no_approval_and_never_lands_an_exploration() {
    let host = Host::start(temp_dir(), notes());
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let updated = client
        .call::<ProjectUpdate>(ProjectUpdateParams {
            project: project.id,
            name: None,
            icon: None,
            permission: None,
            autonomy: None,
            base_branch: None,
            auto_land: Some(true),
        })
        .await
        .unwrap()
        .project;
    assert!(updated.auto_land);
    let explore = finished(
        &mut client,
        AgentStartParams {
            explore: true,
            ..start_params(project.id, "Spike it")
        },
    )
    .await;
    let refused = client
        .call::<LandQueue>(LandQueueParams { run_id: explore.id })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::LandRefused, "{refused:?}");
    let run = finished(&mut client, start_params(project.id, "Write the notes")).await;
    let queued = client
        .call::<LandQueue>(LandQueueParams { run_id: run.id })
        .await
        .unwrap()
        .landing;
    assert_eq!(queued.status, LandingStatus::Queued);
    let repo = PathBuf::from(&project.repo_path);
    let deadline = Instant::now() + PATIENCE;
    while git(&repo, &["log", "-1", "--format=%s", "parallax/app"]) != "Write the notes" {
        assert!(Instant::now() < deadline, "never landed");
        sleep(Duration::from_millis(50)).await;
    }
    item(&mut client, project.id, run.id, |item| {
        item.text.contains("landed on the integration branch")
    })
    .await;
    host.server.stop().await;
}
