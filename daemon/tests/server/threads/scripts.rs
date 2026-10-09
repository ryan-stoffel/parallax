//! Setup and settle scripts end to end (PLX-650): a new worktree runs its repository's setup
//! script, async or holding the first turn, and settling runs its settle script, each in a plxd
//! terminal under the thread.

use parallax_protocol::methods::{RepoSaveScripts, RepoScripts, TerminalList};
use parallax_protocol::{
    RepoSaveScriptsParams, RepoScript, RepoScriptsParams, ScriptStatus, ScriptTrigger,
    TerminalListParams,
};

use super::*;

fn script(name: &str, command: &str) -> RepoScript {
    RepoScript {
        id: String::new(),
        name: name.to_owned(),
        command: command.to_owned(),
        run_on_worktree_create: false,
        run_on_settle: false,
        run_async: None,
    }
}

fn setup(command: &str, run_async: Option<bool>) -> RepoScript {
    RepoScript {
        run_on_worktree_create: true,
        run_async,
        ..script("Setup", command)
    }
}

async fn save(client: &mut Conn, repo: RepoId, scripts: Vec<RepoScript>) {
    client
        .call::<RepoSaveScripts>(RepoSaveScriptsParams { repo, scripts })
        .await
        .unwrap();
}

/// Whether `event` is run `run`'s script ending.
fn script_ended(run: RunId) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| {
        matches!(&event.event, ParallaxEvent::ThreadScript { run_id, status, .. }
            if *run_id == run && *status != ScriptStatus::Running)
    }
}

#[tokio::test]
async fn parallax_json_is_offered_and_only_saved_scripts_run() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    std::fs::write(
        path.join("parallax.json"),
        r#"{"scripts": [{"name": "Setup", "command": "touch FROM_FILE", "runOnWorktreeCreate": true}]}"#,
    )
    .unwrap();
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let listed = client
        .call::<RepoScripts>(RepoScriptsParams { repo: repo.id })
        .await
        .unwrap();
    assert!(listed.scripts.is_empty());
    assert_eq!(listed.file_scripts.len(), 1);
    assert_eq!(listed.file_scripts[0].id, "setup");

    // Nothing was imported, so the new worktree runs nothing.
    client.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap();
    let events = client.until(updated_to(AgentStatus::Completed)).await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event.event, ParallaxEvent::ThreadScript { .. }))
    );
    let worktree = PathBuf::from(started.run.worktree_path.unwrap());
    assert!(!worktree.join("FROM_FILE").exists());
}

#[tokio::test]
async fn an_async_setup_script_runs_beside_the_agent_and_a_settle_script_on_settle() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let settle = RepoScript {
        run_on_settle: true,
        ..script(
            "Clean up",
            "echo settled > \"$PARALLAX_WORKTREE_PATH/SETTLED\"",
        )
    };
    save(
        &mut client,
        repo.id,
        vec![
            setup("echo \"$PARALLAX_PROJECT_ROOT\" > SETUP", None),
            settle,
        ],
    )
    .await;

    client.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap();
    let run = started.run.id;
    let events = client.until(script_ended(run)).await;
    let ParallaxEvent::ThreadScript {
        trigger,
        terminal_id,
        blocking,
        status,
        exit_code,
        ..
    } = &events.last().unwrap().event
    else {
        unreachable!()
    };
    assert_eq!(*trigger, ScriptTrigger::Setup);
    assert_eq!(terminal_id, "setup-setup");
    assert!(!blocking);
    assert_eq!((*status, *exit_code), (ScriptStatus::Done, Some(0)));
    let worktree = PathBuf::from(started.run.worktree_path.unwrap());
    let root = std::fs::read_to_string(worktree.join("SETUP")).unwrap();
    assert_eq!(root.trim(), path.to_str().unwrap());
    // A clean exit closes its terminal.
    let terminals = client
        .call::<TerminalList>(TerminalListParams {
            thread_id: Some(run.to_string()),
        })
        .await
        .unwrap();
    assert!(terminals.terminals.is_empty(), "{terminals:?}");

    client
        .call::<ThreadUpdate>(ThreadUpdateParams {
            settled: Some(true),
            ..attention(run, false, None)
        })
        .await
        .unwrap();
    let events = client.until(script_ended(run)).await;
    let ParallaxEvent::ThreadScript {
        trigger,
        terminal_id,
        status,
        ..
    } = &events.last().unwrap().event
    else {
        unreachable!()
    };
    assert_eq!(*trigger, ScriptTrigger::Settle);
    assert!(terminal_id.starts_with("settle-clean-up-"), "{terminal_id}");
    assert_eq!(*status, ScriptStatus::Done);
    assert!(worktree.join("SETTLED").exists());
}

