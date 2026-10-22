//! `bundle/*` and `git/startMerge` (0057): a device plxd in-process with a Project child, a
//! second repository cloned from it as the home plxd's, and the home side's helpers over a
//! `peer::Plxd` on the device's socket.

use std::path::{Path, PathBuf};

use parallax_protocol::jsonrpc::{ErrorObject, INVALID_PARAMS};
use parallax_protocol::methods::{
    AgentStart, BundleApply, BundleBegin, BundlePrepare, BundleRead, BundleWrite, GitStartMerge,
};
use parallax_protocol::{
    AgentStatus, BundleApplyParams, BundleBeginParams, BundleId, BundlePrepareParams,
    BundleReadParams, BundleWriteParams, ErrorKind, GitStartMergeParams, RunId,
};
use plxd::backend::fake::Step;
use plxd::backend::process::{Environment, Launcher};
use plxd::paths::DataDir;
use plxd::peer::Plxd;
use plxd::worktree::WorktreeManager;
use tempfile::TempDir;

use crate::agents::{
    Conn, Host, create, end_turn, fake, git, init, project_params, start_params, subscribe, text,
    until, updated_to,
};
use crate::support::{InProcess, kind, temp_dir};

const MIB: u64 = 1024 * 1024;

/// The cap plxd gives a bundle.
const CAP: u64 = 64 * MIB;

/// How much the chunk test reads at a time, so a small bundle spans several chunks.
const CHUNK: u64 = 4096;

/// A device with a Project child that ran `steps`, and the child's run id, repository, and
/// worktree, once it is `status`.
struct Device {
    host: Host,
    client: Conn,
    run: RunId,
    repo: PathBuf,
    worktree: PathBuf,
}

async fn device(host: Host, status: AgentStatus) -> Device {
    let mut client = host.client().await;
    let params = project_params(host.dir.path());
    let repo = PathBuf::from(&params.repo_path);
    let project = create(&mut client, params).await;
    subscribe(&mut client, project.id, 0).await;
    let start = start_params(project.id, "Work");
    let run = start.run_id;
    let started = client.call::<AgentStart>(start).await.unwrap().run;
    let worktree = PathBuf::from(started.worktree_path.unwrap());
    until(&mut client, updated_to(status)).await;
    Device {
        host,
        client,
        run,
        repo,
        worktree,
    }
}

fn finishing() -> Host {
    Host::start(temp_dir(), fake(vec![init("s"), end_turn("Done.")]))
}

/// A home repository cloned from `from`, with a manager for its git, both under `dir`.
fn home(dir: &Path, from: &Path) -> (PathBuf, WorktreeManager) {
    let repo = dir.join("home");
    git(
        dir,
        &[
            "clone",
            "-q",
            from.to_str().unwrap(),
            repo.to_str().unwrap(),
        ],
    );
    git(&repo, &["config", "user.name", "Home"]);
    git(&repo, &["config", "user.email", "home@example.com"]);
    let data = dir.join("data");
    let launcher = Launcher::new(DataDir::new(&data).unwrap(), Environment::inherited());
    (repo, WorktreeManager::new(launcher, &data))
}

fn commit(dir: &Path, name: &str, contents: &[u8]) -> String {
    std::fs::write(dir.join(name), contents).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", name]);
    git(dir, &["rev-parse", "HEAD"])
}

fn peer(device: &Device) -> Plxd {
    Plxd::local(device.host.server.socket.clone())
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

/// `len` bytes zlib can't shrink, so a bundle holding them is about as large.
fn noise(len: u64) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()[0]
        })
        .collect()
}

