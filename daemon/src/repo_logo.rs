//! `repo/logo` (PLX-1272): the file in a repository that is most clearly its favicon or logo, for
//! the app to make its icon. plxd only finds the file. The app encodes it, as with any icon image
//! (0038), since plxd never re-encodes one and an SVG takes a renderer to draw.

use std::path::Path;
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, RepoLogo, RepoLogoParams, RepoLogoResult};

use crate::images::encode;
use crate::server::Daemon;
use crate::threads;
use crate::worktree::RunFolder;

/// The largest file taken, which is far past any real logo and well under the protocol's frame.
const MAX_LOGO_BYTES: u64 = 2 * 1024 * 1024;

/// The deepest a logo's folder may be.
const MAX_FOLDERS: usize = 5;

/// The formats taken and their media types, the preferred first: a vector stays crisp, and an
/// `.ico` often holds only small sizes.
const FORMATS: [(&str, &str); 7] = [
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("webp", "image/webp"),
    ("ico", "image/x-icon"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
];

/// Folders whose images are someone else's, or stand in for a real project's, matched by
/// [`is_skipped`].
const SKIPPED_FOLDERS: &[&str] = &[
    "bower_components",
    "demo",
    "demos",
    "dist",
    "e2e",
    "example",
    "examples",
    "fixture",
    "fixtures",
    "mock",
    "mocks",
    "node_modules",
    "out",
    "pods",
    "sample",
    "samples",
    "snapshots",
    "spec",
    "specs",
    "target",
    "template",
    "templates",
    "test",
    "testdata",
    "testing",
    "tests",
    "third-party",
    "third_party",
    "thirdparty",
    "vendor",
    "vendored",
    "vendors",
];

/// Folders that hold a project's own assets, so that a logo in one is the project's.
const ASSET_FOLDERS: &[&str] = &[
    ".github",
    "app",
    "art",
    "artwork",
    "asset",
    "assets",
    "brand",
    "branding",
    "build",
    "design",
    "doc",
    "docs",
    "graphics",
    "icon",
    "icons",
    "image",
    "images",
    "img",
    "imgs",
    "logo",
    "logos",
    "media",
    "public",
    "readme",
    "res",
    "resources",
    "site",
    "src",
    "src-tauri",
    "static",
    "web",
    "website",
    "www",
];

/// Folders whose children are each a project of a monorepo.
const WORKSPACE_FOLDERS: &[&str] = &["apps", "packages", "services"];

/// Whether a folder's name, or one part of it, is in [`SKIPPED_FOLDERS`], so `example-app` and
/// `__tests__` count as `example` and `tests`.
fn is_skipped(folder: &str) -> bool {
    SKIPPED_FOLDERS.contains(&folder)
        || folder
            .split(['-', '_', '.'])
            .any(|part| SKIPPED_FOLDERS.contains(&part))
}

/// Whether a logo in these folders, from the repository's root down, is the project's own: only
/// asset folders, under at most one project folder or a monorepo's project. So `src/assets` and
/// `react-native-app/assets` count, and `src/integrations/slack` doesn't.
fn is_project_folder(folders: &[String]) -> bool {
    if folders.len() > MAX_FOLDERS || folders.iter().any(|folder| is_skipped(folder)) {
        return false;
    }
    let assets = match folders {
        [workspace, _, rest @ ..] if WORKSPACE_FOLDERS.contains(&workspace.as_str()) => rest,
        [project, rest @ ..] if !ASSET_FOLDERS.contains(&project.as_str()) => rest,
        all => all,
    };
    assets
        .iter()
        .all(|folder| ASSET_FOLDERS.contains(&folder.as_str()))
}

/// How clearly a file name, without its extension, names the project's logo, the clearest lowest:
/// a favicon is drawn for small sizes, as an icon is, and a logo may be a wide wordmark. `None` for
/// any other name.
fn name_rank(stem: &str, repo: &str) -> Option<u8> {
    match stem {
        "favicon" => Some(0),
        "icon" | "app-icon" | "app_icon" | "appicon" | "apple-touch-icon" => Some(1),
        "logo" | "logo-icon" | "logo-mark" | "logomark" => Some(2),
        "logo-dark" | "logo-light" | "logo-black" | "logo-white" => Some(3),
        _ if stem == repo
            || stem.strip_suffix("-logo") == Some(repo)
            || stem.strip_suffix("_logo") == Some(repo)
            || stem.strip_prefix("logo-") == Some(repo)
            || stem.strip_suffix("-icon") == Some(repo) =>
        {
            Some(2)
        }
        _ => None,
    }
}

/// What orders `path`, relative to the repository and with `/` separators, among the repository's
/// logos: its name, how deep it is, then its format. `None` when it isn't a logo. Names compare
/// ignoring case.
fn rank(path: &str, repo: &str) -> Option<(u8, usize, usize)> {
    let path = path.to_lowercase();
    let mut folders: Vec<String> = path.split('/').map(str::to_owned).collect();
    let file = folders.pop()?;
    let (stem, extension) = file.rsplit_once('.')?;
    let format = FORMATS.iter().position(|(e, _)| *e == extension)?;
    let name = name_rank(stem, &repo.to_lowercase())?;
    is_project_folder(&folders).then_some((name, folders.len(), format))
}

/// `files`' logos for a repository named `repo`, the best first, ties in path order.
fn candidates<'a>(files: &'a [String], repo: &str) -> Vec<&'a str> {
    let mut found: Vec<_> = files
        .iter()
        .filter_map(|path| rank(path, repo).map(|rank| (rank, path.as_str())))
        .collect();
    found.sort_unstable();
    found.into_iter().map(|(_, path)| path).collect()
}

