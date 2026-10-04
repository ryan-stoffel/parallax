//! A thread's memory tools (0044, PLX-405), served next to [`super::thread`]'s.
//!
//! - A Project's coordinator gets `memory_read`, `memory_propose`, and `memory_write`, at the You,
//!   Repo, and Project scopes. Its writes add a `learned` inbox item. It proposes for the user a
//!   rewrite the Memory tab asked for, and any change to the brief, which only the user writes.
//! - A Project's child gets `memory_read` and `memory_propose` at the same scopes. A proposal
//!   waits for the coordinator's next wake-up.
//! - A thread outside a Project, in a repository, gets `memory_read` and `memory_propose` at its
//!   repository's scope only. A proposal waits for the user in the Memory tab.
//!
//! A scope is named `you`, `repo`, or `project`. The server resolves it from its caller, so no
//! tool takes an id, and plxd checks the caller's role again on `memory/write` and
//! `memory/propose`.

use std::path::Path;

use parallax_protocol::methods::{MemoryList, MemoryPropose, MemoryRead, MemoryWrite, ThreadList};
use parallax_protocol::{
    AgentRun, MemoryListParams, MemoryProposalTo, MemoryProposeParams, MemoryReadParams,
    MemoryScope, MemoryWriteParams, Project, ProjectId, RepoId, RunId, ThreadListParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{MAX_CONTEXT_BYTES, MAX_PATH_BYTES, Plxd, check_text, parse, pretty};

/// Every memory tool, as some caller gets it.
pub const TOOLS: &[&str] = &["memory_read", "memory_propose", "memory_write"];

/// A Project's child's memory tools, and a plain thread's.
pub const CHILD_TOOLS: &[&str] = &["memory_read", "memory_propose"];

/// A coordinator's memory tools.
pub const COORDINATOR_TOOLS: &[&str] = &["memory_read", "memory_propose", "memory_write"];

/// The longest title, in bytes, as plxd takes it.
const MAX_TITLE_BYTES: usize = 256;

/// The longest proposal, in bytes, as plxd takes it.
const MAX_PROPOSAL_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    /// A thread outside a Project.
    Thread,
    /// A Project's run other than its coordinator.
    Child,
    /// A Project's coordinator.
    Coordinator,
}

/// The memory a caller reaches: its role, and the ids its scopes stand for.
#[derive(Clone, Debug)]
pub(super) struct Memory {
    role: Role,
    /// Its repository's entry, if it has one.
    repo: Option<RepoId>,
    /// Its Project.
    project: Option<ProjectId>,
}