#[tokio::test]
async fn commits_cross_both_ways_and_start_a_merge() {
    let device = device(finishing(), AgentStatus::Completed).await;
    let work = TempDir::new().unwrap();
    let (home_repo, home_git) = home(work.path(), &device.repo);
    let base = git(&home_repo, &["rev-parse", "HEAD"]);
    let peer = peer(&device);

    // Device to home: the child's commit, without what home has.
    let child = commit(&device.worktree, "child.txt", b"child\n");
    let file = work.path().join("child.bundle");
    let tip = peer
        .receive_bundle(device.run, vec![base.clone()], &file, CAP)
        .await
        .unwrap();
    assert_eq!(tip.as_deref(), Some(child.as_str()));
    let remote = format!("refs/parallax/remote/{}", device.run);
    home_git
        .apply_bundle(&home_repo, &file, &remote, &child)
        .await
        .unwrap();
    assert_eq!(git(&home_repo, &["rev-parse", &remote]), child);
    // Nothing new since.
    assert_eq!(
        peer.receive_bundle(device.run, vec![child.clone()], &file, CAP)
            .await
            .unwrap(),
        None
    );

    // Home to device: a commit landed on home's main, written only as `parallax-sync/<run id>`.
    let landed = commit(&home_repo, "landed.txt", b"landed\n");
    let file = work.path().join("landed.bundle");
    let bundled = home_git
        .create_bundle(&home_repo, "refs/heads/main", &[base], &file)
        .await
        .unwrap();
    assert_eq!(
        (bundled.tip.as_str(), bundled.written),
        (landed.as_str(), true)
    );
    let refs_before = git(&device.repo, &["for-each-ref", "--format=%(refname)"]);
    peer.send_bundle(device.run, &file, &landed).await.unwrap();
    let sync = format!("refs/parallax-sync/{}", device.run);
    assert_eq!(git(&device.repo, &["rev-parse", &sync]), landed);
    let refs_after = git(&device.repo, &["for-each-ref", "--format=%(refname)"]);
    let mut expected: Vec<&str> = refs_before.lines().chain([sync.as_str()]).collect();
    expected.sort_unstable();
    assert_eq!(refs_after.lines().collect::<Vec<_>>(), expected);

    // The child's worktree merges it, left for the child to commit.
    peer.call::<GitStartMerge>(GitStartMergeParams {
        run: device.run,
        tip: landed.clone(),
    })
    .await
    .unwrap();
    assert_eq!(git(&device.worktree, &["rev-parse", "MERGE_HEAD"]), landed);
    device.host.server.stop().await;
}

/// `bundle/begin` with `bytes`' size and `sha256`, one `bundle/write` of them, and
/// `bundle/apply`'s error for `tip`, with the bundle's id.
async fn refused(
    device: &mut Device,
    bytes: &[u8],
    sha256: String,
    tip: String,
) -> (BundleId, ErrorObject) {
    let client = &mut device.client;
    let id = client
        .call::<BundleBegin>(BundleBeginParams {
            run: device.run,
            size: bytes.len() as u64,
            sha256,
        })
        .await
        .unwrap()
        .id;
    let data = data_encoding::BASE64.encode(bytes);
    let write = BundleWriteParams {
        id,
        offset: 0,
        data,
    };
    client.call::<BundleWrite>(write).await.unwrap();
    let error = client
        .call::<BundleApply>(BundleApplyParams { id, tip })
        .await
        .unwrap_err();
    (id, error)
}

/// The bytes of a bundle of home's `main` without `exclude`'s history.
async fn home_bundle(home_git: &WorktreeManager, home_repo: &Path, exclude: String) -> Vec<u8> {
    let file = home_repo.with_extension("bundle");
    home_git
        .create_bundle(home_repo, "refs/heads/main", &[exclude], &file)
        .await
        .unwrap();
    std::fs::read(&file).unwrap()
}

#[tokio::test]
async fn a_bundle_needing_commits_the_device_lacks_is_refused_as_missing_commits() {
    let mut device = device(finishing(), AgentStatus::Completed).await;
    let work = TempDir::new().unwrap();
    let (home_repo, home_git) = home(work.path(), &device.repo);
    let first = commit(&home_repo, "one.txt", b"one\n");
    let second = commit(&home_repo, "two.txt", b"two\n");

    // Its prerequisite is a commit the device never got.
    let bytes = home_bundle(&home_git, &home_repo, first.clone()).await;
    let (_, error) = refused(&mut device, &bytes, sha256(&bytes), second).await;
    assert_eq!(kind(&error), ErrorKind::BundleMissingCommits);
    assert!(error.message.contains(&first), "{}", error.message);
    device.host.server.stop().await;
}

