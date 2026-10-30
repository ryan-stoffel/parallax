// What a thread's steps say, as the desktop's transcript (AgentChat.tsx) and the mobile app word
// them: each tool call's line, what the agent is doing now, and a run of steps summed up, with the
// kind of work each is, whose icon each app draws itself. Pure, so both apps share it.

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
  Bash: "Running",
  Read: "Reading",
  Grep: "Searching",
  Glob: "Searching",
  WebSearch: "Searching",
  WebFetch: "Fetching",
  Edit: "Editing",
  MultiEdit: "Editing",
  Write: "Writing",
  Task: "Running agent",
  Agent: "Running agent",
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
      return { label: "Thinking" };
    case "tool": {
      const plxd = plxdCall(item, true);
      if (plxd) return plxd;
      // Including a plxd tool this app doesn't know.
      const mcp = mcpTool(item.name);
      if (mcp) return { label: `Using ${mcp.server}`, detail: mcp.tool };
      if (item.name === "Skill") return { label: "Using skill", detail: skillName(item.input) };
      return {
        label: verbs[item.name ?? ""] ?? item.name ?? "Working",
        detail: toolHint(item.input),
      };
    }
    case "todo":
      return { label: "Planning" };
    default:
      return { label: "Working" };
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
  const about = (verb: string, what: string, fallback: string) =>
    what ? `${verb} ${what}` : fallback;
  switch (item.name) {
    case "Bash":
      return toolHint(input, ["command"]) || "Ran a command";
    case "Read":
    case "NotebookRead":
      return about("Read", path, "Read a file");
    case "LS":
      return about("Listed", path, "Listed a folder");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return about("Edited", path, "Edited a file");
    case "Write":
      return about("Wrote", path, "Wrote a file");
    case "Grep": {
      const pattern = toolHint(input, ["pattern"]);
      return pattern ? `Searched ${pattern}${path ? ` in ${path}` : ""}` : "Searched code";
    }
    case "Glob":
      return about("Searched files", toolHint(input, ["pattern"]), "Searched files");
    case "WebSearch":
      return about("Searched the web for", toolHint(input, ["query"]), "Searched the web");
    case "WebFetch":
      return about("Fetched", toolHint(input, ["url"]), "Fetched a page");
    case "Skill":
      return about("Used skill", skillName(input), "Used a skill");
    case "Task":
    case "Agent":
      return about("Ran agent", toolHint(input, ["description"]), "Ran an agent");
  }
  const hint = toolHint(input);
  const name = item.name ?? "Tool";
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
    return { label: n === 1 ? "Thought" : `Thought ${n} times`, kind: "thinking", failures };
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
  const said = [...plxd].map(([label, n]) => (n > 1 ? `${label} ${times(n)}` : label));
  if (said.length > 2 && !servers.includes("Parallax")) servers.push("Parallax");
  parts.unshift(
    ...(servers.length > 0 ? [`Used ${list.format(servers)}`] : []),
    ...(said.length > 2 ? [] : said),
  );
  const others =
    calls.length -
    calls.filter((c) => c.kind === "tool" && ["mcp", "plxd"].includes(toolKind(c.name))).length -
    ranked.reduce((n, { count }) => n + count.calls, 0);
  if (others > 0) parts.push(`performed ${others} other ${others === 1 ? "action" : "actions"}`);
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** A kind of call in a summary, by how many there were and how many files they changed. */
function callLabel(group: string, calls: number, files: number): string {
  switch (group) {
    case "shell":
      return `Ran ${plural(calls, "command", "commands")}`;
    case "editing":
    case "writing":
      return `Changed ${plural(files, "file", "files")}`;
    case "reading":
      return `Read ${plural(calls, "file", "files")}`;
    case "searching":
      return `Searched code ${times(calls)}`;
    case "web":
      return `Searched the web ${times(calls)}`;
    case "fetching":
      return `Fetched ${plural(calls, "page", "pages")}`;
    case "agent":
      return `Ran ${plural(calls, "agent", "agents")}`;
    case "skill":
      return `Used ${plural(calls, "skill", "skills")}`;
    case "computer":
      return `Used apps ${times(calls)}`;
    case "planning":
      return "Updated the plan";
    default:
      return `Used ${plural(calls, "tool", "tools")}`;
  }
}

/**
 * Joins English parts: "a", "a and b", or "a, b, and c", as `Intl.ListFormat` does, which the
 * mobile app's Hermes lacks.
 */
