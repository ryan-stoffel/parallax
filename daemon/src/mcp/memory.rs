//! A thread's memory tools (0044, PLX-405), served next to [`super::thread`]'s.
//!
//! - An orchestrator gets `memory_read`, `memory_propose`, and `memory_write`, at the You, Repo,
//!   and Orchestrator scopes. Its writes add a `learned` inbox item. It proposes for the user a
//!   rewrite the Memory tab asked for, and any change to the brief, which only the user writes.
//! - An orchestrator's child gets `memory_read` and `memory_propose` at the same scopes. A proposal
//!   waits for the orchestrator's next wake-up.
//! - A thread outside an orchestrator, in a repository, gets `memory_read` and `memory_propose` at
//!   its repository's scope only. A proposal waits for the user in the Memory tab.
//!
//! A scope is named `you`, `repo`, or `project`. The server resolves it from its caller, so no
//! tool takes an id, and plxd checks the caller's role again on `memory/write` and
//! `memory/propose`.

use std::path::Path;

use parallax_protocol::methods::{MemoryList, MemoryPropose, MemoryRead, MemoryWrite, ThreadList};
use parallax_protocol::{
    AgentRun, MemoryListParams, MemoryProposalTo, MemoryProposeParams, MemoryReadParams,
    MemoryScope, MemoryWriteParams, Orchestrator, RepoId, RunId, ScopeId, ThreadListParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{MAX_CONTEXT_BYTES, MAX_PATH_BYTES, Plxd, check_text, object, parse, pretty, tool};

/// An orchestrator's child's memory tools, and a plain thread's.
pub const CHILD_TOOLS: &[&str] = &["memory_read", "memory_propose"];

/// An orchestrator's memory tools.
pub const ORCHESTRATOR_TOOLS: &[&str] = &["memory_read", "memory_propose", "memory_write"];

/// The longest title, in bytes, as plxd takes it.
const MAX_TITLE_BYTES: usize = 256;

/// The longest proposal, in bytes, as plxd takes it.
const MAX_PROPOSAL_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    /// A thread outside an orchestrator.
    Thread,
    /// An orchestrator's run other than its orchestrator.
    Child,
    /// An orchestrator.
    Orchestrator,
}

/// The memory a caller reaches: its role, and the ids its scopes stand for.
#[derive(Clone, Debug)]
pub(super) struct Memory {
    role: Role,
    /// Its repository's entry, if it has one.
    repo: Option<RepoId>,
    /// Its Orchestrator.
    project: Option<ScopeId>,
}

impl Memory {
    /// `caller`'s memory: in `project` if it is an orchestrator's run, as its `orchestrator` or a
    /// child, or else in its own repository. `None` for a thread with no repository.
    pub(super) async fn of(
        plxd: &Plxd,
        caller: &AgentRun,
        project: Option<&Orchestrator>,
        orchestrator: bool,
    ) -> Result<Option<Self>, String> {
        let listed = plxd.call::<ThreadList>(ThreadListParams {}).await?;
        // Repo entries keep canonical paths; an orchestrator keeps the one it was created with.
        let repo_at = |path: &str| {
            let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
            listed
                .repos
                .iter()
                .find(|repo| !repo.scratch && Path::new(&repo.path) == canonical)
                .map(|repo| repo.id)
        };
        if let Some(project) = project {
            return Ok(Some(Self {
                role: if orchestrator {
                    Role::Orchestrator
                } else {
                    Role::Child
                },
                repo: repo_at(&project.repo_path),
                project: Some(project.id),
            }));
        }
        Ok(
            super::thread::own_repo(&listed, caller.id).map(|repo| Self {
                role: Role::Thread,
                repo: Some(repo),
                project: None,
            }),
        )
    }