/// The file at `path` in `root`, unless it's a symlink, which could point anywhere on the host, or
/// isn't a regular file, is empty, or is over [`MAX_LOGO_BYTES`].
async fn read(root: &Path, path: &str) -> Option<RepoLogo> {
    let full = root.join(path);
    let metadata = tokio::fs::symlink_metadata(&full).await.ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_LOGO_BYTES {
        return None;
    }
    let extension = path.rsplit_once('.')?.1.to_lowercase();
    let (_, media_type) = FORMATS.iter().find(|(e, _)| *e == extension)?;
    let bytes = tokio::fs::read(&full).await.ok()?;
    Some(RepoLogo {
        path: path.to_owned(),
        media_type: (*media_type).to_owned(),
        data: encode(&bytes),
    })
}

/// `repo/logo`: the first of the repository's logos that can be read. A Project or the scratch
/// entry has none, since its repository is plxd's.
pub(crate) async fn logo(
    daemon: &Arc<Daemon>,
    params: RepoLogoParams,
) -> Result<RepoLogoResult, ErrorObject> {
    let entry = threads::start_entry(daemon, Some(params.repo)).await?;
    if entry.fields.scratch || entry.fields.project {
        return Ok(RepoLogoResult { logo: None });
    }
    let root = Path::new(&entry.fields.path);
    let files = daemon
        .agents
        .worktrees()
        .files(RunFolder::Checkout(root))
        .await
        .map_err(|error| ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string()))?;
    for path in candidates(&files, &entry.fields.name) {
        if let Some(logo) = read(root, path).await {
            return Ok(RepoLogoResult { logo: Some(logo) });
        }
    }
    Ok(RepoLogoResult { logo: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn best(files: &[&str]) -> Option<String> {
        let files: Vec<String> = files.iter().map(|&f| f.to_owned()).collect();
        candidates(&files, "Acme")
            .first()
            .map(|&path| path.to_owned())
    }

    #[test]
    fn prefers_a_favicon_then_an_icon_then_a_logo_shallowest_and_sharpest_first() {
        let order = [
            "public/favicon.svg",
            "public/favicon.png",
            "apps/web/public/favicon.ico",
            "src-tauri/icons/icon.png",
            "logo.svg",
            "docs/images/readme/acme-logo.svg",
            "assets/logo-dark.svg",
        ];
        for at in 0..order.len() {
            assert_eq!(best(&order[at..]).as_deref(), Some(order[at]));
        }
    }

    #[test]
    fn finds_logos_in_common_layouts_ignoring_case() {
        for path in [
            "Logo.PNG",
            "ACME.svg",
            ".github/assets/logo.png",
            "react-native-app/assets/images/icon.png",
            "packages/site/static/img/favicon.ico",
            "web/favicon.png",
        ] {
            assert_eq!(best(&[path]).as_deref(), Some(path));
        }
    }

    #[test]
    fn skips_anything_not_clearly_the_projects_logo() {
        for path in [
            "README.md",
            "logo.txt",
            "logo.tiff",
            "catalog-logo.png",
            "src/integrations/slack/logo.svg",
            "providers/github/logo.svg",
            "tests/fixtures/favicon.ico",
            "examples/logo.svg",
            "vendor/lib/assets/logo.png",
            "node_modules/pkg/logo.svg",
            "assets/a/b/c/d/e/logo.svg",
            "example-app/public/favicon.ico",
            "test-app/public/favicon.ico",
            "packages/example-app/public/favicon.svg",
            "apps/e2e-app/public/favicon.ico",
            "__test__/favicon.ico",
            "__fixtures__/logo.png",
            "mock/favicon.ico",
            "testing/logo.png",
            "vendors/logo.png",
            "bower_components/logo.png",
            "Pods/logo.png",
            "third-party/logo.png",
        ] {
            assert_eq!(best(&[path]), None, "{path}");
        }
    }
}