const list = {
  format: (parts: string[]) =>
    parts.length < 3
      ? parts.join(" and ")
      : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`,
};

// A thread's plxd tools (0041), by what they're doing and what they did (PLX-843), then the 0019
// orchestrator tools older transcripts hold.
const plxdLabels: Partial<Record<string, readonly [doing: string, done: string]>> = {
  thread_launch: ["Starting a child thread", "Started a child thread"],
  thread_fork: ["Forking a thread", "Forked a thread"],
  thread_list: ["Listing threads", "Listed threads"],
  thread_read: ["Reading a thread", "Read a thread"],
  thread_search: ["Searching threads", "Searched threads"],
  thread_send: ["Messaging a thread", "Messaged a thread"],
  thread_wait: ["Waiting on a thread", "Waited on a thread"],
  thread_interrupt: ["Interrupting a thread", "Interrupted a thread"],
  thread_update: ["Updating a thread", "Updated a thread"],
  thread_merge_back: ["Merging a thread back", "Merged a thread back"],
  create_threads: ["Creating threads", "Created threads"],
  orchestrator_capabilities: [
    "Checking orchestration capabilities",
    "Checked orchestration capabilities",
  ],
  delegate_task: ["Delegating a task", "Delegated a task"],
  task_status: ["Checking on a task", "Checked on a task"],
  task_cancel: ["Cancelling a task", "Cancelled a task"],
  schedule_task: ["Scheduling a task", "Scheduled a task"],
  list_scheduled_tasks: ["Listing scheduled tasks", "Listed scheduled tasks"],
  update_scheduled_task: ["Updating a scheduled task", "Updated a scheduled task"],
  delete_scheduled_task: ["Deleting a scheduled task", "Deleted a scheduled task"],
  run_scheduled_task_now: ["Running a scheduled task", "Ran a scheduled task"],
  request_secret: ["Asking you for a secret", "Asked you for a secret"],
  present_files: ["Presenting files", "Presented files"],
  html_render: ["Rendering a page", "Rendered a page"],
  html_preview: ["Previewing a page", "Previewed a page"],
  pr_link: ["Linking a pull request", "Linked a pull request"],
  pr_unlink: ["Unlinking a pull request", "Unlinked a pull request"],
  link_pull_request: ["Linking a pull request", "Linked a pull request"],
  unlink_pull_request: ["Unlinking a pull request", "Unlinked a pull request"],
  list_thread_pull_requests: ["Listing pull requests", "Listed pull requests"],
  watch_pull_request: ["Watching a pull request", "Watched a pull request"],
  unwatch_pull_request: ["Unwatching a pull request", "Unwatched a pull request"],
  memory_read: ["Reading memory", "Read memory"],
  memory_propose: ["Proposing a memory", "Proposed a memory"],
  memory_write: ["Writing memory", "Wrote memory"],
  device_list: ["Listing devices", "Listed devices"],
  device_open: ["Opening a device", "Opened a device"],
  device_screenshot: ["Taking a device screenshot", "Took a device screenshot"],
  device_close: ["Closing a device", "Closed a device"],
  preview_open: ["Opening a preview", "Opened a preview"],
  preview_list: ["Listing previews", "Listed previews"],
  preview_status: ["Checking the preview", "Checked the preview"],
  preview_close: ["Closing the preview", "Closed the preview"],
  preview_navigate: ["Navigating the preview", "Navigated the preview"],
  preview_snapshot: ["Reading the page", "Read the page"],
  preview_click: ["Clicking in the preview", "Clicked in the preview"],
  preview_hover: ["Hovering in the preview", "Hovered in the preview"],
  preview_drag: ["Dragging in the preview", "Dragged in the preview"],
  preview_type: ["Typing in the preview", "Typed in the preview"],
  preview_press: ["Pressing a key", "Pressed a key"],
  preview_select: ["Choosing an option", "Chose an option"],
  preview_scroll: ["Scrolling the preview", "Scrolled the preview"],
  preview_resize: ["Resizing the preview", "Resized the preview"],
  preview_upload: ["Uploading a file", "Uploaded a file"],
  preview_dialog: ["Answering a dialog", "Answered a dialog"],
  preview_evaluate: ["Running a script in the preview", "Ran a script in the preview"],
  preview_wait_for: ["Waiting on the page", "Waited on the page"],
  preview_set_appearance: ["Setting the preview's appearance", "Set the preview's appearance"],
  preview_recording_start: ["Recording the preview", "Started a recording"],
  preview_recording_stop: ["Stopping the recording", "Stopped the recording"],
  ask: ["Asking the orchestrator", "Asked the orchestrator"],
  answer: ["Answering a question", "Answered a question"],
  escalate: ["Passing a question to you", "Passed a question to you"],
  land: ["Queuing a thread to land", "Queued a thread to land"],
  checks_propose: ["Proposing checks", "Proposed checks"],
  read_context: ["Reading shared context", "Read shared context"],
  write_context: ["Writing shared context", "Wrote shared context"],
  spawn_agent: ["Starting a subagent", "Started a subagent"],
  list_agents: ["Listing subagents", "Listed subagents"],
  agent_status: ["Checking on a subagent", "Checked on a subagent"],
  message_agent: ["Messaging a subagent", "Messaged a subagent"],
  cancel_agent: ["Stopping a subagent", "Stopped a subagent"],
  agent_diff: ["Reading a subagent's diff", "Read a subagent's diff"],
};

// Computer use (PLX-897), by what the agent is doing or did and in which app, such as "Clicked in
// Notes", and what it typed, pressed, or set.
const computerTools = `${plxdTools}computer_`;
const computerLabels: Partial<Record<string, readonly [doing: string, done: string]>> = {
  list_apps: ["Listing apps", "Listed apps"],
  get_app_state: ["Looking at", "Looked at"],
  click: ["Clicking in", "Clicked in"],
  perform_secondary_action: ["Using a control in", "Used a control in"],
  scroll: ["Scrolling", "Scrolled"],
  drag: ["Dragging in", "Dragged in"],
  type_text: ["Typing in", "Typed in"],
  press_key: ["Pressing a key in", "Pressed a key in"],
  set_value: ["Setting a value in", "Set a value in"],
};

function computerCall(item: Extract<Item, { kind: "tool" }>, doing: boolean) {
  const tool = item.name?.startsWith(computerTools) ? item.name.slice(computerTools.length) : "";
  const labels = computerLabels[tool];
  if (!labels) return undefined;
  const verb = labels[doing ? 0 : 1];
  const app = toolHint(item.input, ["app"]);
  return {
    label: tool === "list_apps" ? verb : `${verb} ${app || "an app"}`,
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
        label: labels[doing ? 0 : 1],
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
    return `Too large to show (${Math.ceil(bytes / 1024)} KB)`;
  }
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}
