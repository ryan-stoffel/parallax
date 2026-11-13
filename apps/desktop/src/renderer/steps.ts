// What a thread's steps say, as the desktop's transcript (AgentChat.tsx) and the mobile app word
// them: each tool call's line, what the agent is doing now, and a run of steps summed up, with the
// kind of work each is, whose icon each app draws itself. Pure, so both apps share it.

import { t } from "i18next";

import { msg } from "../i18n";
import type { JsonValue } from "../protocol/generated/protocol";
import { isObject, plxdTools, type Item } from "./transcript";

/** The kinds of work a step is, each with its icon in the app that draws it. */
export type Kind =
  | "thinking"
  | "shell"
  | "reading"
  | "searching"
  | "editing"
  | "writing"
  | "fetching"
  | "agent"
  | "skill"
  | "mcp"
  | "plxd"
  | "computer"
  | "planning"
  | "working"
  | "compacting";

// What a tool is doing, in a word, by the names common tools use.
const verbs: Partial<Record<string, string>> = {
  Bash: msg("Running"),
  Read: msg("Reading"),
  Grep: msg("Searching"),
  Glob: msg("Searching"),
  WebSearch: msg("Searching"),
  WebFetch: msg("Fetching"),
  Edit: msg("Editing"),
  MultiEdit: msg("Editing"),
  Write: msg("Writing"),
  Task: msg("Running agent"),
  Agent: msg("Running agent"),
};

// The kind of work a tool does, by the names common tools use.
const toolKinds: Partial<Record<string, Kind>> = {
  Bash: "shell",
  Read: "reading",
  NotebookRead: "reading",
  LS: "reading",
  Grep: "searching",
  Glob: "searching",
  WebSearch: "searching",
  ToolSearch: "searching",
  Edit: "editing",
  MultiEdit: "editing",
  NotebookEdit: "editing",
  Write: "writing",
  WebFetch: "fetching",
  Task: "agent",
  Agent: "agent",
  Skill: "skill",
  TodoWrite: "planning",
  // Claude Code's task tools, which keep its plan in place of TodoWrite (PLX-248).
  TaskCreate: "planning",
  TaskUpdate: "planning",
  TaskList: "planning",
  TaskGet: "planning",
};

/** The kind of work a tool call does: a plxd or other MCP server's tool, or by its name. */
export function toolKind(name: string | null): Kind {
  if (name === "computer_use" || name?.startsWith(computerTools)) return "computer";
  if (name?.startsWith(plxdTools)) return "plxd";
  if (mcpTool(name)) return "mcp";
  // The table's own names only, so "constructor" or "toString" is any other tool.
  return (name !== null && Object.hasOwn(toolKinds, name) && toolKinds[name]) || "working";
}

/** What the agent is doing: a label, and what it's doing it to. */
export interface Activity {
  label: string;
  detail?: string;
}

/** The header of the work in progress: what its latest item is doing. */
export function activity(item?: Item): Activity {
  switch (item?.kind) {
    case "reasoning":
      return { label: t("Thinking") };
    case "tool": {
      const plxd = plxdCall(item, true);
      if (plxd) return plxd;
      // Including a plxd tool this app doesn't know.
      const mcp = mcpTool(item.name);
      if (mcp) return { label: t("Using {{server}}", { server: mcp.server }), detail: mcp.tool };
      if (item.name === "Skill") return { label: t("Using skill"), detail: skillName(item.input) };
      const verb = verbs[item.name ?? ""];
      return {
        label: verb ? t(verb) : (item.name ?? t("Working")),
        detail: toolHint(item.input),
      };
    }
    case "todo":
      return { label: t("Planning") };
    default:
      return { label: t("Working") };
  }
}

// The input field that says what a call does, by the names common tools use.
const hintFields = ["command", "file_path", "path", "pattern", "url", "query", "description"];

