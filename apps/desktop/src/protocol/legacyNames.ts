// 0093 renamed a Project and its coordinator to an orchestrator. A plxd from before it doesn't
// advertise `orchestrator` and speaks the old names; these map between the two for one release,
// as plxd's `legacy` module does for an app from before it. The desktop's connection and the
// web bridge use them, and remove them when the window ends.

/** The client capability that asks plxd for the new names. */
export const CLIENT_CAPABILITY = "orchestrators";

const METHODS: Record<string, string> = {
  "orchestrator/list": "project/list",
  "orchestrator/create": "project/create",
  "orchestrator/update": "project/update",
  "orchestrator/delete": "project/delete",
  "orchestrator/start": "project/start",
  "orchestrator/fromThreads": "project/fromThreads",
  "orchestrator/fresh": "coordinator/fresh",
};

const EVENTS: Record<string, string> = {
  "project.created": "orchestrator.created",
  "project.updated": "orchestrator.updated",
  "project.deleted": "orchestrator.deleted",
};

const CAPABILITIES: Record<string, string> = {
  coordinator: "orchestrator",
  coordinatorEpochs: "orchestratorEpochs",
  projectArtifacts: "orchestratorArtifacts",
  projectAutonomy: "orchestratorAutonomy",
  projectComputer: "orchestratorComputer",
  projectDelete: "orchestratorDelete",
  projectEdit: "orchestratorEdit",
  projectFromThreads: "orchestratorFromThreads",
  projectPermission: "orchestratorPermission",
  projectPlacement: "orchestratorPlacement",
  projectTasks: "orchestratorTasks",
};

/** Keys under which an agent's own JSON sits, which no mapping touches. */
const OPAQUE = new Set(["items", "item", "input", "output", "content", "text", "arguments"]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a plxd with `capabilities` is from before 0093: it has Projects, not orchestrators. */
export function isLegacy(capabilities: Record<string, unknown>): boolean {
  return "coordinator" in capabilities && !("orchestrator" in capabilities);
}

/** An old plxd's capabilities, with each renamed one under its new name too. */
export function capabilitiesFromLegacy<T>(capabilities: Record<string, T>): Record<string, T> {
  const named = { ...capabilities };
  for (const [old, name] of Object.entries(CAPABILITIES)) {
    if (old in capabilities && !(name in named)) named[name] = capabilities[old]!;
  }
  return named;
}

/** Renames key `from` to `to` in place, keeping the value. */
function move(object: Json, from: string, to: string) {
  if (!(from in object)) return;
  object[to] = object[from];
  delete object[from];
}

/** Rewrites every object in `value` with `rule`, outside an agent's own JSON. */
function walk(value: unknown, rule: (object: Json) => void): unknown {
  if (Array.isArray(value)) for (const item of value) walk(item, rule);
  else if (isObject(value)) {
    rule(value);
    for (const [key, child] of Object.entries(value)) if (!OPAQUE.has(key)) walk(child, rule);
  }
  return value;
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** `method` and its `params` in the old names, for a plxd from before 0093. */
export function requestToLegacy(method: string, params: unknown): [string, unknown] {
  const memory = method.startsWith("memory/");
  const mapped = walk(copy(params), (object) => {
    if (typeof object["orchestrator"] === "string") move(object, "orchestrator", "project");
    move(object, "orchestratorThread", "coordinatorThread");
    if (object["role"] === "orchestrator") object["role"] = "coordinator";
    if (memory && object["kind"] === "orchestrator" && "id" in object) object["kind"] = "project";
    if (memory && object["forScope"] === "orchestrator") object["forScope"] = "project";
  });
  return [METHODS[method] ?? method, mapped];
}

/** An orchestrator in an old plxd's shape: its run is `coordinator`. */
function orchestrator(value: unknown) {
  if (isObject(value) && "repoPath" in value) move(value, "coordinator", "run");
}

/** The result of `method` from a plxd before 0093, in the new names. */
export function resultFromLegacy(method: string, result: unknown): unknown {
  const memory = method.startsWith("memory/");
  const defaults = method.startsWith("accounts/defaults/");
  const mapped = copy(result);
  // A scheduled task's or a landing's `project` is an orchestrator; elsewhere it's a run's scope.
  if (isObject(mapped)) {
    if (method.startsWith("land/") && isObject(mapped["landing"]))
      move(mapped["landing"], "project", "orchestrator");
    if (method.startsWith("schedule/")) {
      const tasks = Array.isArray(mapped["tasks"]) ? mapped["tasks"] : [mapped];
      for (const task of tasks) if (isObject(task)) move(task, "project", "orchestrator");
    }
  }
  return walk(mapped, (object) => {
    if (Array.isArray(object["projects"])) {
      for (const item of object["projects"]) orchestrator(item);
      move(object, "projects", "orchestrators");
    }
    if (isObject(object["project"]) && "repoPath" in object["project"]) {
      orchestrator(object["project"]);
      move(object, "project", "orchestrator");
    }
    move(object, "coordinatorThread", "orchestratorThread");
    if (typeof object["coordinator"] === "boolean" || defaults)
      move(object, "coordinator", "orchestrator");
    if (memory) {
      if (object["kind"] === "project" && "id" in object) object["kind"] = "orchestrator";
      if (object["forScope"] === "project") object["forScope"] = "orchestrator";
      if (object["to"] === "coordinator") object["to"] = "orchestrator";
    }
  });
}

/**
 * An `events/event` notification's params in the new names. It holds for any plxd: one from
 * 0093 on can still replay an event it stored before.
 */
export function eventFromLegacy<T>(params: T): T {
  const event = isObject(params) ? params["event"] : undefined;
  if (!isObject(event)) return params;
  const kind = event["kind"];
  if (typeof kind === "string" && kind in EVENTS) {
    const next = copy(params) as Json;
    const renamed = next["event"] as Json;
    renamed["kind"] = EVENTS[kind];
    orchestrator(renamed["project"]);
    move(renamed, "project", "orchestrator");
    return next as T;
  }
  if (kind === "agent.started" && isObject(event["run"]) && "coordinatorThread" in event["run"]) {
    const next = copy(params) as Json;
    move((next["event"] as Json)["run"] as Json, "coordinatorThread", "orchestratorThread");
    return next as T;
  }
  return params;
}

/** An error from a plxd before 0093, with its kind in the new name. */
export function errorFromLegacy<T extends { data?: unknown }>(error: T): T {
  if (isObject(error.data) && error.data["kind"] === "projectNotFound")
    return { ...error, data: { ...error.data, kind: "orchestratorNotFound" } };
  return error;
}
