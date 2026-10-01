import {
  Ban,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleX,
  Copy,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  ListChecks,
  Plug,
  Scissors,
  Search,
  Sparkles,
  SquareTerminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";

import type { JsonValue } from "../protocol/generated/protocol";
import { diffLines, diffStats, lines, type DiffLine } from "./diff";
import { Loader, type LoaderStyle } from "./Loader";
import { wispdTools, type Item } from "./transcript";

// What the agent does, as the transcript shows it: the working line's label and loader for each
// kind of work (RYA-215), and an opened work group as a timeline of cards, each opening on a view
// made for its kind of tool (RYA-219).

type Tool = Extract<Item, { kind: "tool" }>;

/** The loader for each kind of work. */
export const loaders = {
  thinking: { kind: "matrix", variant: "ripple" },
  shell: { kind: "register", variant: "shift" },
  reading: { kind: "bands", variant: "descend" },
  searching: { kind: "matrix", variant: "scan" },
  editing: { kind: "cells", variant: "merge" },
  fetching: { kind: "beacon", variant: "rise" },
  agent: { kind: "orbit", variant: "oppose" },
  skill: { kind: "lift", variant: "rise" },
  mcp: { kind: "beacon", variant: "balance" },
  wispd: { kind: "cells", variant: "spread" },
  planning: { kind: "lift", variant: "breathe" },
  working: { kind: "orbit", variant: "chase" },
} as const satisfies Record<string, LoaderStyle>;

// Each kind of tool: its icon in the timeline, and its loader while it runs.
const kinds = {
  shell: { icon: SquareTerminal, loader: loaders.shell },
  read: { icon: FileText, loader: loaders.reading },
  search: { icon: Search, loader: loaders.searching },
  webSearch: { icon: Globe, loader: loaders.searching },
  fetch: { icon: Globe, loader: loaders.fetching },
  edit: { icon: FilePen, loader: loaders.editing },
  write: { icon: FilePlus2, loader: loaders.editing },
  agent: { icon: Bot, loader: loaders.agent },
  skill: { icon: Sparkles, loader: loaders.skill },
  mcp: { icon: Plug, loader: loaders.mcp },
  wispd: { icon: Workflow, loader: loaders.wispd },
  plan: { icon: ListChecks, loader: loaders.planning },
  other: { icon: Wrench, loader: loaders.working },
} satisfies Record<string, { icon: LucideIcon; loader: LoaderStyle }>;
type Kind = keyof typeof kinds;

// The kind of each tool, by the names Claude Code's and Codex's tools use.
const toolKinds: Partial<Record<string, Kind>> = {
  Bash: "shell",
  command_execution: "shell",
  Read: "read",
  NotebookRead: "read",
  LS: "read",
  Grep: "search",
  Glob: "search",
  ToolSearch: "search",
  WebSearch: "webSearch",
  web_search: "webSearch",
  WebFetch: "fetch",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  file_change: "edit",
  Write: "write",
  Task: "agent",
  Agent: "agent",
  Skill: "skill",
  TodoWrite: "plan",
};

function kindOf(item: Tool): Kind {
  if (item.name?.startsWith(wispdTools)) return "wispd";
  if (mcpTool(item.name)) return "mcp";
  return toolKinds[item.name ?? ""] ?? "other";
}

// What a tool is doing, in a word, by the names common tools use.
const verbs: Partial<Record<string, string>> = {
  Bash: "Running",
  command_execution: "Running",
  Read: "Reading",
  Grep: "Searching",
  Glob: "Searching",
  WebSearch: "Searching",
  web_search: "Searching",
  WebFetch: "Fetching",
  Edit: "Editing",
  MultiEdit: "Editing",
  file_change: "Editing",
  Write: "Writing",
  Task: "Running agent",
  Agent: "Running agent",
};

/** What the agent is doing: a label, what it's doing it to, and the loader drawn beside them. */
export interface Activity {
  label: string;
  detail?: string;
  loader: LoaderStyle;
}

/** The header of the work in progress: what its latest item is doing. */
export function activity(item?: Item): Activity {
  switch (item?.kind) {
    case "reasoning":
      return { label: "Thinking", loader: loaders.thinking };
    case "tool": {
      const wispd = wispdCall(item);
      if (wispd) return { ...wispd, loader: loaders.wispd };
      // Including a wispd tool this app doesn't know.
      const mcp = mcpTool(item.name);
      if (mcp)
        return {
          label: `Using ${mcp.server}`,
          detail: mcp.tool,
          loader: kinds[kindOf(item)].loader,
        };
      if (item.name === "Skill")
        return { label: "Using skill", detail: skillName(item.input), loader: loaders.skill };
      return {
        label: verbs[item.name ?? ""] ?? item.name ?? "Working",
        detail: toolHint(item.input),
        loader: kinds[kindOf(item)].loader,
      };
    }
    case "todo":
      return { label: "Planning", loader: loaders.planning };
    default:
      return { label: "Working", loader: loaders.working };
  }
}

// The input field that says what a call does, by the names common tools use.
const hintFields = ["command", "file_path", "path", "pattern", "url", "query", "description"];

function toolHint(input?: JsonValue, fields = hintFields): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const value = fields.map((f) => input[f]).find((v) => typeof v === "string");
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

// A coordinator's wispd tools (0019), by what they did.
const wispdLabels: Partial<Record<string, string>> = {
  spawn_agent: "Started a subagent",
  list_agents: "Listed subagents",
  agent_status: "Checked on a subagent",
  message_agent: "Messaged a subagent",
  cancel_agent: "Stopped a subagent",
  agent_diff: "Read a subagent's diff",
  read_context: "Read shared context",
  write_context: "Wrote shared context",
};

/**
 * A wispd tool call as a short line: what it did, and what it did it to (the new subagent's task,
 * the subagent it named, or the context file). Undefined for any other tool.
 */
function wispdCall(item: Tool) {
  const label = item.name?.startsWith(wispdTools)
    ? wispdLabels[item.name.slice(wispdTools.length)]
    : undefined;
  return label
    ? { label, detail: item.subagent ?? toolHint(item.input, ["prompt", "path"]) }
    : undefined;
}

/**
 * An MCP server's tool as Claude Code names it, `mcp__<server>__<tool>`, readably: the server's
 * name, capitalized unless it's wispd's, and the tool's. Undefined for any other tool.
 */
function mcpTool(name: string | null) {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name ?? "") ?? [];
  if (!server || !tool) return undefined;
  const words = server.replace(/[_-]/g, " ");
  return {
    server: server === "wispd" ? server : words.charAt(0).toUpperCase() + words.slice(1),
    tool: tool.replaceAll("_", " "),
  };
}