export function toolHint(input?: JsonValue, fields = hintFields): string {
  if (!isObject(input)) return "";
  const value = fields.map((f) => input[f]).find((v) => typeof v === "string");
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

/** A path relative to the run's worktree, when it's inside it. */
export function relative(path: string, root?: string) {
  if (!root) return path;
  const base = root.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
    ? path.slice(base.length + 1)
    : path;
}

/** The file a call acts on, relative to the run's worktree. */
export const filePath = (input?: JsonValue, root?: string) =>
  relative(toolHint(input, ["file_path", "notebook_path", "path"]), root);

/**
 * A tool call's step row as a line, as T3 Code words one (PLX-584): the command it ran, or what it
 * did and to what. A plxd or other MCP server's tool reads by its server and tool, and a plxd tool
 * says what it's `doing` while it runs (PLX-843).
 */
export function stepLabel(
  item: Extract<Item, { kind: "tool" }>,
  root?: string,
  doing = false,
): string {
  const plxd = plxdCall(item, doing);
  if (plxd) return plxd.detail ? `${plxd.label}: ${plxd.detail}` : plxd.label;
  const mcp = mcpTool(item.name);
  if (mcp) return `${mcp.server}: ${mcp.tool}`;
  const { input } = item;
  const path = filePath(input, root);
  switch (item.name) {
    case "Bash":
      return toolHint(input, ["command"]) || t("Ran a command");
    case "Read":
    case "NotebookRead":
      return path ? t("Read {{path}}", { path }) : t("Read a file");
    case "LS":
      return path ? t("Listed {{path}}", { path }) : t("Listed a folder");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path ? t("Edited {{path}}", { path }) : t("Edited a file");
    case "Write":
      return path ? t("Wrote {{path}}", { path }) : t("Wrote a file");
    case "Grep": {
      const pattern = toolHint(input, ["pattern"]);
      if (!pattern) return t("Searched code");
      return path
        ? t("Searched {{pattern}} in {{path}}", { pattern, path })
        : t("Searched {{pattern}}", { pattern });
    }
    case "Glob": {
      const pattern = toolHint(input, ["pattern"]);
      return pattern ? t("Searched files {{pattern}}", { pattern }) : t("Searched files");
    }
    case "WebSearch": {
      const query = toolHint(input, ["query"]);
      return query ? t("Searched the web for {{query}}", { query }) : t("Searched the web");
    }
    case "WebFetch": {
      const url = toolHint(input, ["url"]);
      return url ? t("Fetched {{url}}", { url }) : t("Fetched a page");
    }
    case "Skill": {
      const skill = skillName(input);
      return skill ? t("Used skill {{skill}}", { skill }) : t("Used a skill");
    }
    case "Task":
    case "Agent": {
      const description = toolHint(input, ["description"]);
      return description ? t("Ran agent {{description}}", { description }) : t("Ran an agent");
    }
  }
  const hint = toolHint(input);
  const name = item.name ?? t("Tool");
  return hint ? `${name} ${hint}` : name;
}

/** What a run of steps did, in a line, and the kind of work whose icon it shows. */
export interface StepsSummary {
  label: string;
  kind: Kind;
  /** How many of its calls failed or were denied. */
  failures: number;
}

/**
 * What a run of steps did, as T3 Code sums one up (PLX-584): the MCP servers it used, up to two of
 * Parallax's calls in words (PLX-843), then its two main kinds of call with counts, commands and
 * edits first, then how many others, as in "Used Linear, ran 3 commands, and changed 2 files".
 * Thoughts and notices aren't counted, unless they're all there is.
 */
export function summarize(items: readonly Item[]): StepsSummary {
  const steps = items.filter((i) => i.kind !== "notice");
  const failures = steps.filter(
    (i) => i.kind === "tool" && (i.status === "error" || i.status === "denied"),
  ).length;
  const calls = steps.filter((i) => i.kind === "tool" || i.kind === "todo");
  if (calls.length === 0) {
    const n = steps.length;
    return {
      label: t("Thought {{count}} times", { count: n, defaultValue_one: "Thought" }),
      kind: "thinking",
      failures,
    };
  }
  const servers: string[] = [];
  // Parallax's calls by what they did, and how many times (PLX-843).
  const plxd = new Map<string, number>();
  const kinds = new Set<Kind>();
  // By kind of call, in the order each first came: its calls, and the files of edits.
  const counts = new Map<string, { calls: number; files: Set<string> }>();
  for (const call of calls) {
    const kind = call.kind === "todo" ? "planning" : toolKind(call.name);
    kinds.add(kind);
    const done = call.kind === "tool" ? plxdLabel(call.name)?.[1] : undefined;
    if (done) {
      plxd.set(done, (plxd.get(done) ?? 0) + 1);
      continue;
    }
    if (call.kind === "tool" && (kind === "mcp" || kind === "plxd")) {
      const server = kind === "plxd" ? "Parallax" : mcpTool(call.name)!.server;
      if (!servers.includes(server)) servers.push(server);
      continue;
    }
    const group = call.kind === "tool" && call.name === "WebSearch" ? "web" : kind;
    const count = counts.get(group) ?? { calls: 0, files: new Set() };
    count.calls++;
    count.files.add(call.kind === "tool" ? filePath(call.input) || call.callId : call.key);
    counts.set(group, count);
  }
  const ranked = [...counts]
    .map(([group, count], order) => ({ group, count, order, rank: callRanks[group] ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, 2)
    .sort((a, b) => a.order - b.order);
  const parts = ranked.map(({ group, count }) => callLabel(group, count.calls, count.files.size));
  // Up to two of Parallax's in words, as "Checked orchestration capabilities", more as using it.
  const said = [...plxd].map(([label, n]) =>
    n > 1
      ? t("{{label}} {{count}} times", {
          label: t(label),
          count: n,
          defaultValue_one: "{{label}} once",
        })
      : t(label),
  );
  if (said.length > 2 && !servers.includes("Parallax")) servers.push("Parallax");
  parts.unshift(
    ...(servers.length > 0 ? [t("Used {{servers}}", { servers: list.format(servers) })] : []),
    ...(said.length > 2 ? [] : said),
  );
  const others =
    calls.length -
    calls.filter((c) => c.kind === "tool" && ["mcp", "plxd"].includes(toolKind(c.name))).length -
    ranked.reduce((n, { count }) => n + count.calls, 0);
  if (others > 0)
    parts.push(
      t("performed {{count}} other actions", {
        count: others,
        defaultValue_one: "performed {{count}} other action",
      }),
    );
  const label = list.format(
    parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))),
  );
  const [only] = kinds;
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    kind: kinds.size === 1 ? only! : "working",
    failures,
  };
}

