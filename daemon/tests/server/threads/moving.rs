//! `thread/export` and `thread/receive` (PLX-1538): a thread moves to another computer with its
//! conversation and its branch, and continues there by handoff.

use std::process::Command as Git;

use parallax_protocol::methods::{ThreadExport, ThreadReceive};
use parallax_protocol::{ThreadExportParams, ThreadReceiveParams};

use super::*;

/// A thread with two turns in a worktree moves to a second host whose repository is a clone of the
/// first's: it shows the same conversation, works from the moved branch, and its first follow-up
/// is told the conversation, since the session stayed on the first host.
#[tokio::test]
async fn a_moved_thread_continues_on_the_other_host() {
    let (from, _, _) = super::fork::host();
    let path = real_repo(from.work.path(), "app");
    let mut client = from.client().await;
    let repo = client.add(&path).await;
    let (source, _) =
        super::fork::two_turns(&mut client, start_params(Some(repo.id), "Write the notes")).await;
    let exported = client
        .call::<ThreadExport>(ThreadExportParams {
            run_id: source.thread.id,
        })
        .await
        .unwrap();
    assert_eq!(exported.prompt, "Write the notes");
    assert_eq!(exported.backend, "fake");

    let (to, fake, _) = super::fork::host();
    let clone = to.work.path().join("app");
    let cloned = Git::new("git")
        .args(["clone", "--quiet"])
        .arg(&path)
        .arg(&clone)
        .status()
        .unwrap();
    assert!(cloned.success());
    let mut other = to.client().await;
    let there = other.add(&clone.canonicalize().unwrap()).await;
    let branch = source
        .run
        .branch
        .clone()
        .expect("a worktree thread has a branch");
    let params = ThreadReceiveParams {
        thread: exported,
        repo: Some(there.id),
        base: Some(format!("origin/{branch}")),
    };
    let moved = other.call::<ThreadReceive>(params.clone()).await.unwrap();
    assert_eq!(moved.run.status, AgentStatus::Completed, "no CLI yet");
    assert_eq!(moved.thread.repo, there.id);
    let worktree = PathBuf::from(moved.run.worktree_path.clone().unwrap());
    assert_eq!(
        std::fs::read_to_string(worktree.join("NOTES.md")).unwrap(),
        "Written in a thread.\n",
        "cut from the moved branch"
    );
    let (prompt, items) = super::fork::transcript(&mut other, moved.thread.id).await;
    assert_eq!(prompt, "Write the notes");
    assert_eq!(super::fork::follow_ups(&items), ["Now the tests"]);

    let again = other.call::<ThreadReceive>(params).await.unwrap();
    assert_eq!(again.thread.id, moved.thread.id, "receiving again finds it");

    other.subscribe(0, Some(scope(there.id))).await;
    other
        .call::<AgentSend>(message(moved.thread.id, "Carry on"))
        .await
        .unwrap();
    other.until(super::fork::finished(moved.thread.id)).await;
    let last = fake.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.resume, None, "a new session: {last:?}");
    assert!(last.prompt.contains("Now the tests"), "{}", last.prompt);
    assert!(last.prompt.ends_with("Carry on"), "{}", last.prompt);
    from.server.stop().await;
    to.server.stop().await;
}
