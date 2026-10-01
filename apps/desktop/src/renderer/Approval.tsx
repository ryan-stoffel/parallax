// The agent's permission requests (RYA-196, decision 0031): the card pinned over the composer while
// one waits, and the line it leaves in the transcript once it's answered. The pinned card queues
// the run's own requests and, in a Project, those of its other runs. Tool input is untrusted: it
// renders only as text, and a plan only through the transcript's safe Markdown. Pure helpers
// first, then the components.
import {
  ChevronDown,
  ChevronUp,
  ListRestart,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  TimerOff,
  Undo2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { JsonValue } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { ProposedPlan } from "./Plan";
import type { Approval, ApprovalRequest, ApprovalResolution, Item } from "./transcript";

/** How the transcript names a tool (AgentChat's `describeTool`): its kind's icon, label, and target. */
export interface ToolLook {
  Icon: LucideIcon;
  label: string;
  detail?: string;
}

/** A request waiting in the queue: the run that asks, and for another run's, whose it is. */
export interface Asked {
  runId: string;
  approval: Approval;
  /** Another run's request: its name, such as "Subagent: Write the changelog", and its chat. */
  from?: { label: string; open?: () => void };
}

/** The user's answer: allow, allow with the request's rules for the rest of the session, or deny. */
export type Choice = "allow" | "always" | "deny";

/** Where this window's answer to a request is. */
export type AnswerState =
  | { state: "answering"; choice: Choice }
  | { state: "failed"; choice: Choice; error: string }
  /** `agent/approve` found no such request: it timed out or was withdrawn meanwhile. */
  | { state: "gone" }
  | { state: "answered"; resolved: ApprovalResolution };

const isObject = (v?: JsonValue): v is Record<string, JsonValue> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const field = (input: JsonValue | undefined, name: string) => {
  const value = isObject(input) ? input[name] : undefined;
  return typeof value === "string" ? value : undefined;
};

/** Whether a request is Claude Code's plan, which `ExitPlanMode` hands over for approval. */
export const isPlan = (request: ApprovalRequest) => request.toolName === "ExitPlanMode";

/**
 * The transcript's items with this window's answers in: a request answered here reads as resolved
 * before its `approvalResolved` arrives, which then takes over.
 */
export function withAnswers(items: Item[], answers: ReadonlyMap<string, AnswerState>): Item[] {
  if (answers.size === 0) return items;
  return items.map((item) => {
    if (item.kind !== "approval" || item.resolved) return item;
    const answer = answers.get(item.request.approvalId);
    return answer?.state === "answered" ? { ...item, resolved: answer.resolved } : item;
  });
}

/** The requests to show, oldest first, less any this window has answered. */
export function queueOf(
  asked: readonly Asked[],
  answers: ReadonlyMap<string, AnswerState>,
): Asked[] {
  return asked
    .filter((a) => answers.get(a.approval.request.approvalId)?.state !== "answered")
    .toSorted((a, b) => (a.approval.at ?? "").localeCompare(b.approval.at ?? ""));
}

/** Sets one request's answer state, for `setState`. */
const put = (approvalId: string, state: AnswerState) => (prev: ReadonlyMap<string, AnswerState>) =>
  new Map(prev).set(approvalId, state);

/**
 * This window's answers to permission requests, by approval id, and `answer`, which sends one with
 * `agent/approve`. A denial carries the user's note, if any. No answer edits the request's input,
 * so an `ExitPlanMode` answer never changes its `planFilePath` (0031). `dismiss` puts away a
 * request that's gone.
 */
export function useAnswers(hostId: string) {
  const [answers, setAnswers] = useState<ReadonlyMap<string, AnswerState>>(new Map());
  const answer = useCallback(
    async (asked: Asked, choice: Choice, message?: string) => {
      const { approvalId } = asked.approval.request;
      setAnswers(put(approvalId, { state: "answering", choice }));
      const decision =
        choice === "deny"
          ? { decision: "deny" as const, ...(message && { message }) }
          : { decision: "allow" as const, ...(choice === "always" && { always: true }) };
      const reply = await window.wisp.request(hostId, "agent/approve", {
        runId: asked.runId,
        approvalId,
        ...decision,
      });
      let next: AnswerState;
      if ("result" in reply)
        next = { state: "answered", resolved: { ...reply.result, at: new Date().toISOString() } };
      else if (reply.error.data?.kind === "approvalNotFound") next = { state: "gone" };
      else next = { state: "failed", choice, error: describeError(reply.error) };
      setAnswers(put(approvalId, next));
    },
    [hostId],
  );
  const dismiss = useCallback((asked: Asked) => {
    const resolved = {
      decision: "withdrawn",
      by: "agent",
      gone: true,
      at: new Date().toISOString(),
    } as const;
    setAnswers(put(asked.approval.request.approvalId, { state: "answered", resolved }));
  }, []);
  return { answers, answer, dismiss };
}

/** A time on the clock, with the date unless it's today: "2:31 PM", "Sep 30, 2:31 PM". */
export function clock(iso: string, now = Date.now()): string {
  const when = new Date(iso);
  const time = when.toLocaleString("en", { hour: "numeric", minute: "2-digit" });
  if (when.toDateString() === new Date(now).toDateString()) return time;
  return `${when.toLocaleString("en", { month: "short", day: "numeric" })}, ${time}`;
}

/** How a request came out, for its line in the transcript: words, an icon, and its color. */
interface Outcome {
  verb: string;
  /** Who decided and when, in a sentence, for the line's details. */
  who: string;
  Icon: LucideIcon;
  color: string;
}

/** A request's outcome, by its resolution. A decision newer than this app reads as ended. */
export function outcomeOf({ request, resolved }: Approval, now = Date.now()): Outcome {
  const plan = isPlan(request);
  const at = resolved?.at ? ` at ${clock(resolved.at, now)}` : "";
  if (!resolved)
    return {
      verb: plan ? "Plan waiting for approval" : "Waiting for approval",
      who: "Nobody has answered yet.",
      Icon: ShieldQuestion,
      color: "text-foreground",
    };
  const quiet = { Icon: Undo2, color: "text-faint-foreground" };
  if (resolved.gone)
    return {
      ...quiet,
      verb: plan ? "Plan no longer waiting" : "No longer waiting",
      who: "It timed out or was withdrawn before your answer reached it.",
    };
  const { decision, by, always } = resolved;
  if (decision === "allowed")
    return {
      verb: plan ? "Approved the plan" : always ? "Always allowed" : "Approved",
      who: `Approved by you${at}${always ? ", with its rules for the rest of the session" : ""}.`,
      Icon: ShieldCheck,
      color: "text-muted-foreground",
    };
  if (decision === "denied") {
    const stopped = by === "cancel" || by === "stop";
    const who =
      by === "user"
        ? `Denied by you${at}.`
        : by === "cancel"
          ? `Denied when the run was stopped${at}.`
          : by === "stop"
            ? `Denied when wispd stopped${at}.`
            : `Denied${at}.`;
    if (plan && by === "user")
      return { verb: "Kept planning", who, Icon: ListRestart, color: "text-muted-foreground" };
    return {
      verb: plan ? "Plan not approved" : "Denied",
      who,
      Icon: ShieldX,
      color: stopped ? "text-muted-foreground" : "text-danger",
    };
  }
  if (decision === "expired")
    return {
      verb: plan ? "Plan timed out" : "Timed out",
      who: `Nobody answered in time, so wispd denied it${at}.`,
      Icon: TimerOff,
      color: "text-faint-foreground",
    };
  if (decision === "withdrawn")
    return {
      ...quiet,
      verb: plan ? "Plan withdrawn" : "Withdrawn",
      who:
        by === "stop"
          ? `The run ended before anyone answered${at}.`
          : `The agent stopped waiting for an answer${at}.`,
    };
  return { ...quiet, verb: plan ? "Plan ended" : "Ended", who: `It ended${at}.` };
}

// The input field a card's header shows beside the tool's name, by the names common tools use:
// what it acts on, or what it's for. The command, URL, or query itself is in the preview. A path
// is cut from its start, so the file's name stays.
const pathTools = ["Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "NotebookRead", "LS"];
function headerDetail(request: ApprovalRequest, tool: ToolLook) {
  const { toolName, input } = request;
  if (toolName === "Bash" || toolName === "Task" || toolName === "Agent")
    return { text: field(input, "description"), path: false };
  if (pathTools.includes(toolName))
    return {
      text: field(input, "file_path") ?? field(input, "notebook_path") ?? field(input, "path"),
      path: true,
    };
  if (toolName === "Grep" || toolName === "Glob") return { text: field(input, "path"), path: true };
  // An MCP server's tool or a skill, which the transcript names by what it is.
  if (tool.label !== toolName) return { text: tool.detail, path: false };
  return undefined;
}

/** One line of a diff: unchanged, added, or removed, or a run of unchanged lines left out. */
export type DiffLine = { op: " " | "+" | "-"; text: string } | { op: "gap"; count: number };

// Past this many cells, the line diff below gives up on alignment: all removed, then all added.
const maxDiffCells = 250_000;

/**
 * The lines from `before` to `after`, aligned by their longest common run, with unchanged runs
 * longer than `context` lines either side of a change left out as a gap.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const middle: { op: " " | "+" | "-"; text: string }[] = [];
  if (x.length * y.length > maxDiffCells) {
    middle.push(...x.map((text) => ({ op: "-" as const, text })));
    middle.push(...y.map((text) => ({ op: "+" as const, text })));
  } else {
    // lcs[i * w + j]: the longest common run of x[i..] and y[j..].
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          x[i] === y[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    // Removed lines go before added ones, as diffs read.
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ op: " ", text: x[i]! });
        i++;
        j++;
      } else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!))
        middle.push({ op: "-", text: x[i++]! });
      else middle.push({ op: "+", text: y[j++]! });
    }
  }
  const all = [
    ...a.slice(0, head).map((text) => ({ op: " " as const, text })),
    ...middle,
    ...a.slice(a.length - tail).map((text) => ({ op: " " as const, text })),
  ];
  // Unchanged lines more than `context` away from every change go, a run of them as one gap.
  const changed = all.flatMap((l, i) => (l.op === " " ? [] : [i]));
  const near = (i: number) => changed.some((c) => Math.abs(c - i) <= context);
  const out: DiffLine[] = [];
  all.forEach((line, i) => {
    if (line.op !== " " || near(i)) return out.push(line);
    const last = out.at(-1);
    if (last?.op === "gap") last.count++;
    else out.push({ op: "gap", count: 1 });
  });
  return out;
}

// What a preview shows before Show all: lines, and characters in all.
const previewLines = 8;
const previewChars = 900;

/** `text` cut to the preview's lines and characters, and how many lines it had. */
function cut(text: string, all: boolean) {
  const lines = text.split("\n");
  if (all) return { shown: text, lines: lines.length, cut: false };
  let shown = lines.slice(0, previewLines).join("\n");
  if (shown.length > previewChars) shown = `${shown.slice(0, previewChars)}…`;
  return { shown, lines: lines.length, cut: shown !== text };
}

const codeBox =
  "overflow-x-auto rounded-lg border border-border bg-sidebar px-2.5 py-2 font-mono text-[12px] leading-relaxed";

/** Show all, or Show less, for a preview cut short. */
function ShowAll({ all, onToggle, lines }: { all: boolean; onToggle: () => void; lines?: number }) {
  return (
    <button
      type="button"
      aria-expanded={all}
      onClick={onToggle}
      className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
    >
      {all ? (
        <ChevronUp aria-hidden className="size-3.5" />
      ) : (
        <ChevronDown aria-hidden className="size-3.5" />
      )}
      {all ? "Show less" : lines && lines > previewLines ? `Show all ${lines} lines` : "Show all"}
    </button>
  );
}

/** Text in monospace, as a command or a URL, cut short with Show all. */
function Code({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const shown = cut(text, all);
  return (
    <div>
      <pre className={`${codeBox} whitespace-pre-wrap break-words`}>{shown.shown}</pre>
      {(shown.cut || all) && (
        <ShowAll all={all} lines={shown.lines} onToggle={() => setAll(!all)} />
      )}
    </div>
  );
}

/** Prose, as a subagent's task, cut short with Show all. */
function Prose({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const shown = cut(text, all);
  return (
    <div>
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {shown.shown}
      </p>
      {(shown.cut || all) && (
        <ShowAll all={all} lines={shown.lines} onToggle={() => setAll(!all)} />
      )}
    </div>
  );
}

/** A diff from `before` to `after`, a line each, cut short with Show all. */
function Diff({ before, after }: { before: string; after: string }) {
  const [all, setAll] = useState(false);
  const lines = diffLines(before, after);
  const shown = all ? lines : lines.slice(0, previewLines + 2);
  const added = lines.filter((l) => l.op === "+").length;
  const removed = lines.filter((l) => l.op === "-").length;
  return (
    <div>
      <div
        role="group"
        aria-label={`Diff: ${added} ${added === 1 ? "line" : "lines"} added, ${removed} removed`}
        className={`${codeBox} px-0 py-1.5`}
      >
        {shown.map((line, i) =>
          line.op === "gap" ? (
            <div key={i} className="px-2.5 text-faint-foreground">
              ⋯ {line.count} unchanged {line.count === 1 ? "line" : "lines"}
            </div>
          ) : (
            <div
              key={i}
              className={`flex px-2.5 ${line.op === "+" ? "bg-added/10" : line.op === "-" ? "bg-danger/10" : ""}`}
            >
              <span
                aria-hidden
                className={`w-4 shrink-0 select-none ${line.op === "+" ? "text-added" : line.op === "-" ? "text-danger" : "text-faint-foreground"}`}
              >
                {line.op === "-" ? "−" : line.op}
              </span>
              {line.op !== " " && (
                <span className="sr-only">{line.op === "+" ? "Added: " : "Removed: "}</span>
              )}
              <span className="min-w-0 break-words whitespace-pre-wrap">{line.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {(lines.length > shown.length || all) && (
        <ShowAll all={all} lines={lines.length} onToggle={() => setAll(!all)} />
      )}
    </div>
  );
}

// Arguments shown before Show all, and each one's lines.
const previewFields = 6;

/**
 * An MCP call's or any other tool's arguments, a name and value each: text as it reads, anything
 * else as JSON. Cut to a few lines each, with Show all, unless `whole`.
 */
function Fields({ input, whole = false }: { input: Record<string, JsonValue>; whole?: boolean }) {
  const [all, setAll] = useState(whole);
  const list = useRef<HTMLDListElement>(null);
  const entries = Object.entries(input);
  const shown = all ? entries : entries.slice(0, previewFields);
  // Whether a value is cut to its three lines, measured; by its length where nothing lays out.
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = list.current!;
    const measure = () =>
      setClamped(
        [...el.querySelectorAll("dd")].some((dd) => dd.scrollHeight > dd.clientHeight + 1),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [all]);
  const long = entries.some(([, v]) => {
    const text = valueText(v, false);
    return text.length > 300 || text.split("\n").length > 3;
  });
  return (
    <div>
      <dl
        ref={list}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12.5px] leading-relaxed"
      >
        {shown.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-faint-foreground">{name}</dt>
            <dd
              className={`break-words whitespace-pre-wrap ${typeof value === "string" ? "" : "font-mono text-[12px]"} ${all ? "" : "line-clamp-3"}`}
            >
              {valueText(value, all)}
            </dd>
          </div>
        ))}
      </dl>
      {(entries.length > shown.length || long || clamped || all) && (
        <ShowAll all={all} onToggle={() => setAll(!all)} />
      )}
    </div>
  );
}

/** A value as text: a string as it is, anything else as JSON, laid out once shown whole. */
const valueText = (value: JsonValue, whole = true) =>
  typeof value === "string" ? value : JSON.stringify(value, null, whole ? 2 : undefined);

/**
 * What a request will do, by the names common tools use: the command, the edit as a diff, the
 * URL, a subagent's task, or the arguments. Nothing for a tool whose header says it all.
 */
export function RequestPreview({ request }: { request: ApprovalRequest }) {
  const { toolName, input } = request;
  if (isObject(input) && input["truncated"] === true) {
    const bytes = typeof input["bytes"] === "number" ? input["bytes"] : 0;
    return (
      <p className="text-[12.5px] text-muted-foreground">
        Its input is too large to show ({Math.ceil(bytes / 1024)} KB). Approving runs it as asked.
      </p>
    );
  }
  const text = (name: string) => field(input, name);
  switch (toolName) {
    case "Bash":
      return text("command") !== undefined ? <Code text={text("command")!} /> : null;
    case "Edit":
      return (
        <div className="space-y-1.5">
          <Diff before={text("old_string") ?? ""} after={text("new_string") ?? ""} />
          {isObject(input) && input["replace_all"] === true && (
            <p className="text-[12px] text-muted-foreground">Replaces every match in the file.</p>
          )}
        </div>
      );
    case "MultiEdit": {
      const edits = isObject(input) && Array.isArray(input["edits"]) ? input["edits"] : [];
      return (
        <div className="space-y-1.5">
          {edits.map((edit, i) => (
            <Diff
              key={i}
              before={field(edit, "old_string") ?? ""}
              after={field(edit, "new_string") ?? ""}
            />
          ))}
        </div>
      );
    }
    case "Write":
      // Its content as added lines, though it may replace a file that's there.
      return (
        <div className="space-y-1.5">
          <Diff before="" after={text("content") ?? ""} />
          <p className="text-[12px] text-muted-foreground">Writes the whole file.</p>
        </div>
      );
    case "NotebookEdit":
      return text("edit_mode") === "delete" ? (
        <p className="text-[12.5px] text-muted-foreground">Deletes a cell.</p>
      ) : (
        <Diff before="" after={text("new_source") ?? ""} />
      );
    case "WebFetch":
      return (
        <div className="space-y-1.5">
          {text("url") !== undefined && <Code text={text("url")!} />}
          {text("prompt") && <Prose text={text("prompt")!} />}
        </div>
      );
    case "WebSearch":
      return text("query") !== undefined ? <Code text={text("query")!} /> : null;
    case "Grep":
    case "Glob":
      return text("pattern") !== undefined ? <Code text={text("pattern")!} /> : null;
    case "Read":
    case "NotebookRead":
    case "LS":
      return null;
    case "Task":
    case "Agent":
      return text("prompt") ? <Prose text={text("prompt")!} /> : null;
  }
  // A question for the user, rather than one action, shows whole (0031).
  if (isObject(input))
    return Object.keys(input).length > 0 ? (
      <Fields input={input} whole={!!request.interactive} />
    ) : null;
  return <Code text={valueText(input)} />;
}

/** Why the CLI asks, the path that made it, and whether one of the agent's own subagents asks. */
function Context({ request }: { request: ApprovalRequest }) {
  const { reason, blockedPath, subagent } = request;
  if (!reason && !blockedPath && !subagent) return null;
  return (
    <div className="space-y-0.5 text-[12px] text-muted-foreground">
      {reason && <p className="break-words">{reason}</p>}
      {blockedPath && (
        <p className="break-words">
          Path: <span className="font-mono">{blockedPath}</span>
        </p>
      )}
      {subagent && <p>Asked by one of the agent's own subagents.</p>}
    </div>
  );
}

// The most of the window a pinned card's preview, or a pinned plan opened in full, takes before it
// scrolls, so the card's buttons and the composer stay in view. Where a grown composer leaves less
// room, it gives way further: the chat's bottom block is a column bounded by the window, and each
// frame down to the preview may shrink (`min-h-0`) while the header, buttons, and composer don't.
const pinnedMaxHeight = "45vh";

const quietButton =
  "h-7 shrink-0 rounded-md px-2.5 text-[12.5px] text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-50";
const outlineButton =
  "h-7 shrink-0 rounded-md border border-border px-2.5 text-[12.5px] text-foreground enabled:hover:bg-hover disabled:opacity-50";
const approveButton =
  "h-7 shrink-0 rounded-md bg-send px-3 text-[12.5px] font-medium text-send-foreground enabled:hover:opacity-90 disabled:opacity-50";

/** What a button says while its answer is on the way. */
const pendingLabel = (choice: Choice, plan: boolean) =>
  choice === "allow"
    ? "Approving…"
    : choice === "always"
      ? "Allowing…"
      : plan
        ? "Sending…"
        : "Denying…";

interface CardProps {
  asked: Asked;
  tool: ToolLook;
  /** Its place in the queue, from 1, and how many wait. */
  position: number;
  count: number;
  state?: AnswerState;
  onAnswer: (choice: Choice, message?: string) => void;
  onDismiss: () => void;
  /** Why answering is off right now, such as a lost connection. */
  disabledReason?: string;
  /** Renders a plan's Markdown, as the transcript does. */
  markdown: (text: string) => ReactNode;
  /** The card's outermost element, which the queue moves focus to. */
  focusRef: RefObject<HTMLDivElement | null>;
}

/** The buttons, or the note for a denial, or what to do with a request that's gone. */
function Answers({
  plan,
  state,
  rules,
  rulesId,
  onAnswer,
  onDismiss,
  disabledReason,
}: {
  plan: boolean;
  state?: AnswerState;
  rules?: string[];
  rulesId: string;
  onAnswer: (choice: Choice, message?: string) => void;
  onDismiss: () => void;
  disabledReason?: string;
}) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  // The note's field takes focus as it opens, and Cancel gives it back to Deny.
  useLayoutEffect(() => {
    if (denying) noteRef.current?.focus();
  }, [denying]);
  if (state?.state === "gone")
    return (
      <button type="button" onClick={onDismiss} className={outlineButton}>
        Dismiss
      </button>
    );
  const busy = state?.state === "answering";
  const off = busy || disabledReason !== undefined;
  const label = (choice: Choice, idle: string) =>
    busy && state.choice === choice ? pendingLabel(choice, plan) : idle;
  const deny = plan ? "Keep planning" : "Deny";
  if (denying)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer("deny", note.trim() || undefined);
        }}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        <input
          ref={noteRef}
          aria-label={plan ? "What should change" : "Note to the agent"}
          placeholder={
            plan ? "What should change? (optional)" : "Tell the agent why, or what to do instead"
          }
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || busy) return;
            e.preventDefault();
            setDenying(false);
            requestAnimationFrame(() => denyRef.current?.focus());
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12.5px] placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setDenying(false);
            requestAnimationFrame(() => denyRef.current?.focus());
          }}
          className={quietButton}
        >
          Cancel
        </button>
        <button type="submit" disabled={off} title={disabledReason} className={outlineButton}>
          {label("deny", deny)}
        </button>
      </form>
    );
  return (
    <>
      <button
        ref={denyRef}
        type="button"
        disabled={off}
        title={disabledReason}
        onClick={() => setDenying(true)}
        className={quietButton}
      >
        {label("deny", deny)}
      </button>
      {rules && (
        <button
          type="button"
          disabled={off}
          title={disabledReason}
          aria-describedby={rulesId}
          onClick={() => onAnswer("always")}
          className={outlineButton}
        >
          {label("always", "Always allow")}
        </button>
      )}
      <button
        type="button"
        disabled={off}
        title={disabledReason}
        onClick={() => onAnswer("allow")}
        className={approveButton}
      >
        {label("allow", plan ? "Approve plan" : "Approve")}
      </button>
    </>
  );
}