#[tokio::test]
async fn a_bundle_is_refused_for_a_wrong_hash_or_a_wrong_tip() {
    let mut device = device(finishing(), AgentStatus::Completed).await;
    let work = TempDir::new().unwrap();
    let (home_repo, home_git) = home(work.path(), &device.repo);
    let sync = format!("refs/parallax-sync/{}", device.run);
    let base = git(&home_repo, &["rev-parse", "HEAD"]);
    let second = commit(&home_repo, "two.txt", b"two\n");

    // A bundle the device could take, under another hash, then with another tip.
    let bytes = home_bundle(&home_git, &home_repo, base).await;
    for (sha256, tip, says) in [
        (sha256(b"other"), second.clone(), "SHA-256"),
        (sha256(&bytes), "0".repeat(40), "not 0000"),
    ] {
        let (id, error) = refused(&mut device, &bytes, sha256, tip).await;
        assert_eq!(kind(&error), ErrorKind::BundleFailed);
        assert!(error.message.contains(says), "{}", error.message);
        // Applied or not, it's gone.
        let again = device
            .client
            .call::<BundleApply>(BundleApplyParams {
                id,
                tip: second.clone(),
            })
            .await
            .unwrap_err();
        assert!(
            again.message.contains("expired or was dropped"),
            "{}",
            again.message
        );
    }
    assert!(
        !git(&device.repo, &["for-each-ref", "--format=%(refname)"]).contains(&sync),
        "nothing was written"
    );
    device.host.server.stop().await;
}

#[tokio::test]
async fn chunks_split_anywhere_up_to_one_mib_and_the_tip_stays_pinned() {
    let mut device = device(finishing(), AgentStatus::Completed).await;
    let work = TempDir::new().unwrap();
    let (home_repo, home_git) = home(work.path(), &device.repo);
    let base = git(&home_repo, &["rev-parse", "HEAD"]);
    let pinned = commit(&device.worktree, "noise.bin", &noise(3 * CHUNK));

    let prepared = device
        .client
        .call::<BundlePrepare>(BundlePrepareParams {
            run: device.run,
            exclude: vec![base],
        })
        .await
        .unwrap();
    assert_eq!(prepared.tip, pinned);
    let bundle = prepared.bundle.unwrap();
    assert!(bundle.size > 2 * CHUNK, "{}", bundle.size);
    let read = |offset: u64, length: u64| BundleReadParams {
        id: bundle.id,
        offset,
        length,
    };
    let too_long = device
        .client
        .call::<BundleRead>(read(0, MIB + 1))
        .await
        .unwrap_err();
    assert_eq!(too_long.code, INVALID_PARAMS);

    let mut bytes = Vec::new();
    for offset in (0..bundle.size).step_by(usize::try_from(CHUNK).unwrap()) {
        let chunk = device
            .client
            .call::<BundleRead>(read(offset, CHUNK))
            .await
            .unwrap();
        bytes.extend(data_encoding::BASE64.decode(chunk.data.as_bytes()).unwrap());
        assert_eq!(bytes.len() as u64, (offset + CHUNK).min(bundle.size));
        // The branch moves between chunks.
        commit(&device.worktree, &format!("more-{offset}.txt"), b"more\n");
    }
    let end = device
        .client
        .call::<BundleRead>(read(bundle.size, MIB))
        .await
        .unwrap();
    assert_eq!(end.data, "");
    assert_eq!(sha256(&bytes), bundle.sha256);

    let file = work.path().join("noise.bundle");
    std::fs::write(&file, &bytes).unwrap();
    home_git
        .apply_bundle(&home_repo, &file, "refs/parallax/remote/x", &pinned)
        .await
        .unwrap();
    assert_eq!(
        git(&home_repo, &["rev-parse", "refs/parallax/remote/x"]),
        pinned
    );
    device.host.server.stop().await;
}