    pub(super) fn names(&self) -> &'static [&'static str] {
        match self.role {
            Role::Orchestrator => ORCHESTRATOR_TOOLS,
            Role::Thread | Role::Child => CHILD_TOOLS,
        }
    }

    /// The scopes the caller names, the default first.
    fn scopes(&self) -> &'static [&'static str] {
        match self.role {
            Role::Thread => &["repo"],
            Role::Child | Role::Orchestrator => &["orchestrator", "repo", "you"],
        }
    }

    pub(super) fn definitions(&self) -> Vec<Value> {
        let scope = json!({
            "type": "string",
            "enum": self.scopes(),
            "description": format!(
                "Whose memory: orchestrator (your orchestrator's), repo (your repository's, shared \
                 by its orchestrators and threads), or you (the user's own, across everything). \
                 Default {}.",
                self.scopes()[0]
            ),
        });
        let title = json!({"type": "string", "description": "The entry's title, one line of at most 256 bytes."});
        let read = tool(
            "memory_read",
            "Read memory: the brief (brief.md), entries (memory/<kind>/<slug>.md, each a preference, convention, decision, or gotcha with its title, source, date, and writer), and knowledge (knowledge/<slug>.md). Without a path, list them.",
            object(
                json!({
                    "scope": scope,
                    "path": {"type": "string", "description": "A file's path from the list, such as memory/decision/use-vitest.md. Omit it to list the files."},
                }),
                &[],
            ),
            true,
        );
        let kinds: &[&str] = match self.role {
            Role::Orchestrator => &["preference", "convention", "decision", "gotcha", "brief"],
            Role::Thread | Role::Child => &["preference", "convention", "decision", "gotcha"],
        };
        let mut properties = json!({
            "scope": scope,
            "kind": {"type": "string", "enum": kinds},
            "title": title,
            "content": {"type": "string", "description": "The entry, at most 4 KiB: the fact, and for a decision why. For a brief, the whole brief, at most 1 MiB."},
        });
        if self.role == Role::Orchestrator {
            properties["path"] = json!({"type": "string", "description": "The entry this rewrites, memory/<kind>/<name>.md at scope, as memory_read lists it. Saving the proposal replaces it. Omit it for a new entry or a brief."});
        }
        let propose = tool(
            "memory_propose",
            match self.role {
                Role::Orchestrator => {
                    "Propose a memory change for the user to save or discard: a rewrite the Memory tab asked for, or a new brief (kind brief, orchestrator scope; only the user writes the brief). To rewrite an existing entry, name it in path."
                }
                Role::Child => {
                    "Propose a memory entry: a lasting fact a later thread should start with, not what you did today. Your orchestrator reviews it at its next wake-up and saves it or drops it."
                }
                Role::Thread => {
                    "Propose a memory entry for your repository: a lasting fact a later thread should start with, not what you did today. The user reviews it and saves it or drops it."
                }
            },
            object(properties, &["kind", "title", "content"]),
            false,
        );
        if self.role != Role::Orchestrator {
            return vec![read, propose];
        }
        let write = tool(
            "memory_write",
            "Write memory, replacing the file: an entry (memory/<preference|convention|decision|gotcha>/<slug>.md, which needs a title) or knowledge (knowledge/<slug>.md). Not the brief: propose it with memory_propose. Check memory_read first, so an entry isn't saved twice. Only lasting facts belong here.",
            object(
                json!({
                    "scope": scope,
                    "path": {"type": "string", "description": "The file's path."},
                    "content": {"type": "string", "description": "An entry's body, or the whole knowledge file, at most 1 MiB."},
                    "title": title,
                    "source": {"type": "string", "description": "The run or message the entry came from, such as a child's run id. Default: you."},
                }),
                &["path", "content"],
            ),
            false,
        );
        vec![read, propose, write]
    }

    /// The protocol's scope for `name`, one of [`Memory::scopes`], or the default.
    fn scope(&self, name: Option<&str>) -> Result<MemoryScope, String> {
        let name = name.unwrap_or(self.scopes()[0]);
        if !self.scopes().contains(&name) {
            return Err(format!("scope must be one of {}", self.scopes().join(", ")));
        }
        match name {
            "you" => Ok(MemoryScope::You),
            "repo" => self.repo.map(|id| MemoryScope::Repo { id }).ok_or_else(|| {
                "your repository isn't in Parallax's repository list, so it has no memory yet"
                    .to_owned()
            }),
            _ => self
                .project
                .map(|id| MemoryScope::Orchestrator { id })
                .ok_or_else(|| "you aren't in an orchestrator".to_owned()),
        }
    }

    /// Runs memory tool `name`, one of [`Memory::names`], for run `caller`.
    pub(super) async fn call(
        &self,
        plxd: &Plxd,
        caller: RunId,
        name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        match name {
            "memory_read" => {
                let ReadArgs { scope, path } = parse(arguments)?;
                let scope = self.scope(scope.as_deref())?;
                let Some(path) = path else {
                    let files = plxd
                        .call::<MemoryList>(MemoryListParams { scope })
                        .await?
                        .files;
                    return Ok(pretty(&json!({"files": files})));
                };
                check_text("path", &path, MAX_PATH_BYTES)?;
                // Naming the caller records the entry's use (PLX-943).
                let read = plxd
                    .call::<MemoryRead>(MemoryReadParams {
                        scope,
                        path,
                        from: Some(caller),
                    })
                    .await?;
                Ok(pretty(&read))
            }
            "memory_propose" => {
                let ProposeArgs {
                    scope,
                    kind,
                    title,
                    content,
                    path,
                } = parse(arguments)?;
                let scope = self.scope(scope.as_deref())?;
                check_text("title", &title, MAX_TITLE_BYTES)?;
                let cap = if kind == "brief" {
                    MAX_CONTEXT_BYTES
                } else {
                    MAX_PROPOSAL_BYTES
                };
                check_text("content", &content, cap)?;
                if let Some(path) = &path {
                    check_text("path", path, MAX_PATH_BYTES)?;
                }
                // `brief` is the orchestrator's rewrite of the brief, which has no kind. plxd
                // refuses it from anyone else, and any kind it doesn't know.
                let kind = match kind.as_str() {
                    "brief" => None,
                    other => Some(serde_json::from_value(json!(other)).map_err(|e| e.to_string())?),
                };
                let proposed = plxd
                    .call::<MemoryPropose>(MemoryProposeParams {
                        from: caller,
                        scope,
                        kind,
                        title,
                        content,
                        replaces: path,
                    })
                    .await?;
                Ok(match proposed.to {
                    MemoryProposalTo::User => {
                        "Proposed. It waits for the user to save or drop it.".to_owned()
                    }
                    _ => "Proposed. Your orchestrator reviews it at its next wake-up.".to_owned(),
                })
            }
            "memory_write" => {
                let WriteArgs {
                    scope,
                    path,
                    content,
                    title,
                    source,
                } = parse(arguments)?;
                let scope = self.scope(scope.as_deref())?;
                check_text("path", &path, MAX_PATH_BYTES)?;
                if content.len() > MAX_CONTEXT_BYTES {
                    return Err(format!("content must be at most {MAX_CONTEXT_BYTES} bytes"));
                }
                let written = plxd
                    .call::<MemoryWrite>(MemoryWriteParams {
                        scope,
                        path,
                        content,
                        title,
                        source,
                        from: Some(caller),
                    })
                    .await?;
                Ok(pretty(&written.file))
            }
            other => Err(format!("no tool is named {other:?}")),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeArgs {
    #[serde(default)]
    scope: Option<String>,
    kind: String,
    title: String,
    content: String,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    #[serde(default)]
    scope: Option<String>,
    path: String,
    content: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    source: Option<String>,
}