/** The card's status in words: waiting, its place in the queue, answering, or gone. */
function statusText(state: AnswerState | undefined, position: number, count: number, plan = false) {
  if (state?.state === "answering") return pendingLabel(state.choice, plan);
  if (state?.state === "gone") return "No longer waiting";
  return count > 1 ? `Needs approval · ${position} of ${count}` : "Needs approval";
}

/** Why an answer didn't go, or what became of a request that's gone. */
function Problem({ state }: { state?: AnswerState }) {
  if (state?.state === "failed")
    return (
      <p role="alert" className="text-[12.5px] text-danger">
        Your answer didn't reach the agent: {state.error}
      </p>
    );
  if (state?.state === "gone")
    return (
      <p className="text-[12.5px] text-muted-foreground">
        This request is no longer waiting. It timed out or was withdrawn before your answer reached
        it.
      </p>
    );
  return null;
}

/**
 * A request as a card, the same weight as the plan card: the tool's icon and name, what it acts
 * on, a preview of what it will do, then Approve in the accent, a quiet Deny, and Always allow
 * when the request offers rules, which it names.
 */
function ApprovalCard({
  asked,
  tool,
  position,
  count,
  state,
  onAnswer,
  onDismiss,
  disabledReason,
  focusRef,
}: CardProps) {
  const { request } = asked.approval;
  const titleId = useId();
  const statusId = useId();
  const rulesId = useId();
  const detail = headerDetail(request, tool);
  const rules = request.alwaysAllow?.length ? request.alwaysAllow : undefined;
  return (
    <div
      ref={focusRef}
      role="group"
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={statusId}
      className="flex min-h-0 flex-col rounded-xl border border-border bg-surface focus-visible:outline-none"
    >
      <div className="flex items-center gap-2 px-4 pt-3 text-[13px]">
        <tool.Icon aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <span id={titleId} className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium">{tool.label}</span>
          {detail?.text &&
            (detail.path ? (
              // Right to left, so the ellipsis takes the path's start; <bdi> keeps it in order.
              <span
                title={detail.text}
                className="truncate text-left font-mono text-[12px] text-muted-foreground [direction:rtl]"
              >
                <bdi>{detail.text}</bdi>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">{detail.text}</span>
            ))}
        </span>
        <span
          id={statusId}
          className="ml-auto shrink-0 pl-2 text-[12px] text-muted-foreground tabular-nums"
        >
          {statusText(state, position, count)}
        </span>
      </div>
      {/* The preview scrolls past its bound; the header, a problem, and the buttons stay put. */}
      <div className="space-y-2 overflow-y-auto px-4 pt-2.5" style={{ maxHeight: pinnedMaxHeight }}>
        <RequestPreview request={request} />
        <Context request={request} />
      </div>
      <div className="px-4 pt-2 empty:hidden">
        <Problem state={state} />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-3">
        {rules && state?.state !== "gone" && (
          // Every rule whole, wrapping where it must, since Always allow grants all of them.
          <p
            id={rulesId}
            className="mr-auto min-w-0 flex-1 basis-60 text-[12px] leading-relaxed text-faint-foreground"
          >
            Always allow adds{" "}
            {rules.map((rule, i) => (
              <Fragment key={i}>
                {i > 0 && ", "}
                <code className="font-mono text-muted-foreground [overflow-wrap:anywhere]">
                  {rule}
                </code>
              </Fragment>
            ))}
          </p>
        )}
        <Answers
          plan={false}
          state={state}
          rules={rules}
          rulesId={rulesId}
          onAnswer={onAnswer}
          onDismiss={onDismiss}
          disabledReason={disabledReason}
        />
      </div>
    </div>
  );
}