#[tokio::test]
async fn a_bundle_over_the_cap_is_refused_and_not_kept() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(vec![init("s"), end_turn("Done.")]));
    config.max_bundle_bytes = 2048;
    let server = InProcess::start(config);
    let mut device = device(Host { dir, server }, AgentStatus::Completed).await;
    let base = git(&device.repo, &["rev-parse", "HEAD"]);
    let bundles = device.host.dir.path().join("tmp").join("bundles");

    // Under the device's cap but over the home's, so the home refuses it and drops it there.
    commit(&device.worktree, "small.txt", b"small\n");
    let file = device.host.dir.path().join("small.bundle");
    let home = peer(&device)
        .receive_bundle(device.run, vec![base.clone()], &file, 64)
        .await
        .unwrap_err();
    assert!(home.contains("over the"), "{home}");
    assert!(!file.exists());
    assert_eq!(std::fs::read_dir(&bundles).unwrap().count(), 0);

    commit(&device.worktree, "big.txt", &noise(4096));

    let prepare = device
        .client
        .call::<BundlePrepare>(BundlePrepareParams {
            run: device.run,
            exclude: vec![base],
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&prepare), ErrorKind::BundleTooLarge);
    let begin = device
        .client
        .call::<BundleBegin>(BundleBeginParams {
            run: device.run,
            size: 2049,
            sha256: sha256(b""),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&begin), ErrorKind::BundleTooLarge);
    assert_eq!(std::fs::read_dir(bundles).unwrap().count(), 0);
    device.host.server.stop().await;
}

#[tokio::test]
async fn only_a_known_run_and_hex_object_ids_are_taken() {
    let mut device = device(finishing(), AgentStatus::Completed).await;
    let client = &mut device.client;
    let run = device.run;
    let sha1 = git(&device.repo, &["rev-parse", "HEAD"]);

    for exclude in [
        "-q",
        "HEAD",
        "refs/heads/main",
        &sha1[..39],
        &sha1.to_uppercase(),
    ] {
        let params = BundlePrepareParams {
            run,
            exclude: vec![exclude.to_owned()],
        };
        let error = client.call::<BundlePrepare>(params).await.unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{exclude}");
    }
    let unknown = BundlePrepareParams {
        run: RunId::generate(),
        exclude: Vec::new(),
    };
    let error = client.call::<BundlePrepare>(unknown).await.unwrap_err();
    assert!(
        error.message.contains("has no worktree"),
        "{}",
        error.message
    );
    let merge = GitStartMergeParams {
        run,
        tip: "--abort".to_owned(),
    };
    assert_eq!(
        client.call::<GitStartMerge>(merge).await.unwrap_err().code,
        INVALID_PARAMS
    );
    let begin = BundleBeginParams {
        run,
        size: 1,
        sha256: "-".repeat(64),
    };
    assert_eq!(
        client.call::<BundleBegin>(begin).await.unwrap_err().code,
        INVALID_PARAMS
    );

    // A chunk goes only where the last one ended, inside the promised size.
    let id = client
        .call::<BundleBegin>(BundleBeginParams {
            run,
            size: 4,
            sha256: sha256(b"abcd"),
        })
        .await
        .unwrap()
        .id;
    for (offset, data) in [(1, "YWI="), (0, "YWJjZGU=")] {
        let write = BundleWriteParams {
            id,
            offset,
            data: data.to_owned(),
        };
        let error = client.call::<BundleWrite>(write).await.unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{offset} {data}");
    }
    let apply = BundleApplyParams {
        id,
        tip: "HEAD".to_owned(),
    };
    assert_eq!(
        client.call::<BundleApply>(apply).await.unwrap_err().code,
        INVALID_PARAMS
    );
    device.host.server.stop().await;
}

#[tokio::test]
async fn start_merge_is_refused_while_the_run_works() {
    let host = Host::start(
        temp_dir(),
        fake(vec![init("hang-1"), text("Working"), Step::Hang]),
    );
    let mut device = device(host, AgentStatus::Running).await;
    let tip = git(&device.repo, &["rev-parse", "HEAD"]);
    let error = device
        .client
        .call::<GitStartMerge>(GitStartMergeParams {
            run: device.run,
            tip,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::RunBusy);
    device.host.server.stop().await;
}