impl Memory {
    /// `caller`'s memory: in `project` if it is a Project's run, as its `coordinator` or a
    /// child, or else in its own repository. `None` for a thread with no repository.
    pub(super) async fn of(
        plxd: &mut Plxd,
        caller: &AgentRun,
        project: Option<&Project>,
        coordinator: bool,
    ) -> Result<Option<Self>, String> {
        let listed = plxd.call::<ThreadList>(ThreadListParams {}).await?;
        // Repo entries keep canonical paths; a Project keeps the one it was created with.
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
                role: if coordinator {
                    Role::Coordinator
                } else {
                    Role::Child
                },
                repo: repo_at(&project.repo_path),
                project: Some(project.id),
            }));
        }
        let repo = listed
            .threads
            .iter()
            .find(|thread| thread.id == caller.id)
            .and_then(|thread| listed.repos.iter().find(|repo| repo.id == thread.repo))
            .filter(|repo| !repo.scratch)
            .map(|repo| repo.id);
        Ok(repo.map(|repo| Self {
            role: Role::Thread,
            repo: Some(repo),
            project: None,
        }))
    }

    pub(super) fn names(&self) -> &'static [&'static str] {
        match self.role {
            Role::Coordinator => COORDINATOR_TOOLS,
            Role::Thread | Role::Child => CHILD_TOOLS,
        }
    }

    /// The scopes the caller names, the default first.
    fn scopes(&self) -> &'static [&'static str] {
        match self.role {
            Role::Thread => &["repo"],
            Role::Child | Role::Coordinator => &["project", "repo", "you"],
        }
    }

    pub(super) fn definitions(&self) -> Vec<Value> {
        let scope = json!({
            "type": "string",
            "enum": self.scopes(),
            "description": format!(
                "Whose memory: project (your Project's), repo (your repository's, shared by its \
                 Projects and threads), or you (the user's own, across everything). Default {}.",
                self.scopes()[0]
            ),
        });
        let object = |properties: Value, required: &[&str]| {
            json!({
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            })
        };
        let tool = |name: &str, description: &str, schema: Value, read_only: bool| {
            json!({
                "name": name,
                "description": description,
                "inputSchema": schema,
                "annotations": {"readOnlyHint": read_only, "destructiveHint": false},
            })
        };
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
            Role::Coordinator => &["preference", "convention", "decision", "gotcha", "brief"],
            Role::Thread | Role::Child => &["preference", "convention", "decision", "gotcha"],
        };
        let mut properties = json!({
            "scope": scope,
            "kind": {"type": "string", "enum": kinds},
            "title": title,
            "content": {"type": "string", "description": "The entry, at most 4 KiB: the fact, and for a decision why. For a brief, the whole brief, at most 1 MiB."},
        });
        if self.role == Role::Coordinator {
            properties["path"] = json!({"type": "string", "description": "The entry this rewrites, memory/<kind>/<name>.md at scope, as memory_read lists it. Saving the proposal replaces it. Omit it for a new entry or a brief."});
        }
        let propose = tool(
            "memory_propose",
            match self.role {
                Role::Coordinator => {
                    "Propose a memory change for the user to save or discard: a rewrite the Memory tab asked for, or a new brief (kind brief, project scope; only the user writes the brief). To rewrite an existing entry, name it in path."
                }
                Role::Child => {
                    "Propose a memory entry: a lasting fact a later thread should start with, not what you did today. Your coordinator reviews it at its next wake-up and saves it or drops it."
                }
                Role::Thread => {
                    "Propose a memory entry for your repository: a lasting fact a later thread should start with, not what you did today. The user reviews it and saves it or drops it."
                }
            },
            object(properties, &["kind", "title", "content"]),
            false,
        );
        if self.role != Role::Coordinator {
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
                .map(|id| MemoryScope::Project { id })
                .ok_or_else(|| "you aren't in a Project".to_owned()),
        }
    }

    /// Runs memory tool `name`, one of [`Memory::names`], for run `caller`.
    pub(super) async fn call(
        &self,
        socket: &Path,
        caller: RunId,
        name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        match name {
            "memory_read" => {
                let ReadArgs { scope, path } = parse(arguments)?;
                let scope = self.scope(scope.as_deref())?;
                let mut plxd = Plxd::open(socket).await?;
                let Some(path) = path else {
                    let files = plxd
                        .call::<MemoryList>(MemoryListParams { scope })
                        .await?
                        .files;
                    return Ok(pretty(&json!({"files": files})));
                };
                check_text("path", &path, MAX_PATH_BYTES)?;
                let read = plxd
                    .call::<MemoryRead>(MemoryReadParams { scope, path })
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
                // `brief` is the coordinator's rewrite of the brief, which has no kind. plxd
                // refuses it from anyone else, and any kind it doesn't know.
                let kind = match kind.as_str() {
                    "brief" => None,
                    other => Some(serde_json::from_value(json!(other)).map_err(|e| e.to_string())?),
                };
                let mut plxd = Plxd::open(socket).await?;
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
                    _ => "Proposed. Your coordinator reviews it at its next wake-up.".to_owned(),
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
                let mut plxd = Plxd::open(socket).await?;
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

#[cfg(test)]
mod tests {
    use super::{CHILD_TOOLS, COORDINATOR_TOOLS, Memory, Role, TOOLS};

    fn memory(role: Role) -> Memory {
        Memory {
            role,
            repo: None,
            project: None,
        }
    }

    /// 0044: only a coordinator writes, and a thread outside a Project reaches its repository
    /// alone.
    #[test]
    fn each_role_gets_its_own_tools_and_scopes() {
        for (role, names) in [
            (Role::Coordinator, COORDINATOR_TOOLS),
            (Role::Child, CHILD_TOOLS),
            (Role::Thread, CHILD_TOOLS),
        ] {
            let memory = memory(role);
            assert_eq!(memory.names(), names);
            let listed: Vec<String> = memory
                .definitions()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_owned())
                .collect();
            assert_eq!(listed, names);
            assert!(names.iter().all(|name| TOOLS.contains(name)));
        }
        let thread = memory(Role::Thread);
        let refused = thread.scope(Some("you")).unwrap_err();
        assert!(refused.contains("one of repo"), "{refused}");
        // Only a coordinator proposes the brief.
        let kinds = |role| {
            memory(role).definitions()[1]["inputSchema"]["properties"]["kind"]["enum"].clone()
        };
        assert!(kinds(Role::Coordinator).to_string().contains("brief"));
        assert!(!kinds(Role::Child).to_string().contains("brief"));
    }
}