#[tokio::test]
async fn a_blocking_setup_script_holds_the_first_turn_and_its_failure_fails_the_run() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    save(&mut client, repo.id, vec![setup("sleep 1", Some(false))]).await;
    client.subscribe(0, Some(scope(repo.id))).await;

    let held = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap();
    let events = client.until(updated_to(AgentStatus::Completed)).await;
    let ended = events
        .iter()
        .position(script_ended(held.run.id))
        .expect("the script ended");
    let output = events
        .iter()
        .position(|event| matches!(event.event, ParallaxEvent::AgentOutput { .. }))
        .unwrap();
    assert!(ended < output, "the agent started before its setup ended");

    save(
        &mut client,
        repo.id,
        vec![setup("echo failing\nexit 3", Some(false))],
    )
    .await;
    let failed = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write more notes"))
        .await
        .unwrap();
    let run = failed.run.id;
    let events = client.until(updated_to(AgentStatus::Failed)).await;
    assert!(events.iter().any(|event| matches!(
        &event.event,
        ParallaxEvent::ThreadScript { run_id, status: ScriptStatus::Failed, exit_code: Some(3), blocking: true, .. }
            if *run_id == run
    )));
    let error = events
        .iter()
        .find_map(|event| match &event.event {
            ParallaxEvent::AgentUpdated { state, .. } => state.error.clone(),
            _ => None,
        })
        .unwrap();
    assert!(error.contains("exited with code 3"), "{error}");
    // Its shell stays open, with what failed in it.
    let terminals = client
        .call::<TerminalList>(TerminalListParams {
            thread_id: Some(run.to_string()),
        })
        .await
        .unwrap();
    assert_eq!(terminals.terminals.len(), 1);
    assert_eq!(terminals.terminals[0].terminal_id, "setup-setup");
    client.delete(run).await.unwrap();
}

#[tokio::test]
async fn stop_and_delete_end_a_blocking_setup_at_once() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    save(&mut client, repo.id, vec![setup("sleep 30", Some(false))]).await;
    client.subscribe(0, Some(scope(repo.id))).await;
    let running = |run: RunId| {
        move |event: &EventsEventParams| {
            matches!(&event.event, ParallaxEvent::ThreadScript { run_id, status: ScriptStatus::Running, .. }
                if *run_id == run)
        }
    };

    let stopped = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap()
        .run
        .id;
    client.until(running(stopped)).await;
    let cancelled = tokio::time::timeout(
        Duration::from_secs(5),
        client.call::<AgentCancel>(AgentCancelParams {
            run_id: stopped,
            from: None,
        }),
    )
    .await
    .expect("Stop waited for the script")
    .unwrap();
    assert_eq!(cancelled.run.status, AgentStatus::Cancelled);
    let events = client.until(script_ended(stopped)).await;
    assert!(matches!(
        events.last().unwrap().event,
        ParallaxEvent::ThreadScript {
            status: ScriptStatus::Cancelled,
            ..
        }
    ));

    let deleted = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write more notes"))
        .await
        .unwrap()
        .run
        .id;
    client.until(running(deleted)).await;
    tokio::time::timeout(Duration::from_secs(5), client.delete(deleted))
        .await
        .expect("delete waited for the script")
        .unwrap();
    let terminals = client
        .call::<TerminalList>(TerminalListParams { thread_id: None })
        .await
        .unwrap();
    assert!(terminals.terminals.is_empty(), "{terminals:?}");
}

#[tokio::test]
async fn a_restart_ends_a_running_script_as_interrupted() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    save(&mut client, repo.id, vec![setup("sleep 30", None)]).await;
    client.subscribe(0, Some(scope(repo.id))).await;
    let run = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap()
        .run
        .id;
    client
        .until(|event| matches!(&event.event, ParallaxEvent::ThreadScript { run_id, .. } if *run_id == run))
        .await;
    drop(client);

    let host = host.restart(fake(editing())).await;
    let mut client = host.client().await;
    client.subscribe(0, Some(scope(repo.id))).await;
    let events = client.until(script_ended(run)).await;
    assert!(matches!(
        events.last().unwrap().event,
        ParallaxEvent::ThreadScript {
            status: ScriptStatus::Interrupted,
            ..
        }
    ));
}
