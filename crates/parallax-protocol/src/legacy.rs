//! The names decision 0093 renamed, which plxd still speaks for one release: a Project and its
//! coordinator became an orchestrator thread (step 1), and a Space became a Project (step 2).
//!
//! Every renamed field and enum value in this crate has a serde `alias` for its old name, so a
//! message in the old names still decodes. A client that declares [`CLIENT_CAPABILITY`] in
//! `initialize` speaks the new names. Any other client is an app or phone from before 0093:
//! [`to_legacy`] rewrites what plxd sends it, and [`new_method`] reads its method names.
//!
//! `project/*` names both an old client's Projects (now orchestrators) and a new client's Projects
//! (once Spaces), so the client's capability decides: for an old client `project/create` is
//! `orchestrator/create`, and for a new one it is a Project's. `space/*` is always a Project's.
//!
//! The desktop app's `legacyNames.ts` does the reverse for a plxd from before 0093. Remove both,
//! and the aliases, when the window ends.

use serde_json::{Map, Value};

use crate::Capabilities;

/// The client capability that asks for the new names, `project/*` for a Project (once a Space)
/// included.
pub const CLIENT_CAPABILITY: &str = "projects";

/// A client's capabilities with only [`CLIENT_CAPABILITY`], for a client in this crate's version.
#[must_use]
pub fn client_capabilities() -> Capabilities {
    let mut capabilities = Capabilities::default();
    capabilities
        .0
        .insert(CLIENT_CAPABILITY.to_owned(), Map::new());
    capabilities
}

/// Each method step 1 renamed, old name first. Only an old client's `project/*` means these.
pub const METHODS: &[(&str, &str)] = &[
    ("project/list", "orchestrator/list"),
    ("project/create", "orchestrator/create"),
    ("project/update", "orchestrator/update"),
    ("project/delete", "orchestrator/delete"),
    ("project/start", "orchestrator/start"),
    ("project/fromThreads", "orchestrator/fromThreads"),
    ("coordinator/fresh", "orchestrator/fresh"),
];

/// Each method step 2 renamed, old name first, which any client may still call.
pub const SPACE_METHODS: &[(&str, &str)] = &[
    ("space/create", "project/create"),
    ("space/delete", "project/delete"),
    ("thread/setSpace", "thread/setProject"),
];

/// Each renamed event kind, old name first.
pub const EVENTS: &[(&str, &str)] = &[
    ("project.created", "orchestrator.created"),
    ("project.updated", "orchestrator.updated"),
    ("project.deleted", "orchestrator.deleted"),
];

/// Each renamed capability, old name first. plxd advertises both names.
pub const CAPABILITIES: &[(&str, &str)] = &[
    ("coordinator", "orchestrator"),
    ("coordinatorEpochs", "orchestratorEpochs"),
    ("projectArtifacts", "orchestratorArtifacts"),
    ("projectAutonomy", "orchestratorAutonomy"),
    ("projectComputer", "orchestratorComputer"),
    ("projectDelete", "orchestratorDelete"),
    ("projectEdit", "orchestratorEdit"),
    ("projectFromThreads", "orchestratorFromThreads"),
    ("projectPermission", "orchestratorPermission"),
    ("projectPlacement", "orchestratorPlacement"),
    ("projectTasks", "orchestratorTasks"),
    ("spaces", "projects"),
    ("spaceContext", "projectContext"),
    ("spaceThreads", "projectThreads"),
];

/// Each renamed error kind, old name first.
pub const ERROR_KINDS: &[(&str, &str)] = &[("projectNotFound", "orchestratorNotFound")];

/// The new name of method `old` from a client, if 0093 renamed it: for an old client (`legacy`),
/// `project/*` is an orchestrator's; for a new one it is a Project's and stays.
#[must_use]
pub fn new_method(old: &str, legacy: bool) -> Option<&'static str> {
    let step1 = if legacy { METHODS } else { &[] };
    step1
        .iter()
        .chain(SPACE_METHODS)
        .find(|(o, _)| *o == old)
        .map(|(_, new)| *new)
}

/// The old name of error kind `new`, if 0093 renamed it.
#[must_use]
pub fn old_error_kind(new: &str) -> Option<&'static str> {
    ERROR_KINDS
        .iter()
        .find(|(_, n)| *n == new)
        .map(|(old, _)| *old)
}