// Commands and edits lead a summary, and calls of tools this app doesn't know come last.
const callRanks: Partial<Record<string, number>> = { shell: 0, editing: 0, writing: 0, working: 2 };

/** A kind of call in a summary, by how many there were and how many files they changed. */
function callLabel(group: string, calls: number, files: number): string {
  const count = calls;
  switch (group) {
    case "shell":
      return t("Ran {{count}} commands", { count, defaultValue_one: "Ran {{count}} command" });
    case "editing":
    case "writing":
      return t("Changed {{count}} files", {
        count: files,
        defaultValue_one: "Changed {{count}} file",
      });
    case "reading":
      return t("Read {{count}} files", { count, defaultValue_one: "Read {{count}} file" });
    case "searching":
      return t("Searched code {{count}} times", { count, defaultValue_one: "Searched code once" });
    case "web":
      return t("Searched the web {{count}} times", {
        count,
        defaultValue_one: "Searched the web once",
      });
    case "fetching":
      return t("Fetched {{count}} pages", { count, defaultValue_one: "Fetched {{count}} page" });
    case "agent":
      return t("Ran {{count}} agents", { count, defaultValue_one: "Ran {{count}} agent" });
    case "skill":
      return t("Used {{count}} skills", { count, defaultValue_one: "Used {{count}} skill" });
    case "computer":
      return t("Used apps {{count}} times", { count, defaultValue_one: "Used apps once" });
    case "planning":
      return t("Updated the plan");
    default:
      return t("Used {{count}} tools", { count, defaultValue_one: "Used {{count}} tool" });
  }
}

/**
 * Joins parts: "a", "a and b", or "a, b, and c", as `Intl.ListFormat` does, which the mobile
 * app's Hermes lacks.
 */
const list = {
  format: (parts: string[]) =>
    parts.length < 2
      ? parts.join("")
      : parts.length === 2
        ? t("{{first}} and {{second}}", { first: parts[0], second: parts[1] })
        : t("{{list}}, and {{last}}", { list: parts.slice(0, -1).join(", "), last: parts.at(-1) }),
};