/** The skill a Skill call runs: `skill`, or `command` from older Claude Code versions. */
const skillName = (input?: JsonValue) => toolHint(input, ["skill", "command"]);

function inputText(input: JsonValue): string {
  if (input && typeof input === "object" && !Array.isArray(input) && input["truncated"] === true) {
    const bytes = typeof input["bytes"] === "number" ? input["bytes"] : 0;
    return `Too large to show (${Math.ceil(bytes / 1024)} KB)`;
  }
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

// --- The timeline ---

/** Which long outputs show in full, kept by the transcript since rows unmount off screen. */
const Expansion = createContext<
  { openKeys: ReadonlySet<string>; onToggle: (key: string, open: boolean) => void } | undefined
>(undefined);

/** Whether `key` is open: the transcript's, or kept here for a card on its own. */
function useOpen(key: string): [boolean, (open: boolean) => void] {
  const shared = useContext(Expansion);
  const [open, setOpen] = useState(false);
  return shared
    ? [shared.openKeys.has(key), (next) => shared.onToggle(key, next)]
    : [open, setOpen];
}

// Where each kind of entry has its node, from its top, in px: the middle of its header.
const nodeY = { tool: 21, row: 20 };
// The space between a run of tool calls and what's around it, in px.
const entryGap = 10;

/**
 * An opened work group: a rail with a node per item, thinking as a quiet row, and each run of
 * tool calls stacked in one rounded card. Checklists and notices are `renderItem`'s.
 */
export function Timeline({
  items,
  live,
  active,
  openKeys,
  onToggle,
  renderItem,
}: {
  items: Item[];
  /** Whether the run is going, so a tool call with no result is still in progress. */
  live: boolean;
  /** Whether this is the work in progress, so its last item is what the agent is doing now. */
  active: boolean;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
  renderItem: (item: Item) => ReactNode;
}) {
  // A TodoWrite call is told by the checklist that follows it.
  const shown = items.filter(
    (item, i) =>
      !(item.kind === "tool" && item.name === "TodoWrite" && items[i + 1]?.kind === "todo"),
  );
  const expansion = useMemo(() => ({ openKeys, onToggle }), [openKeys, onToggle]);
  return (
    <Expansion.Provider value={expansion}>
      <ol aria-label="Activity">
        {shown.map((item, i) => {
          const tool = item.kind === "tool";
          // Tool calls in a row share a card: the first rounds its top, the last its bottom.
          const top = !tool || shown[i - 1]?.kind !== "tool";
          const bottom = !tool || shown[i + 1]?.kind !== "tool";
          const gap = i > 0 && top ? entryGap : 0;
          const now = active && live && i === shown.length - 1;
          return (
            <li key={item.key} className="flex" style={gap ? { marginTop: gap } : undefined}>
              <Rail
                node={tool ? toolState(item, live) : now ? "running" : "ok"}
                y={tool ? nodeY.tool : nodeY.row}
                gap={gap}
                first={i === 0}
                last={i === shown.length - 1}
              />
              {tool ? (
                <div
                  className={`min-w-0 flex-1 overflow-hidden border-x border-t border-border bg-surface ${top ? "rounded-t-xl" : ""} ${bottom ? "rounded-b-xl border-b" : ""}`}
                >
                  <ToolRow
                    item={item}
                    live={live}
                    open={openKeys.has(item.key)}
                    onToggle={onToggle}
                  />
                </div>
              ) : item.kind === "reasoning" ? (
                <div className="min-w-0 flex-1">
                  <ThinkingRow item={item} open={openKeys.has(item.key)} onToggle={onToggle} />
                </div>
              ) : (
                <div className="min-w-0 flex-1 py-2.5 pl-3">{renderItem(item)}</div>
              )}
            </li>
          );
        })}
      </ol>
    </Expansion.Provider>
  );
}

type State = "running" | "ok" | "error" | "denied" | "none";

const toolState = (item: Tool, live: boolean): State => item.status ?? (live ? "running" : "none");

// Each node by its item's state: the accent while it runs, danger once it failed.
const nodes: Record<State, string> = {
  running: "activity-pulse bg-accent",
  ok: "bg-muted-foreground/45",
  error: "bg-danger",
  denied: "bg-danger",
  none: "border border-faint-foreground bg-background",
};

/** The rail beside an entry: its node at `y`, joined to the entries above and below. */
function Rail({
  node,
  y,
  gap,
  first,
  last,
}: {
  node: State;
  y: number;
  gap: number;
  first: boolean;
  last: boolean;
}) {
  const line = "absolute left-[7px] w-px bg-border";
  return (
    <span aria-hidden className="relative w-6 shrink-0">
      {!first && <span className={line} style={{ top: -gap, height: y + gap }} />}
      {!last && <span className={`${line} bottom-0`} style={{ top: y }} />}
      <span
        className={`absolute left-1 size-[7px] rounded-full ${nodes[node]}`}
        style={{ top: y - 3.5 }}
      />
    </span>
  );
}

interface RowProps<T> {
  item: T;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
}

/** A tool call on its own, as a card, outside a work group. */
export function ToolCall(props: RowProps<Tool> & { live: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <ToolRow {...props} />
    </div>
  );
}

/** A disclosure's header: a row-wide button with a chevron that turns when it opens. */
function Toggle({
  open,
  onToggle,
  controls,
  className,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className={`group/toggle flex w-full cursor-default items-center gap-2.5 px-3 text-left text-[13px] ${className}`}
    >
      {children}
      <ChevronRight
        aria-hidden
        className={`size-3.5 shrink-0 text-faint-foreground transition-[rotate,opacity] motion-reduce:transition-none ${open ? "rotate-90" : "opacity-50 group-hover/toggle:opacity-100"}`}
      />
    </button>
  );
}

/** Thinking, as a quiet row: the start of the thought, opening on all of it. */
export function ThinkingRow({
  item,
  open,
  onToggle,
}: RowProps<Extract<Item, { kind: "reasoning" }>>) {
  const body = useId();
  const preview = item.text.trim().split("\n")[0];
  return (
    <>
      <Toggle
        open={open}
        onToggle={() => onToggle(item.key, !open)}
        controls={body}
        className="h-10 rounded-lg hover:bg-hover"
      >
        <span aria-hidden className="grid size-6 shrink-0 place-items-center text-faint-foreground">
          <Brain className="size-3.5" />
        </span>
        <span className="shrink-0 text-muted-foreground">Thinking</span>{" "}
        <span className="min-w-0 flex-1 truncate text-faint-foreground">{!open && preview}</span>
      </Toggle>
      {open && (
        <div id={body} className="activity-in pr-3 pb-2 pl-[46px]">
          <BoundedText
            id={`${item.key}:text`}
            text={item.text}
            fade="from-background"
            className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
          />
        </div>
      )}
    </>
  );
}

/** A tool call's row: its icon, what it did to what, and at the right edge how long and how it went. */
function ToolRow({ item, live, open, onToggle }: RowProps<Tool> & { live: boolean }) {
  const body = useId();
  const state = toolState(item, live);
  const kind = kindOf(item);
  const edits = useMemo(() => editsOf(item), [item]);
  const title = titleOf(item, state === "running", edits);
  const took = state === "running" ? undefined : duration(item.at, item.endedAt);
  const Icon = kinds[kind].icon;
  return (
    <>
      <Toggle
        open={open}
        onToggle={() => onToggle(item.key, !open)}
        controls={body}
        className="h-10 hover:bg-hover"
      >
        <span
          aria-hidden
          className={`grid size-6 shrink-0 place-items-center rounded-md border ${tiles[state]}`}
        >
          <Icon className="size-3.5" />
        </span>
        {/* Spaced, so its text and name read as words; flex layout ignores the spaces. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-muted-foreground">{title.verb}</span>{" "}
          {title.target && (
            <span
              title={title.full ?? title.target}
              className={`min-w-0 truncate text-foreground ${title.code ? "font-mono text-[12px]" : ""}`}
            >
              {title.target}
            </span>
          )}{" "}
          {title.badge && (
            <span className="shrink-0 self-center rounded-full border border-border px-1.5 text-[10.5px] leading-4 font-medium text-muted-foreground">
              {title.badge}
            </span>
          )}{" "}
          {title.note && (
            <span className="shrink-0 text-[11.5px] text-faint-foreground">{title.note}</span>
          )}
        </span>{" "}
        {took && (
          <span className="shrink-0 text-[11.5px] text-faint-foreground tabular-nums">{took}</span>
        )}{" "}
        <Status state={state} loader={kinds[kind].loader} />
      </Toggle>
      {open && (
        <div id={body} className="activity-in space-y-2.5 px-3 pt-0.5 pb-3">
          <ToolBody item={item} kind={kind} edits={edits} />
        </div>
      )}
    </>
  );
}

// Each icon tile by its call's state: the accent while it runs, danger once it failed.
const tiles: Record<State, string> = {
  running: "border-accent/30 bg-accent/10 text-accent",
  ok: "border-border bg-selected text-muted-foreground",
  error: "border-danger/25 bg-danger/10 text-danger",
  denied: "border-danger/25 bg-danger/10 text-danger",
  none: "border-border bg-selected text-faint-foreground",
};

/** How a call went, at a row's right edge, said in words to screen readers. */
function Status({ state, loader }: { state: State; loader: LoaderStyle }) {
  const said = (text: string) => <span className="sr-only">{text}</span>;
  switch (state) {
    case "running":
      return (
        <span className="shrink-0">
          <Loader {...loader} size={14} />
          {said("Running")}
        </span>
      );
    case "ok":
      return (
        <span className="shrink-0 text-muted-foreground">
          <Check aria-hidden className="size-3.5" />
          {said("Succeeded")}
        </span>
      );
    case "error":
    case "denied":
      return (
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-danger">
          {state === "error" ? (
            <CircleX aria-hidden className="size-3.5" />
          ) : (
            <Ban aria-hidden className="size-3.5" />
          )}
          {state === "error" ? "Failed" : "Denied"}
        </span>
      );
    default:
      return (
        <span className="shrink-0 text-faint-foreground">
          <CircleDashed aria-hidden className="size-3.5" />
          {said("No result")}
        </span>
      );
  }
}

/** How long a call took, from its start to its result: "0.4s", "12s", "1m 5s". */
export function duration(from?: string, to?: string): string | undefined {
  const ms = Date.parse(to ?? "") - Date.parse(from ?? "");
  if (!(ms > 0)) return undefined;
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return s < 3600
    ? `${Math.floor(s / 60)}m ${s % 60}s`
    : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// --- Titles ---

/** A call's title: what it did (or is doing), to what, and a short note after. */
interface Title {
  verb: string;
  target?: string;
  /** Whether the target is code, a command or a pattern, set in monospace. */
  code?: boolean;
  /** The target in full, shown on hover, such as a file's whole path. */
  full?: string;
  note?: ReactNode;
  /** An MCP server's name. */
  badge?: string;
}

function titleOf(item: Tool, running: boolean, edits?: DiffLine[][]): Title {
  const input = fieldsOf(item.input);
  const said = (now: string, then: string) => (running ? now : then);
  const wispd = wispdCall(item);
  if (wispd) return { verb: wispd.label, target: wispd.detail || undefined };
  const mcp = mcpTool(item.name);
  if (mcp)
    return {
      verb: mcp.tool.charAt(0).toUpperCase() + mcp.tool.slice(1),
      target: firstValue(input),
      badge: mcp.server,
    };
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  const file = path ? { target: basename(path), full: path } : {};
  switch (item.name) {
    case "Bash":
    case "command_execution": {
      const command = unwrap(text(input.command) ?? "");
      return {
        verb: said("Running", "Ran"),
        target: shortCommand(command),
        code: true,
        full: command,
      };
    }
    case "Read":
    case "NotebookRead":
      return { verb: said("Reading", "Read"), ...file, note: readRange(item) };
    case "LS":
      return { verb: said("Listing", "Listed"), ...file };
    case "Grep":
    case "Glob":
    case "ToolSearch": {
      const pattern = text(input.pattern) ?? text(input.query);
      return {
        verb: said("Searching", "Searched"),
        target: pattern,
        code: item.name !== "ToolSearch",
        full: pattern && path ? `${pattern} in ${path}` : pattern,
        note: matchCount(item),
      };
    }
    case "WebSearch":
    case "web_search":
      return { verb: said("Searching the web", "Searched the web"), target: text(input.query) };
    case "WebFetch": {
      const url = text(input.url);
      return { verb: said("Fetching", "Fetched"), target: url && shortUrl(url), full: url };
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: said("Editing", "Edited"), ...file, note: edits && <Changes edits={edits} /> };
    case "file_change": {
      const changed = changesOf(input);
      const one = changed.length === 1 ? changed[0]!.path : undefined;
      return {
        verb: said("Editing", "Edited"),
        ...(one ? { target: basename(one), full: one } : { target: count(changed.length, "file") }),
      };
    }
    case "Write": {
      const content = text(input.content);
      return {
        verb: said("Writing", "Wrote"),
        ...file,
        note: content !== undefined && count(lines(content).length, "line"),
      };
    }
    case "Task":
    case "Agent":
      return { verb: said("Running agent", "Ran agent"), target: text(input.description) };
    case "Skill":
      return { verb: said("Using skill", "Used skill"), target: skillName(item.input), code: true };
    case "TodoWrite":
      return { verb: said("Updating the plan", "Updated the plan") };
  }
  return { verb: item.name ?? "Tool", target: toolHint(item.input) || undefined, code: true };
}

/** Lines added and removed, as the sidebar counts a diff's. */
function Changes({ edits }: { edits: DiffLine[][] }) {
  const { added, removed } = diffStats(edits.flat());
  return (
    <span className="font-mono tabular-nums">
      <span className="text-emerald-500">+{added}</span>{" "}
      <span className="text-danger">−{removed}</span>
    </span>
  );
}

/** An Edit's or MultiEdit's diffs, one per edit; undefined for any other call. */
function editsOf(item: Tool): DiffLine[][] | undefined {
  const input = fieldsOf(item.input);
  const edit = (e: Fields) => diffLines(text(e.old_string) ?? "", text(e.new_string) ?? "");
  if (item.name === "Edit" && "old_string" in input) return [edit(input)];
  if (item.name === "MultiEdit" && Array.isArray(input.edits))
    return input.edits.map((e) => edit(fieldsOf(e)));
  return undefined;
}

/** The lines a Read covered: from its output's line numbers, or else from its input. */
function readRange(item: Tool): string | undefined {
  const numbered = item.status === "ok" ? numberedLines(item.output) : undefined;
  if (numbered?.length) {
    const [first, last] = [numbered[0]!.n, numbered.at(-1)!.n];
    return first === last ? `line ${first}` : `lines ${first}–${last}`;
  }
  const input = fieldsOf(item.input);
  const offset = typeof input.offset === "number" ? input.offset : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  if (offset && limit) return `lines ${offset}–${offset + limit - 1}`;
  if (offset) return `from line ${offset}`;
  if (limit) return `lines 1–${limit}`;
  return undefined;
}

/** How many files or lines a search found, from its output. */
function matchCount(item: Tool): string | undefined {
  const output = cleanOutput(item.output).trim();
  if (item.status !== "ok" || !output) return undefined;
  if (/^No (files|matches) found/i.test(output)) return "no matches";
  const found = /^Found (\d+) (file|match)/i.exec(output);
  if (found) return count(Number(found[1]), found[2]!.toLowerCase());
  const n = output
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("(Results are truncated")).length;
  const files = item.name === "Glob" || fieldsOf(item.input).output_mode === "files_with_matches";
  return count(n, files ? "file" : "line");
}

// --- Bodies ---

/** What a call's card opens on, by its kind: never raw JSON, except for a tool this app doesn't know. */
function ToolBody({ item, kind, edits }: { item: Tool; kind: Kind; edits?: DiffLine[][] }) {
  const input = fieldsOf(item.input);
  if (input.truncated === true || item.input === undefined || item.input === null)
    return <RawBody item={item} />;
  let body: ReactNode;
  switch (kind) {
    case "shell":
      body = <ShellBody item={item} input={input} />;
      break;
    case "read":
      body = <ReadBody item={item} input={input} />;
      break;
    case "search":
      body = <SearchBody item={item} input={input} />;
      break;
    case "webSearch":
    case "fetch":
      body = <WebBody item={item} input={input} />;
      break;
    case "edit":
    case "write":
      body = <FileBody item={item} input={input} edits={edits} />;
      break;
    case "agent":
      body = <AgentBody item={item} input={input} />;
      break;
    case "mcp":
    case "wispd":
      body = <CallBody item={item} input={input} />;
      break;
    case "skill": {
      // Its title names the skill already.
      const { skill: _, command: __, ...rest } = input;
      body = <CallBody item={item} input={rest} />;
      break;
    }
    default:
      return <RawBody item={item} />;
  }
  // A denial's output says why, and so does a failure's where the body shows only success.
  const why = cleanOutput(item.output);
  const noted =
    item.status === "denied" || (item.status === "error" && !showsErrors.includes(kind));
  return (
    <>
      {body}
      {noted && why && <Note>{why}</Note>}
    </>
  );
}

// The kinds whose bodies show a failure's output themselves.
const showsErrors: Kind[] = ["shell", "mcp", "wispd", "skill"];

/** A shell command, as in a terminal: the prompt, the command, and what it printed. */
function ShellBody({ item, input }: { item: Tool; input: Fields }) {
  const command = unwrap(text(input.command) ?? "");
  const shown = item.status === "denied" ? "" : cleanOutput(item.output);
  // Claude Code starts a failed command's output with its exit code.
  const [, exit, rest = shown] = /^Exit code (\d+)\n?([\s\S]*)$/.exec(shown) ?? [];
  return (
    <Inset
      bar={
        <>
          <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{text(input.description) ?? "Shell"}</span>
          {exit && <span className="shrink-0 text-danger">Exit code {exit}</span>}
          <CopyButton text={command} label="Copy command" />
        </>
      }
    >
      <pre className={`${code} px-3 pt-2.5 ${rest ? "pb-1" : "pb-2.5"} text-foreground`}>
        <span aria-hidden className="text-faint-foreground select-none">
          ${" "}
        </span>
        {command}
      </pre>
      {rest && <OutputText id={`${item.key}:output`} output={rest} className="px-3 pt-1 pb-2.5" />}
    </Inset>
  );
}

/** A Read: the file and the lines it covered, then those lines. */
function ReadBody({ item, input }: { item: Tool; input: Fields }) {
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path) ?? "";
  const output = item.status === "ok" ? cleanOutput(item.output) : "";
  const numbered = numberedLines(output);
  return (
    <Inset bar={<PathBar icon={FileText} path={path} note={readRange(item) ?? "whole file"} />}>
      {numbered?.length ? (
        <NumberedCode id={`${item.key}:output`} lines={numbered} />
      ) : (
        output && <OutputText id={`${item.key}:output`} output={output} className="px-3 py-2.5" />
      )}
    </Inset>
  );
}

/** A search: its pattern and where, then what it found, by paths relative to where it looked. */
function SearchBody({ item, input }: { item: Tool; input: Fields }) {
  const path = text(input.path);
  const scope = [path, text(input.glob), text(input.type)].filter(Boolean);
  const found = item.status === "ok" ? cleanOutput(item.output) : "";
  const listed = found
    .replace(/^Found \d+ (files?|match(es)?)[^\n]*\n?/i, "")
    .split("\n")
    .map((l) => (path && l.startsWith(`${path}/`) ? l.slice(path.length + 1) : l))
    .join("\n");
  return (
    <Inset
      bar={
        <>
          <Search aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono text-foreground">
            {text(input.pattern) ?? text(input.query)}
          </span>
          {scope.length > 0 && (
            <span title={path} className="min-w-0 flex-1 truncate">
              in {scope.map((s) => (s === path ? basename(s!) : s)).join(" · ")}
            </span>
          )}
          <span className="ml-auto shrink-0">{matchCount(item)}</span>
        </>
      }
    >
      {listed.trim() && (
        <OutputText id={`${item.key}:output`} output={listed.trim()} className="px-3 py-2.5" />
      )}
    </Inset>
  );
}

/** A web fetch or search: the URL or query, what was asked of it, then what came back. */
function WebBody({ item, input }: { item: Tool; input: Fields }) {
  const url = text(input.url);
  const query = text(input.query);
  const prompt = text(input.prompt);
  const output = item.status === "ok" ? cleanOutput(item.output) : "";
  const results = searchResults(output);
  return (
    <Inset
      bar={
        <>
          <Globe aria-hidden className="size-3.5 shrink-0" />
          {url ? (
            <Link url={url} className="min-w-0 flex-1 truncate font-mono" />
          ) : (
            <span className="min-w-0 flex-1 truncate text-foreground">{query}</span>
          )}
        </>
      }
    >
      {prompt && (
        <p className="border-b border-border px-3 py-2 text-[12px] text-muted-foreground">
          {prompt}
        </p>
      )}
      {results && results.links.length > 0 && (
        <ul className="space-y-1 px-3 py-2.5 text-[12.5px]">
          {results.links.map((link, i) => (
            <li key={i} className="flex min-w-0 items-baseline gap-2">
              <Link url={link.url} className="min-w-0 truncate text-foreground">
                {link.title}
              </Link>
              <span className="shrink-0 text-[11.5px] text-faint-foreground">
                {hostOf(link.url)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(results ? results.rest : output) && (
        <BoundedText
          id={`${item.key}:output`}
          text={results ? results.rest : output}
          fade="from-background"
          className={`px-3 py-2.5 font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground ${results?.links.length ? "border-t border-border" : ""}`}
        />
      )}
    </Inset>
  );
}

/** An edit's diff, each of a MultiEdit's in turn, a Write's new file, or a Codex change's files. */
function FileBody({ item, input, edits }: { item: Tool; input: Fields; edits?: DiffLine[][] }) {
  const path = text(input.file_path) ?? text(input.notebook_path) ?? "";
  if (edits) {
    const total = edits.reduce((n, e) => n + e.length, 0);
    return (
      <Inset
        bar={
          <PathBar
            icon={FilePen}
            path={path}
            note={
              <>
                {edits.length > 1 && `${edits.length} edits · `}
                <Changes edits={edits} />
              </>
            }
          />
        }
      >
        <Bounded id={`${item.key}:diff`} lines={total}>
          {(limit) => <Diff edits={edits} limit={limit} />}
        </Bounded>
      </Inset>
    );
  }
  const content = text(input.content);
  if (item.name === "Write" && content !== undefined) {
    const all = lines(content);
    return (
      <Inset bar={<PathBar icon={FilePlus2} path={path} note={count(all.length, "line")} />}>
        <NumberedCode
          id={`${item.key}:content`}
          lines={all.map((t, i) => ({ n: i + 1, text: t }))}
        />
      </Inset>
    );
  }
  const changed = changesOf(input);
  if (changed.length > 0)
    return (
      <Inset bar={<span>{count(changed.length, "file")} changed</span>}>
        <ul className="space-y-1 px-3 py-2.5 font-mono text-[12px]">
          {changed.map((c, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-14 shrink-0 text-faint-foreground">{c.kind}</span>
              <span className="min-w-0 truncate" title={c.path}>
                {c.path}
              </span>
            </li>
          ))}
        </ul>
      </Inset>
    );
  return <Arguments input={input} />;
}

/** A subagent's task: its description and prompt, then its answer. */
function AgentBody({ item, input }: { item: Tool; input: Fields }) {
  const type = text(input.subagent_type);
  const prompt = text(input.prompt);
  const answer = item.status === "ok" ? cleanOutput(item.output) : "";
  return (
    <>
      {prompt && (
        <div className="rounded-lg border border-border px-3 py-2.5">
          <p className="mb-1.5 flex items-center gap-2 text-[11.5px] text-faint-foreground">
            Prompt{" "}
            {type && (
              <span className="rounded-full border border-border px-1.5 text-[10.5px] leading-4">
                {type}
              </span>
            )}
          </p>
          <BoundedText
            id={`${item.key}:prompt`}
            text={prompt}
            fade="from-surface"
            className="font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
          />
        </div>
      )}
      {answer && (
        <Inset bar={<span>Answer</span>}>
          <BoundedText
            id={`${item.key}:output`}
            text={answer}
            fade="from-background"
            className="px-3 py-2.5 font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap"
          />
        </Inset>
      )}
    </>
  );
}

/** An MCP tool's, a wispd tool's, or a skill's call: its arguments, then its result. */
function CallBody({ item, input }: { item: Tool; input: Fields }) {
  const output = item.status === "denied" ? "" : cleanOutput(item.output);
  return (
    <>
      <Arguments input={input} />
      {output && (
        <Inset
          bar={
            <>
              <span className={`flex-1 ${item.status === "error" ? "text-danger" : ""}`}>
                {item.status === "error" ? "Error" : "Result"}
              </span>
              <CopyButton text={output} label="Copy result" />
            </>
          }
        >
          <OutputText id={`${item.key}:output`} output={pretty(output)} className="px-3 py-2.5" />
        </Inset>
      )}
    </>
  );
}

/** A tool this app doesn't know, or an input too large to keep: its input and output as they are. */
function RawBody({ item }: { item: Tool }) {
  return (
    <>
      {item.input !== undefined && (
        <Inset bar={<span>Input</span>}>
          <OutputText
            id={`${item.key}:input`}
            output={inputText(item.input)}
            className="px-3 py-2.5"
          />
        </Inset>
      )}
      {item.output !== undefined && (
        <Inset bar={<span>Output</span>}>
          <OutputText id={`${item.key}:output`} output={item.output} className="px-3 py-2.5" />
        </Inset>
      )}
    </>
  );
}

/** A call's arguments, as names and values. */
function Arguments({ input }: { input: Fields }) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2.5 text-[12px]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="truncate font-mono text-faint-foreground">{key}</dt>
          <dd
            className={`max-h-24 overflow-y-auto break-words whitespace-pre-wrap ${typeof value === "string" ? "" : "font-mono text-muted-foreground"}`}
          >
            {typeof value === "string" ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A quiet note for a failure or a denial: what went wrong, in its own words. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-danger">
      {children}
    </p>
  );
}

/** A block set into a card, for code and output, under a bar that says what it is. */
function Inset({ bar, children }: { bar: ReactNode; children?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-[11.5px] text-muted-foreground last:border-b-0">
        {bar}
      </div>
      {children}
    </div>
  );
}

/** An inset's bar for a file: its path in full, and a note at the right. */
function PathBar({ icon: Icon, path, note }: { icon: LucideIcon; path: string; note?: ReactNode }) {
  return (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span title={path} className="min-w-0 flex-1 truncate font-mono">
        {path}
      </span>
      {note && <span className="shrink-0 text-faint-foreground">{note}</span>}
    </>
  );
}

const code = "font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-words";

/** Output text, bounded, with wispd's note that it cut the rest said quietly. */
function OutputText({ id, output, className }: { id: string; output: string; className: string }) {
  const { text: shown, cut } = splitCut(output);
  return (
    <>
      <BoundedText
        id={id}
        text={shown}
        fade="from-background"
        className={`${code} text-muted-foreground ${className}`}
      />
      {cut && (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11.5px] text-faint-foreground">
          <Scissors aria-hidden className="size-3" />
          Cut short: {bytes(cut)} more wasn't sent
        </p>
      )}
    </>
  );
}

/** Lines of code with their line numbers, bounded. */
function NumberedCode({ id, lines: all }: { id: string; lines: { n: number; text: string }[] }) {
  const width = String(all.at(-1)?.n ?? 0).length;
  return (
    <Bounded id={id} lines={all.length}>
      {(limit) => (
        <div className={`${code} py-2`}>
          {all.slice(0, limit).map((line, i) => (
            <div key={i} className="flex">
              <span
                aria-hidden
                className="shrink-0 pr-3 pl-3 text-right text-faint-foreground select-none"
                style={{ width: `calc(${width}ch + 1.5rem)` }}
              >
                {line.n}
              </span>
              <span className="min-w-0 pr-3">{line.text || " "}</span>
            </div>
          ))}
        </div>
      )}
    </Bounded>
  );
}

/** Each edit's diff, one after another, bounded to `limit` lines in all. */
function Diff({ edits, limit = Infinity }: { edits: DiffLine[][]; limit?: number }) {
  let left = limit;
  return (
    <div className={`${code} py-1`}>
      {edits.map((diff, e) => {
        const shown = diff.slice(0, Math.max(0, left));
        left -= diff.length;
        if (shown.length === 0) return null;
        return (
          <div key={e}>
            {e > 0 && <div aria-hidden className="my-1 border-t border-dashed border-border" />}
            {shown.map((line, i) => (
              <div key={i} className={`flex ${diffLook[line.kind].row}`}>
                <span
                  aria-hidden
                  className={`w-7 shrink-0 text-center select-none ${diffLook[line.kind].sign}`}
                >
                  {diffLook[line.kind].mark}
                </span>
                <span className="sr-only">{diffLook[line.kind].said}</span>
                <span className="min-w-0 pr-3">{line.text || " "}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const diffLook = {
  same: { row: "text-muted-foreground", sign: "", mark: " ", said: "" },
  add: {
    row: "bg-emerald-500/10 text-foreground",
    sign: "text-emerald-500",
    mark: "+",
    said: "Added: ",
  },
  remove: {
    row: "bg-danger/10 text-foreground",
    sign: "text-danger",
    mark: "−",
    said: "Removed: ",
  },
};

// How much shows before Show all: the first lines, or the first characters of long lines. It
// takes a few more than that to fold, so Show all never opens on a line or two.
const preview = { lines: 12, chars: 1600, slack: 6 };

/**
 * A block's content, bounded: past a dozen lines it shows the first few, fading out, with Show
 * all, which opens the rest in a box that scrolls. Its state is the transcript's, under `id`.
 */
function Bounded({
  id,
  lines: count,
  chars = 0,
  fade = "from-background",
  children,
}: {
  id: string;
  lines: number;
  chars?: number;
  /** The background the fade ends in, as a gradient's `from-` class. */
  fade?: string;
  /** The content, its first `limit` lines, or all of them. */
  children: (limit?: number) => ReactNode;
}) {
  const [all, setAll] = useOpen(id);
  if (count <= preview.lines + preview.slack && chars <= preview.chars) return children();
  return (
    <>
      <div
        className={`relative ${all ? "max-h-[28rem] overflow-y-auto" : "max-h-60 overflow-hidden"}`}
      >
        {children(all ? undefined : preview.lines)}
        {!all && (
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-t ${fade} to-transparent`}
          />
        )}
      </div>
      <button
        type="button"
        aria-expanded={all}
        onClick={() => setAll(!all)}
        className="flex w-full cursor-default items-center justify-center gap-1 border-t border-border py-1.5 text-[11.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        {all ? "Show less" : count > preview.lines ? `Show all ${count} lines` : "Show all"}
        <ChevronDown
          aria-hidden
          className={`size-3 transition-[rotate] motion-reduce:transition-none ${all ? "rotate-180" : ""}`}
        />
      </button>
    </>
  );
}

/** Text in a `pre`, bounded. */
function BoundedText({
  id,
  text: all,
  fade,
  className,
}: {
  id: string;
  text: string;
  fade: string;
  className: string;
}) {
  const split = all.split("\n");
  return (
    <Bounded id={id} lines={split.length} chars={all.length} fade={fade}>
      {(limit) => <pre className={className}>{limit ? split.slice(0, limit).join("\n") : all}</pre>}
    </Bounded>
  );
}

function CopyButton({ text: copied, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(copied).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    });
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      onClick={copy}
      className="-mr-1.5 grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3"
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}

/** A web address that opens in the browser (main allows https only), or plain text if it can't. */
function Link({
  url,
  className,
  children,
}: {
  url: string;
  className: string;
  children?: ReactNode;
}) {
  if (!/^https?:\/\//i.test(url)) return <span className={className}>{children ?? url}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      className={`underline-offset-2 hover:underline ${className}`}
    >
      {children ?? url}
    </a>
  );
}

// --- Reading inputs and outputs ---

// The fields of a call's input that its card reads, by the names common tools use.
type Known =
  | "changes"
  | "command"
  | "content"
  | "description"
  | "edits"
  | "file_path"
  | "glob"
  | "kind"
  | "limit"
  | "new_string"
  | "notebook_path"
  | "offset"
  | "old_string"
  | "output_mode"
  | "path"
  | "pattern"
  | "prompt"
  | "query"
  | "subagent_type"
  | "truncated"
  | "type"
  | "url";
type Fields = { readonly [key: string]: JsonValue | undefined } & {
  readonly [K in Known]?: JsonValue;
};

const fieldsOf = (input?: JsonValue): Fields =>
  input && typeof input === "object" && !Array.isArray(input) ? input : {};

const text = (value?: JsonValue) => (typeof value === "string" && value !== "" ? value : undefined);

const basename = (path: string) => path.replace(/\/+$/, "").split(/[/\\]/).at(-1) || path;

const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

/** The first short value among an MCP call's arguments, which usually names what it acts on. */
const firstValue = (input: Fields) =>
  Object.values(input).find(
    (v): v is string => typeof v === "string" && v !== "" && v.length <= 80 && !v.includes("\n"),
  );

/** A shell command without the shell Codex wraps it in. */
function unwrap(command: string): string {
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command.trim());
  return wrapped ? wrapped[1]!.replaceAll(`'\\''`, "'") : command;
}

/** A command's first line, without a leading `cd`, for a row's title. */
const shortCommand = (command: string) =>
  command.replace(/^cd\s+\S+\s*&&\s*/, "").split("\n")[0] ?? "";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A URL without its scheme, query, or trailing slash. */
const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
};

/** A Codex file change's files: what happened to each, and its path. */
function changesOf(input: Fields): { kind: string; path: string }[] {
  if (!Array.isArray(input.changes)) return [];
  return input.changes.flatMap((c) => {
    const change = fieldsOf(c);
    const path = text(change.path);
    return path ? [{ kind: text(change.kind) ?? "", path }] : [];
  });
}

/**
 * Output as people read it: without the reminders Claude Code adds for the model, or the tags
 * around a tool's error.
 */
function cleanOutput(output?: string): string {
  return (output ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<\/?tool_use_error>/g, "")
    .trim();
}

/** Output that wispd cut short (`... (n bytes cut)` at its end): what's left, and how much went. */
function splitCut(output: string): { text: string; cut?: number } {
  const marker = /\n\.\.\. \((\d+) bytes cut\)$/.exec(output);
  return marker
    ? { text: output.slice(0, marker.index), cut: Number(marker[1]) }
    : { text: output };
}

const bytes = (n: number) =>
  n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;

/** A Read's output as `cat -n` numbers it, `   12→text`; undefined if it isn't. */
function numberedLines(output?: string): { n: number; text: string }[] | undefined {
  const all = cleanOutput(output).split("\n");
  const numbered = all.map((l) => /^\s*(\d+)(?:→|\t)(.*)$/.exec(l));
  if (!numbered[0]) return undefined;
  return numbered.flatMap((m) => (m ? [{ n: Number(m[1]), text: m[2]! }] : []));
}

/** A WebSearch's output as Claude Code gives it: its links, then its summary. */
function searchResults(output: string) {
  const found = /^Web search results for query: .*\n+Links: (\[.*\])\n*([\s\S]*)$/.exec(output);
  if (!found) return undefined;
  try {
    const links = (JSON.parse(found[1]!) as { title?: unknown; url?: unknown }[]).flatMap((l) =>
      typeof l.url === "string"
        ? [{ url: l.url, title: typeof l.title === "string" ? l.title : l.url }]
        : [],
    );
    return { links, rest: found[2]!.trim() };
  } catch {
    return undefined;
  }
}

/** JSON indented, or any other text as it is. */
function pretty(output: string): string {
  if (!/^[[{]/.test(output)) return output;
  try {
    return JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    return output;
  }
}