/// Rewrites `value`, the result of `method` or the params of `events/event`, to the old names.
///
/// It walks objects, skipping a transcript's items and a tool's input and output, which hold an
/// agent's own JSON. `method` picks the rules that depend on where a value sits.
pub fn to_legacy(method: &str, value: &mut Value) {
    let memory = method.starts_with("memory/");
    let defaults = method.starts_with("accounts/defaults/");
    walk(value, &|object| rename(object, memory, defaults));
}

/// Keys under which an agent's own JSON sits, which the rewrite leaves alone.
const OPAQUE: &[&str] = &[
    "items",
    "item",
    "input",
    "output",
    "content",
    "text",
    "arguments",
];

fn walk(value: &mut Value, rule: &impl Fn(&mut Map<String, Value>)) {
    match value {
        Value::Object(object) => {
            rule(object);
            for (key, child) in object.iter_mut() {
                if !OPAQUE.contains(&key.as_str()) {
                    walk(child, rule);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(|child| walk(child, rule)),
        _ => {}
    }
}

fn rename(object: &mut Map<String, Value>, memory: bool, defaults: bool) {
    // Step 2 first, since step 1 then takes `project` back for an orchestrator: a repo entry's
    // "is a Project", and the Project a thread was added to, were `space`.
    let thread = object.contains_key("repo") && object.contains_key("createdAt");
    if thread || matches!(object.get("project"), Some(Value::Bool(_))) {
        move_key(object, "project", "space");
    }
    let scope = memory && object.contains_key("id");
    if let Some(Value::String(kind)) = object.get_mut("kind") {
        if let Some((old, _)) = EVENTS.iter().find(|(_, new)| new == kind) {
            (*old).clone_into(kind);
        } else if scope && kind == "orchestrator" {
            // A memory scope.
            "project".clone_into(kind);
        }
    }
    move_key(object, "orchestratorThread", "coordinatorThread");
    if let Some(Value::Array(orchestrators)) = object.remove("orchestrators") {
        let orchestrators = orchestrators.into_iter().map(orchestrator).collect();
        object.insert("projects".to_owned(), Value::Array(orchestrators));
    }
    match object.remove("orchestrator") {
        // A provider's "can run one", and the accounts default for one.
        Some(value @ Value::Bool(_)) => {
            object.insert("coordinator".to_owned(), value);
        }
        Some(value) if defaults => {
            object.insert("coordinator".to_owned(), value);
        }
        // An orchestrator, or its id.
        Some(value) => {
            object.insert("project".to_owned(), orchestrator(value));
        }
        None => {}
    }
    if memory {
        for (key, old) in [("forScope", "project"), ("to", "coordinator")] {
            if let Some(Value::String(value)) = object.get_mut(key)
                && value == "orchestrator"
            {
                old.clone_into(value);
            }
        }
    }
}

/// An orchestrator in the old shape: its run is `coordinator`.
fn orchestrator(mut value: Value) -> Value {
    if let Value::Object(object) = &mut value
        && object.contains_key("repoPath")
    {
        move_key(object, "run", "coordinator");
    }
    value
}

fn move_key(object: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = object.remove(from) {
        object.insert(to.to_owned(), value);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_list_and_its_orchestrators_take_the_old_names() {
        let mut result = json!({
            "orchestrators": [{"id": "o1", "name": "fly", "repoPath": "/r", "run": "r1"}],
            "seq": 4
        });
        to_legacy("orchestrator/list", &mut result);
        assert_eq!(
            result,
            json!({
                "projects": [{"id": "o1", "name": "fly", "repoPath": "/r", "coordinator": "r1"}],
                "seq": 4
            })
        );
    }

    #[test]
    fn events_take_their_old_kinds_and_keys() {
        let mut created = json!({
            "subscription": "s", "seq": 1, "time": "t",
            "event": {"kind": "orchestrator.created",
                      "orchestrator": {"id": "o1", "repoPath": "/r", "run": "r1"}}
        });
        to_legacy("events/event", &mut created);
        assert_eq!(
            created["event"],
            json!({"kind": "project.created", "project": {"id": "o1", "repoPath": "/r", "coordinator": "r1"}})
        );
        let mut deleted = json!({"event": {"kind": "orchestrator.deleted", "orchestrator": "o1"}});
        to_legacy("events/event", &mut deleted);
        assert_eq!(
            deleted["event"],
            json!({"kind": "project.deleted", "project": "o1"})
        );
    }

    #[test]
    fn old_event_kinds_decode_as_their_orchestrator_variants() {
        use crate::ParallaxEvent;

        let orchestrator = json!({
            "id": "01a0d349-6e00-7c9e-80e2-0426486a8cae", "name": "parallax", "repoPath": "/r",
            "createdAt": "2026-09-24T12:00:00Z", "updatedAt": "2026-09-24T12:00:00Z"
        });
        let created: ParallaxEvent =
            serde_json::from_value(json!({"kind": "project.created", "project": orchestrator}))
                .unwrap();
        assert!(matches!(created, ParallaxEvent::OrchestratorCreated { .. }));
        let updated: ParallaxEvent =
            serde_json::from_value(json!({"kind": "project.updated", "project": orchestrator}))
                .unwrap();
        assert!(matches!(updated, ParallaxEvent::OrchestratorUpdated { .. }));
        let deleted: ParallaxEvent = serde_json::from_value(json!({
            "kind": "project.deleted", "project": "01a0d349-6e00-7c9e-80e2-0426486a8cae"
        }))
        .unwrap();
        assert!(matches!(deleted, ParallaxEvent::OrchestratorDeleted { .. }));
    }

    #[test]
    fn a_run_provider_default_and_memory_scope_take_the_old_names() {
        let mut run = json!({"run": {"id": "r2", "project": "o1", "orchestratorThread": "r1"}});
        to_legacy("agent/start", &mut run);
        assert_eq!(
            run,
            json!({"run": {"id": "r2", "project": "o1", "coordinatorThread": "r1"}})
        );

        let mut providers = json!({"providers": [{"efforts": true, "orchestrator": false}]});
        to_legacy("providers/list", &mut providers);
        assert_eq!(
            providers,
            json!({"providers": [{"efforts": true, "coordinator": false}]})
        );

        let account = json!({"kind": "subscription", "backend": "claude"});
        let mut defaults = json!({"orchestrator": account});
        to_legacy("accounts/defaults/get", &mut defaults);
        assert_eq!(defaults, json!({"coordinator": account}));

        let mut proposal = json!({"scope": {"kind": "orchestrator", "id": "o1"}, "to": "orchestrator", "forScope": "orchestrator"});
        to_legacy("memory/proposals", &mut proposal);
        assert_eq!(
            proposal,
            json!({"scope": {"kind": "project", "id": "o1"}, "to": "coordinator", "forScope": "project"})
        );
    }

    #[test]
    fn a_project_once_a_space_takes_its_old_name_and_project_names_an_orchestrator_again() {
        let mut listed = json!({
            "repos": [{"id": "p1", "name": "Coursework", "path": "/s", "project": true, "createdAt": "t"}],
            "threads": [{"id": "r1", "repo": "x", "createdAt": "t", "project": "p1"}],
            "runs": [{"id": "r1", "project": "x", "createdAt": "t"}]
        });
        to_legacy("thread/list", &mut listed);
        assert_eq!(listed["repos"][0]["space"], true);
        assert_eq!(listed["threads"][0]["space"], "p1");
        assert_eq!(listed["runs"][0]["project"], "x", "a run's scope stays");
    }

    #[test]
    fn project_methods_mean_an_orchestrator_only_to_an_old_client() {
        assert_eq!(
            new_method("project/create", true),
            Some("orchestrator/create")
        );
        assert_eq!(new_method("project/create", false), None);
        assert_eq!(new_method("space/create", true), Some("project/create"));
        assert_eq!(new_method("space/delete", false), Some("project/delete"));
        assert_eq!(
            new_method("thread/setSpace", false),
            Some("thread/setProject")
        );
    }

    #[test]
    fn an_agents_own_json_is_left_alone() {
        let mut output =
            json!({"items": [{"input": {"orchestrator": true, "orchestratorThread": 1}}]});
        let before = output.clone();
        to_legacy("agent/events", &mut output);
        assert_eq!(output, before);
    }
}