// About 8 lines of the plan's Markdown, so the pinned plan leaves room for the transcript.
const pinnedPlanHeight = 184;

/**
 * `ExitPlanMode`'s request as RYA-220's proposed plan, with Keep planning and Approve plan in its
 * actions. A request without a plan says so, and can be answered all the same.
 */
function PlanApprovalCard({
  asked,
  position,
  count,
  state,
  onAnswer,
  onDismiss,
  disabledReason,
  markdown,
  focusRef,
}: CardProps) {
  const { request } = asked.approval;
  const [open, setOpen] = useState(false);
  const statusId = useId();
  const plan = field(request.input, "plan");
  return (
    <div
      ref={focusRef}
      role="group"
      tabIndex={-1}
      aria-label="Plan approval"
      aria-describedby={statusId}
      className="flex min-h-0 flex-col rounded-xl focus-visible:outline-none"
    >
      <ProposedPlan
        id={asked.approval.key}
        open={open}
        onToggle={(_, next) => setOpen(next)}
        foldAt={pinnedPlanHeight}
        openHeight={pinnedMaxHeight}
        actions={
          <>
            {/* At the foot, by the buttons, where the fold can't hide it. */}
            <span id={statusId} className="mr-auto min-w-0 text-[12px] text-muted-foreground">
              {state?.state === "failed" ? (
                <span role="alert" className="text-danger">
                  Your answer didn't reach the agent: {state.error}
                </span>
              ) : state?.state === "gone" ? (
                "No longer waiting: it timed out or was withdrawn."
              ) : (
                <span className="tabular-nums">{statusText(state, position, count, true)}</span>
              )}
            </span>
            <Answers
              plan
              state={state}
              rulesId=""
              onAnswer={onAnswer}
              onDismiss={onDismiss}
              disabledReason={disabledReason}
            />
          </>
        }
      >
        {plan?.trim() ? (
          markdown(plan)
        ) : (
          <p className="text-[13px] text-muted-foreground">
            The plan didn't come with the request. The agent's messages above may have it.
          </p>
        )}
        <div className="mt-2 empty:hidden">
          <Context request={request} />
        </div>
      </ProposedPlan>
    </div>
  );
}

