//! A Project's checks after each landing end to end (PLX-411, decision 0045), on the fake CLI:
//! green checks land, red ones take the child's work off and send it back, then go to the user,
//! and red checks after the base merge are the base's. The timeout is the runner's unit test.

use std::path::{Path, PathBuf};

use parallax_protocol::methods::{LandQueue, ProjectUpdate};
use parallax_protocol::{InboxKind, LandQueueParams, ProjectId, ProjectUpdateParams};

use crate::agents::{Conn, Host, create, git, project_params, start_params};
use crate::landing::{finished, item, lands_automatically, messages, notes, worktree};
use crate::support::temp_dir;

/// Checks that fail, printing so, while `broken.txt` is in the tree.
const CHECKS: &str = if cfg!(windows) {
    "if exist broken.txt (echo broken.txt is here& exit 1)"
} else {
    "if [ -e broken.txt ]; then echo broken.txt is here; exit 1; fi"
};

/// Confirms [`CHECKS`] as `project`'s checks.
async fn set_checks(client: &mut Conn, project: ProjectId) {
    let updated = client
        .call::<ProjectUpdate>(ProjectUpdateParams {
            project,
            name: None,
            icon: None,
            permission: None,
            autonomy: None,
            base_branch: None,
            auto_land: None,
            checks: Some(format!("  {CHECKS}\n")),
            proposed_checks: None,
            max_children: None,
            allow_api_keys: None,
        })
        .await
        .unwrap()
        .project;
    assert_eq!(updated.checks.as_deref(), Some(CHECKS), "trimmed");
}

/// Commits `broken.txt` in `dir`, as the user would by hand.
fn break_it(dir: &Path) {
    std::fs::write(dir.join("broken.txt"), "oops\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "break it"]);
}

/// A child that passes the checks lands. One that fails them is taken off the branch and gets
/// their output, and when it fails them again after its turn, it goes to the user.
#[tokio::test]
async fn green_checks_land_and_red_ones_go_back_to_the_child_then_to_the_user() {
    let host = Host::start(temp_dir(), notes());
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    set_checks(&mut client, project.id).await;
    lands_automatically(&mut client, project.id).await;

    let a = finished(&mut client, start_params(project.id, "Write the notes")).await;
    let b = finished(&mut client, start_params(project.id, "Break the build")).await;
    break_it(&worktree(&b));
    client
        .call::<LandQueue>(LandQueueParams { run_id: a.id })
        .await
        .unwrap();
    item(&mut client, project.id, a.id, |item| {
        item.text.contains("landed on the integration branch")
    })
    .await;
    let landed = git(&repo, &["rev-parse", "parallax/app"]);

    client
        .call::<LandQueue>(LandQueueParams { run_id: b.id })
        .await
        .unwrap();
    let stuck = item(&mut client, project.id, b.id, |item| {
        item.kind == InboxKind::NeedsYou
    })
    .await;
    assert_eq!(
        stuck.text,
        "Break the build: failed the checks again, so it's off the integration branch. They \
         exited 1:\n\nbroken.txt is here"
    );
    assert_eq!(
        git(&repo, &["rev-parse", "parallax/app"]),
        landed,
        "red checks put the branch back"
    );
    let sent = messages(&mut client, b.id).await;
    let red = sent.last().unwrap();
    assert!(
        red.starts_with("Parallax, not the user: the Project's checks failed"),
        "{sent:?}"
    );
    assert!(
        red.ends_with("\n\n```text\nbroken.txt is here\n```"),
        "{red}"
    );
    assert_eq!(sent.len(), 1, "sent back once: {sent:?}");
    host.server.stop().await;
}

/// The base branch moved to a commit that fails the checks: it is left out and goes to the user,
/// and the child still lands on the tip.
#[tokio::test]
async fn red_checks_after_the_base_merge_are_the_bases_and_the_child_still_lands() {
    let host = Host::start(temp_dir(), notes());
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    set_checks(&mut client, project.id).await;
    lands_automatically(&mut client, project.id).await;
    let tip = git(&repo, &["rev-parse", "parallax/app"]);
    let run = finished(&mut client, start_params(project.id, "Write the notes")).await;
    break_it(&repo);

    client
        .call::<LandQueue>(LandQueueParams { run_id: run.id })
        .await
        .unwrap();
    let base = item(&mut client, project.id, run.id, |item| {
        item.text.starts_with("The base branch")
    })
    .await;
    assert_eq!(base.kind, InboxKind::NeedsYou);
    assert_eq!(
        base.text,
        "The base branch main fails the checks once merged into parallax/app, so plxd left it \
         out: fix it on main. They exited 1:\n\nbroken.txt is here"
    );
    item(&mut client, project.id, run.id, |item| {
        item.text.contains("landed on the integration branch")
    })
    .await;
    assert_eq!(
        git(&repo, &["rev-parse", "parallax/app^"]),
        tip,
        "only the child's commit is on the branch"
    );
    host.server.stop().await;
}