// A thread's plxd tools (0041), by what they're doing and what they did (PLX-843), then the 0019
// orchestrator tools older transcripts hold.
const plxdLabels: Partial<Record<string, readonly [doing: string, done: string]>> = {
  thread_launch: [msg("Starting a child thread"), msg("Started a child thread")],
  thread_fork: [msg("Forking a thread"), msg("Forked a thread")],
  thread_list: [msg("Listing threads"), msg("Listed threads")],
  thread_read: [msg("Reading a thread"), msg("Read a thread")],
  thread_search: [msg("Searching threads"), msg("Searched threads")],
  thread_send: [msg("Messaging a thread"), msg("Messaged a thread")],
  thread_wait: [msg("Waiting on a thread"), msg("Waited on a thread")],
  thread_interrupt: [msg("Interrupting a thread"), msg("Interrupted a thread")],
  thread_update: [msg("Updating a thread"), msg("Updated a thread")],
  thread_merge_back: [msg("Merging a thread back"), msg("Merged a thread back")],
  create_threads: [msg("Creating threads"), msg("Created threads")],
  orchestrator_capabilities: [
    msg("Checking orchestration capabilities"),
    msg("Checked orchestration capabilities"),
  ],
  delegate_task: [msg("Delegating a task"), msg("Delegated a task")],
  task_status: [msg("Checking on a task"), msg("Checked on a task")],
  task_cancel: [msg("Cancelling a task"), msg("Cancelled a task")],
  schedule_task: [msg("Scheduling a task"), msg("Scheduled a task")],
  list_scheduled_tasks: [msg("Listing scheduled tasks"), msg("Listed scheduled tasks")],
  update_scheduled_task: [msg("Updating a scheduled task"), msg("Updated a scheduled task")],
  delete_scheduled_task: [msg("Deleting a scheduled task"), msg("Deleted a scheduled task")],
  run_scheduled_task_now: [msg("Running a scheduled task"), msg("Ran a scheduled task")],
  request_secret: [msg("Asking you for a secret"), msg("Asked you for a secret")],
  present_files: [msg("Presenting files"), msg("Presented files")],
  html_render: [msg("Rendering a page"), msg("Rendered a page")],
  html_preview: [msg("Previewing a page"), msg("Previewed a page")],
  pr_link: [msg("Linking a pull request"), msg("Linked a pull request")],
  pr_unlink: [msg("Unlinking a pull request"), msg("Unlinked a pull request")],
  link_pull_request: [msg("Linking a pull request"), msg("Linked a pull request")],
  unlink_pull_request: [msg("Unlinking a pull request"), msg("Unlinked a pull request")],
  list_thread_pull_requests: [msg("Listing pull requests"), msg("Listed pull requests")],
  watch_pull_request: [msg("Watching a pull request"), msg("Watched a pull request")],
  unwatch_pull_request: [msg("Unwatching a pull request"), msg("Unwatched a pull request")],
  memory_read: [msg("Reading memory"), msg("Read memory")],
  memory_propose: [msg("Proposing a memory"), msg("Proposed a memory")],
  memory_write: [msg("Writing memory"), msg("Wrote memory")],
  device_list: [msg("Listing devices"), msg("Listed devices")],
  device_open: [msg("Opening a device"), msg("Opened a device")],
  device_screenshot: [msg("Taking a device screenshot"), msg("Took a device screenshot")],
  device_close: [msg("Closing a device"), msg("Closed a device")],
  preview_open: [msg("Opening a preview"), msg("Opened a preview")],
  preview_list: [msg("Listing previews"), msg("Listed previews")],
  preview_status: [msg("Checking the preview"), msg("Checked the preview")],
  preview_close: [msg("Closing the preview"), msg("Closed the preview")],
  preview_navigate: [msg("Navigating the preview"), msg("Navigated the preview")],
  preview_snapshot: [msg("Reading the page"), msg("Read the page")],
  preview_click: [msg("Clicking in the preview"), msg("Clicked in the preview")],
  preview_hover: [msg("Hovering in the preview"), msg("Hovered in the preview")],
  preview_drag: [msg("Dragging in the preview"), msg("Dragged in the preview")],
  preview_type: [msg("Typing in the preview"), msg("Typed in the preview")],
  preview_press: [msg("Pressing a key"), msg("Pressed a key")],
  preview_select: [msg("Choosing an option"), msg("Chose an option")],
  preview_scroll: [msg("Scrolling the preview"), msg("Scrolled the preview")],
  preview_resize: [msg("Resizing the preview"), msg("Resized the preview")],
  preview_upload: [msg("Uploading a file"), msg("Uploaded a file")],
  preview_dialog: [msg("Answering a dialog"), msg("Answered a dialog")],
  preview_evaluate: [msg("Running a script in the preview"), msg("Ran a script in the preview")],
  preview_wait_for: [msg("Waiting on the page"), msg("Waited on the page")],
  preview_set_appearance: [
    msg("Setting the preview's appearance"),
    msg("Set the preview's appearance"),
  ],
  preview_recording_start: [msg("Recording the preview"), msg("Started a recording")],
  preview_recording_stop: [msg("Stopping the recording"), msg("Stopped the recording")],
  ask: [msg("Asking the orchestrator"), msg("Asked the orchestrator")],
  answer: [msg("Answering a question"), msg("Answered a question")],
  escalate: [msg("Passing a question to you"), msg("Passed a question to you")],
  land: [msg("Queuing a thread to land"), msg("Queued a thread to land")],
  checks_propose: [msg("Proposing checks"), msg("Proposed checks")],
  read_context: [msg("Reading shared context"), msg("Read shared context")],
  write_context: [msg("Writing shared context"), msg("Wrote shared context")],
  spawn_agent: [msg("Starting a subagent"), msg("Started a subagent")],
  list_agents: [msg("Listing subagents"), msg("Listed subagents")],
  agent_status: [msg("Checking on a subagent"), msg("Checked on a subagent")],
  message_agent: [msg("Messaging a subagent"), msg("Messaged a subagent")],
  cancel_agent: [msg("Stopping a subagent"), msg("Stopped a subagent")],
  agent_diff: [msg("Reading a subagent's diff"), msg("Read a subagent's diff")],
};