/**
 * The pinned card's frame, keyed by request so each one rises into place. As it leaves the page,
 * it says whether focus was in it, so the next card or the composer can take it (`onLeave`). Focus
 * on the body counts, as when the button pressed turned off while its answer went.
 *
 * A card that takes another's place under a still pointer would take a click meant for that one,
 * so it ignores a pointer's clicks until the pointer moves over it or a finger touches it. A card
 * swapped in under a still mouse or a hovering pen gets no pointermove. A key's click (`detail` 0)
 * always goes, since a new card's focus starts on its frame, never on a button, and nothing looks
 * turned off meanwhile.
 */
function Pinned({ onLeave, children }: { onLeave: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [leave] = useState(() => onLeave);
  const moved = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || el.contains(active)) leave();
    };
  }, [leave]);
  return (
    <div
      ref={ref}
      onPointerMove={() => {
        moved.current = true;
      }}
      // A touch is a fresh contact, which can't have been meant for another card. A pen can hover
      // as a mouse does, so like a mouse it moves first.
      onPointerDown={(e) => {
        if (e.pointerType === "touch") moved.current = true;
      }}
      onClickCapture={(e) => {
        if (moved.current || e.detail === 0) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className="approval-in flex min-h-0 flex-col space-y-1.5"
    >
      {children}
    </div>
  );
}

/**
 * The requests waiting on the user, pinned over the composer so they can't scroll away: the oldest
 * as a card, with its place in the queue, and the next in its place once it's answered. The card
 * on screen stays for as long as it waits: requests that arrive after it queue behind it, older or
 * not, as a Project's other runs' can once their logs are read. Another run's names the run. A new
 * card takes focus only from nothing, or from the card just answered, never from someone typing;
 * once the last goes, focus that was in it returns by `returnFocus`. A polite status says what
 * came, how it was answered, and when more wait.
 */
export function ApprovalQueue({
  asked,
  answers,
  onAnswer,
  onDismiss,
  describe,
  markdown,
  disabledReason,
  returnFocus,
}: {
  asked: readonly Asked[];
  answers: ReadonlyMap<string, AnswerState>;
  onAnswer: (asked: Asked, choice: Choice, message?: string) => void;
  onDismiss: (asked: Asked) => void;
  describe: (toolName: string, input?: JsonValue) => ToolLook;
  markdown: (text: string) => ReactNode;
  disabledReason?: string;
  returnFocus?: () => void;
}) {
  // The card on screen, which stays first while it's in the queue.
  const [shown, setShown] = useState<string>();
  const held = asked.find((a) => a.approval.request.approvalId === shown);
  const queue = held ? [held, ...asked.filter((a) => a !== held)] : asked;
  const head = queue[0];
  const key = head?.approval.request.approvalId;
  if (key !== shown) setShown(key);
  const card = useRef<HTMLDivElement>(null);
  // Whether focus was in the card that just went (`Pinned`), so the next one or the composer
  // takes it.
  const hadFocus = useRef(false);
  const [leave] = useState(() => () => {
    hadFocus.current = true;
  });
  useLayoutEffect(() => {
    const el = card.current;
    const active = document.activeElement;
    if (el && (hadFocus.current || !active || active === document.body))
      el.focus({ preventScroll: true });
    else if (!el && hadFocus.current) returnFocus?.();
    hadFocus.current = false;
  }, [key, returnFocus]);

  // What the status says: how the last card was answered, then what the next one asks, or how
  // many wait once more do. Every other thing it says ends in a zero-width space, so the region
  // still changes, and is read again, when it says what it said before, as 2 waiting, 1, then 2.
  const [said, setSaid] = useState<{
    key?: string;
    head?: Asked;
    count: number;
    text: string;
    times: number;
  }>({ count: 0, text: "", times: 0 });
  if (said.key !== key) {
    const parts: string[] = [];
    const answered = said.head && answers.get(said.head.approval.request.approvalId);
    if (said.head && answered?.state === "answered")
      parts.push(`${outcomeOf({ ...said.head.approval, resolved: answered.resolved }).verb}.`);
    if (head) {
      const tool = describe(head.approval.request.toolName, head.approval.request.input);
      const what = isPlan(head.approval.request)
        ? "the plan"
        : [tool.label, tool.detail].filter(Boolean).join(": ");
      const from = head.from ? ` from ${head.from.label}` : "";
      const place = queue.length > 1 ? `, 1 of ${queue.length}` : "";
      parts.push(`Approval needed${from}${place}: ${what}.`);
    }
    setSaid({ key, head, count: queue.length, text: parts.join(" "), times: said.times + 1 });
  } else if (said.count !== queue.length)
    setSaid({
      ...said,
      count: queue.length,
      ...(queue.length > said.count && {
        text: `${queue.length} requests waiting.`,
        times: said.times + 1,
      }),
    });

  const state = head && answers.get(head.approval.request.approvalId);
  const props = head && {
    asked: head,
    tool: describe(head.approval.request.toolName, head.approval.request.input),
    position: 1,
    count: queue.length,
    state,
    onAnswer: (choice: Choice, message?: string) => onAnswer(head, choice, message),
    onDismiss: () => onDismiss(head),
    disabledReason,
    markdown,
    focusRef: card,
  };
  return (
    <>
      {/* Always on the page, so a screen reader hears what changes in it. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {said.text + (said.times % 2 ? "\u200b" : "")}
      </p>
      {head && props && (
        <section aria-label="Approval requests" className="mb-3 flex min-h-0 flex-col">
          <Pinned key={key} onLeave={leave}>
            {head.from && (
              <p className="flex min-w-0 items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
                <Workflow aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{head.from.label}</span>
                {head.from.open && (
                  <button
                    type="button"
                    onClick={head.from.open}
                    className="shrink-0 font-medium text-foreground underline underline-offset-2"
                  >
                    Open its chat
                  </button>
                )}
              </p>
            )}
            {isPlan(head.approval.request) ? (
              <PlanApprovalCard {...props} />
            ) : (
              <ApprovalCard {...props} />
            )}
          </Pinned>
        </section>
      )}
    </>
  );
}

/**
 * A request's line in the transcript, in place of the card once it's answered: how it came out,
 * what it asked, and when. "Approved Bash: pnpm test".
 */
export function ApprovalSummary({ approval, tool }: { approval: Approval; tool: ToolLook }) {
  const { verb, Icon, color } = outcomeOf(approval);
  const plan = isPlan(approval.request);
  const at = approval.resolved?.at ?? approval.at;
  const detail = tool.detail?.split("\n")[0];
  return (
    <>
      <Icon aria-hidden className={`size-3.5 shrink-0 ${color}`} />
      <span className="shrink-0 font-medium">{verb}</span>
      {!plan && (
        <span className="min-w-0 truncate text-muted-foreground">
          {tool.label}
          {detail && (
            <>
              :{" "}
              <span
                className={tool.label === approval.request.toolName ? "font-mono text-[12px]" : ""}
              >
                {detail}
              </span>
            </>
          )}
        </span>
      )}
      {at && (
        <time dateTime={at} className="ml-auto shrink-0 pl-2 text-[12px] text-faint-foreground">
          {clock(at)}
        </time>
      )}
    </>
  );
}

/** What a line in the transcript opens to: who decided and when, the user's note, and the request. */
export function ApprovalDetails({ approval }: { approval: Approval }) {
  const { request, resolved } = approval;
  return (
    <div className="space-y-2 text-[12.5px]">
      <p className="text-muted-foreground">{outcomeOf(approval).who}</p>
      {resolved?.message && (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-faint-foreground">Your note: </span>
          {resolved.message}
        </p>
      )}
      {!isPlan(request) && <RequestPreview request={request} />}
      <Context request={request} />
    </div>
  );
}
