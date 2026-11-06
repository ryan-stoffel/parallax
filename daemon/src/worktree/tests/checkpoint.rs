//! Checkpoints (0062) against a real worktree: capture, diff, and restore, none of which touch
//! the worktree's own index or branch.

use parallax_protocol::RunId;

use super::{git, git_output, init_repo, manager, rev_parse};
use crate::worktree::{DiffFormat, RunFolder, parse_numstat_z};

#[tokio::test]
async fn a_checkpoint_captures_restores_and_diffs_a_worktree_without_touching_its_index() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());
    let created = mgr
        .create_named(&repo, RunId::generate(), None, None)
        .await
        .unwrap();
    let folder = RunFolder::Worktree {
        path: &created.path,
        git_dir: &created.git_dir,
    };
    let (start, turn) = (
        "refs/parallax/checkpoints/t/0",
        "refs/parallax/checkpoints/t/1",
    );
    mgr.capture_checkpoint(folder, start).await.unwrap();

    // A turn edits a tracked file, adds an untracked one, and stages a third.
    let head = rev_parse(&created.path, "HEAD");
    std::fs::write(created.path.join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(created.path.join("new.txt"), "one\ntwo\n").unwrap();
    std::fs::write(created.path.join("staged.txt"), "s\n").unwrap();
    git(&created.path, &["add", "staged.txt"]);
    mgr.capture_checkpoint(folder, turn).await.unwrap();

    assert_eq!(
        rev_parse(&created.path, "HEAD"),
        head,
        "the branch never moves"
    );
    assert_eq!(
        git_output(&created.path, &["diff", "--cached", "--name-only"]),
        "staged.txt",
        "the index keeps only what the turn staged"
    );
    let (numstat, cut) = mgr
        .diff_checkpoints(folder, start, turn, DiffFormat::Numstat, 1 << 20)
        .await
        .unwrap();
    assert!(!cut);
    assert_eq!(
        parse_numstat_z(&numstat),
        vec![
            ("README.md".to_owned(), 1, 0),
            ("new.txt".to_owned(), 2, 0),
            ("staged.txt".to_owned(), 1, 0),
        ]
    );
    let patch = DiffFormat::Patch {
        ignore_whitespace: true,
    };
    let (diff, _) = mgr
        .diff_checkpoints(folder, start, turn, patch, 1 << 20)
        .await
        .unwrap();
    assert!(diff.contains("+++ b/new.txt"), "{diff}");
    let (cut_diff, cut) = mgr
        .diff_checkpoints(folder, start, turn, patch, 10)
        .await
        .unwrap();
    assert!(cut && cut_diff.len() == 10);

    // Back to the start: tracked edits undone, new files gone, the index at HEAD.
    mgr.restore_checkpoint(folder, start).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(created.path.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(!created.path.join("new.txt").exists());
    assert!(!created.path.join("staged.txt").exists());
    assert_eq!(git_output(&created.path, &["status", "--porcelain"]), "");

    // And forward again to the turn's files.
    mgr.restore_checkpoint(folder, turn).await.unwrap();
    assert!(created.path.join("new.txt").exists());

    let refs = mgr
        .list_refs(folder, "refs/parallax/checkpoints/t/")
        .await
        .unwrap();
    assert_eq!(refs, [start, turn]);
    mgr.delete_ref(RunFolder::Checkout(&repo), turn)
        .await
        .unwrap();
    assert!(!mgr.has_checkpoint(folder, turn).await.unwrap());
    assert!(mgr.has_checkpoint(folder, start).await.unwrap());
}