// Computer use (PLX-897), by what the agent is doing or did and in which app, such as "Clicked in
// Notes", and what it typed, pressed, or set.
const computerTools = `${plxdTools}computer_`;
const computerLabels: Partial<Record<string, readonly [doing: string, done: string]>> = {
  list_apps: [msg("Listing apps"), msg("Listed apps")],
  get_app_state: [msg("Looking at {{app}}"), msg("Looked at {{app}}")],
  click: [msg("Clicking in {{app}}"), msg("Clicked in {{app}}")],
  perform_secondary_action: [msg("Using a control in {{app}}"), msg("Used a control in {{app}}")],
  scroll: [msg("Scrolling {{app}}"), msg("Scrolled {{app}}")],
  drag: [msg("Dragging in {{app}}"), msg("Dragged in {{app}}")],
  type_text: [msg("Typing in {{app}}"), msg("Typed in {{app}}")],
  press_key: [msg("Pressing a key in {{app}}"), msg("Pressed a key in {{app}}")],
  set_value: [msg("Setting a value in {{app}}"), msg("Set a value in {{app}}")],
};

function computerCall(item: Extract<Item, { kind: "tool" }>, doing: boolean) {
  const tool = item.name?.startsWith(computerTools) ? item.name.slice(computerTools.length) : "";
  const labels = computerLabels[tool];
  if (!labels) return undefined;
  const app = toolHint(item.input, ["app"]) || t("an app");
  return {
    label: t(labels[doing ? 0 : 1], { app }),
    detail: toolHint(item.input, ["text", "key", "action", "value"]),
  };
}

/** A plxd tool's words for what it's doing and what it did, when this app knows the tool. */
const plxdLabel = (name: string | null) =>
  name?.startsWith(plxdTools) ? plxdLabels[name.slice(plxdTools.length)] : undefined;

/**
 * A plxd tool call as a short line: what it did, or is `doing`, and what to (the new thread's or
 * task's title or prompt, the secret, the file, the search, or the page). Undefined for any other
 * tool.
 */
function plxdCall(item: Extract<Item, { kind: "tool" }>, doing = false) {
  const computer = computerCall(item, doing);
  if (computer) return computer;
  const labels = plxdLabel(item.name);
  return labels
    ? {
        label: t(labels[doing ? 0 : 1]),
        detail:
          item.subagent ??
          toolHint(item.input, ["title", "prompt", "task", "label", "path", "query", "url"]),
      }
    : undefined;
}

/**
 * An MCP server's tool as Claude Code names it, `mcp__<server>__<tool>`, readably: the server's
 * name, capitalized, or Parallax for plxd's, and the tool's. Undefined for any other tool.
 */
export function mcpTool(name: string | null) {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name ?? "") ?? [];
  if (!server || !tool) return undefined;
  const words = server.replace(/[_-]/g, " ");
  return {
    server: server === "plxd" ? "Parallax" : words.charAt(0).toUpperCase() + words.slice(1),
    tool: tool.replaceAll("_", " "),
  };
}

/** The skill a Skill call runs: `skill`, or `command` from older Claude Code versions. */
export const skillName = (input?: JsonValue) => toolHint(input, ["skill", "command"]);

export function inputText(input: JsonValue): string {
  if (isObject(input) && input["truncated"] === true) {
    const bytes = typeof input["bytes"] === "number" ? input["bytes"] : 0;
    return t("Too large to show ({{size}} KB)", { size: Math.ceil(bytes / 1024) });
  }
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}
