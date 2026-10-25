//! A Project's computer (0057): `project/update`'s `computer` behind `projectComputer`, checked
//! with 0056's device filter on a fake tailnet, and `repo/match`, which finds a repo entry by its
//! `origin`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parallax_protocol::jsonrpc::INVALID_PARAMS;
use parallax_protocol::methods::{ProjectCreate, ProjectUpdate, RepoAdd, RepoMatch};
use parallax_protocol::{
    ErrorKind, ProjectId, ProjectUpdateParams, Repo, RepoAddParams, RepoId, RepoMatchParams,
};

use crate::agents::git;
use crate::connect::FakeTailnet;
use crate::support::{Client, InProcess, create_params, kind, project_update, temp_dir};

/// A repository at `dir/<name>` with one commit, and `origin` set to `origin` when given.
fn repo(dir: &Path, name: &str, origin: Option<&str>) -> PathBuf {
    let repo = dir.join(name);
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "--initial-branch=main"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Test User",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
    );
    if let Some(origin) = origin {
        git(&repo, &["remote", "add", "origin", origin]);
    }
    repo
}

/// Adds [`repo`]'s repository as a repo entry.
async fn add(client: &mut Client, dir: &Path, name: &str, origin: Option<&str>) -> Repo {
    let path = repo(dir, name, origin);
    client
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: path.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap()
        .repo
}

fn computer(project: ProjectId, computer: &str) -> ProjectUpdateParams {
    ProjectUpdateParams {
        computer: Some(computer.to_owned()),
        ..project_update(project)
    }
}

/// A server with the fake tailnet, and `projectComputer` on or off.
fn server(data: &Path, on: bool) -> InProcess {
    let mut config = InProcess::config(data);
    config.tailnet = Some(Arc::new(FakeTailnet::default()));
    config.project_computer = on;
    InProcess::start(config)
}

/// Off, as it is until 0057's landing PR, `computer` is refused whatever its value, and the
/// capability isn't advertised.
#[tokio::test]
async fn computer_is_refused_until_project_computer_is_on() {
    let dir = temp_dir();
    let work = temp_dir();
    let server = server(dir.path(), false);
    let mut client = Client::connect(&server.socket).await;
    let init = client.initialize().await.unwrap();
    assert!(!init.capabilities.0.contains_key("projectComputer"));
    let mut params = create_params(work.path(), "app");
    params.repo_path = repo(work.path(), "app", Some("git@github.com:o/app.git"))
        .to_str()
        .unwrap()
        .to_owned();
    let project = client.call::<ProjectCreate>(params).await.unwrap().project;

    for value in ["a", ""] {
        let error = client
            .call::<ProjectUpdate>(computer(project.id, value))
            .await
            .unwrap_err();
        assert_eq!(kind(&error), ErrorKind::UnsupportedOption, "{value:?}");
    }
    server.stop().await;
}

/// On, `computer` takes only a device the filter admits, online or not, on a repository with an
/// `origin`, and empty clears it.
#[tokio::test]
async fn computer_needs_an_admitted_device_and_an_origin() {
    let dir = temp_dir();
    let work = temp_dir();
    let server = server(dir.path(), true);
    let mut client = Client::connect(&server.socket).await;
    let init = client.initialize().await.unwrap();
    assert!(init.capabilities.0.contains_key("projectComputer"));
    let path = repo(work.path(), "app", None);
    let mut params = create_params(work.path(), "app");
    params.repo_path = path.to_str().unwrap().to_owned();
    let project = client.call::<ProjectCreate>(params).await.unwrap().project;

    // Another user's node, a tagged one, and one the tailnet doesn't have.
    for refused in ["s", "t", "nowhere"] {
        let error = client
            .call::<ProjectUpdate>(computer(project.id, refused))
            .await
            .unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{refused}");
        assert_eq!(
            error.message,
            format!("Invalid params: {refused} isn't one of this computer's devices")
        );
    }
    let error = client
        .call::<ProjectUpdate>(computer(project.id, "a"))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Invalid params: This repository has no origin, so another computer can't find it."
    );
    let error = client
        .call::<ProjectUpdate>(computer(ProjectId::generate(), "a"))
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::ProjectNotFound);

    git(
        &path,
        &["remote", "add", "origin", "git@github.com:o/app.git"],
    );
    // `b` is offline, which doesn't matter: the user can pick it ahead of time.
    let set = client
        .call::<ProjectUpdate>(computer(project.id, "b"))
        .await
        .unwrap()
        .project;
    assert_eq!(set.computer.as_deref(), Some("b"));
    let cleared = client
        .call::<ProjectUpdate>(computer(project.id, ""))
        .await
        .unwrap()
        .project;
    assert_eq!(cleared.computer, None);
    server.stop().await;
}

/// `repo/match` finds the oldest entry whose `origin` is the same repository in any URL form, and
/// none for a repository this host doesn't have.
#[tokio::test]
async fn repo_match_finds_the_oldest_entry_with_the_same_origin() {
    let dir = temp_dir();
    let work = temp_dir();
    let server = server(dir.path(), false);
    let mut client = Client::ready(&server.socket).await;
    let work = work.path();
    add(&mut client, work, "bare", None).await;
    let first = add(
        &mut client,
        work,
        "first",
        Some("git@github.com:Ryan-Stoffel/parallax.git"),
    )
    .await;
    add(
        &mut client,
        work,
        "second",
        Some("https://me:token@github.com/ryan-stoffel/parallax/"),
    )
    .await;
    add(
        &mut client,
        work,
        "photon",
        Some("https://github.com/ryan-stoffel/photon"),
    )
    .await;

    let found = client
        .call::<RepoMatch>(RepoMatchParams {
            origin: "https://github.com/ryan-stoffel/parallax.git".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(found.repo.map(|repo| repo.id), Some(first.id));
    let none = client
        .call::<RepoMatch>(RepoMatchParams {
            origin: "git@github.com:ryan-stoffel/missing.git".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(none.repo, None);
    server.stop().await;
}
