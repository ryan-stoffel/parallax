import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Copy,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  GitPullRequestArrow,
  Info,
  LoaderCircle,
  Ban,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AgentRun, JsonValue } from "../protocol/generated/protocol";
import { Composer, tabItem } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { RunOptions } from "./models";
import { titleOf } from "./threads";
import {
  failureText,
  groupWork,
  isRunning,
  workedFor,
  wispdTools,
  type Item,
  type Work,
} from "./transcript";
import { useAgentRun } from "./useAgentRun";

/** A row: a transcript item, or a message this window sent that hasn't reached the agent yet. */
type Row = Item | { kind: "pending"; key: string; text: string };
/** What the list shows: a turn's activity is folded into one `Work` row. */
type ViewRow = Row | Work;

/**
 * An agent run as a chat: its transcript, the composer, and the run's footer.
 * The same view serves normal threads, subagents, and a Project's coordinator.
 */
export function AgentChat({
  hostId,
  runId,
  notice,
  prompt,
  noRepo,
  tab,
  startOver,
}: {
  hostId: string;
  runId: string;
  /** A quiet note shown over the composer, such as which account a new thread got. */
  notice?: string;
  /** The run's first prompt, shown until the transcript loads, so a new thread opens on it. */
  prompt?: string;
  /** A thread with no repo: its scratch repository has no origin, so it gets no Open PR. */
  noRepo?: boolean;
  /** The composer's tab in place of the run's worktree, such as a coordinator's repository. */
  tab?: ReactNode;
  /**
   * Starts a new run with `text` in place of this one once this one can't take messages, as a
   * Project's coordinator can (0024). Resolves to an error message, or undefined.
   */
  startOver?: (text: string, options: RunOptions) => Promise<string | undefined>;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const { transcript, error, sent, send, cancel } = useAgentRun(hostId, runId, connected);
  const [resendError, setResendError] = useState<string>();
  const [prError, setPrError] = useState<string>();
  // Dropped follow-ups already sent again, so their Send again goes away (back on failure).
  const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
  const resend = useCallback(
    (turnId: string, text: string) => {
      setResent((prev) => new Set(prev).add(turnId));
      void send(text).then((failed) => {
        setResendError(failed?.message);
        if (failed)
          setResent((prev) => {
            const next = new Set(prev);
            next.delete(turnId);
            return next;
          });
      });
    },
    [send],
  );
  const unsent = useMemo(
    () => new Map([...sent].filter(([turnId]) => !resent.has(turnId))),
    [sent, resent],
  );
  const { run, items } = transcript;

  // A message wispd wouldn't send because the run can't be resumed, which `startOver` can take.
  const [refused, setRefused] = useState<{ text: string; options: RunOptions; why: string }>();
  const [startingOver, setStartingOver] = useState(false);
  const sendText = async (text: string, options: RunOptions) => {
    const failed = await send(text, options);
    if (!startOver || failed?.data?.kind !== "runNotResumable") return failed?.message;
    setRefused({ text, options, why: failed.message });
    return ""; // Back in the box; the line above it says why and offers Start over.
  };
  // A run that ended before its CLI reported a session never answered: it starts over with its
  // own first message.
  const stuck =
    startOver &&
    (refused ??
      (run && !isRunning(run.status) && !run.sessionId
        ? { text: run.prompt, options: {}, why: "it stopped before its session started." }
        : undefined));
  const restart = async () => {
    if (!stuck) return;
    setStartingOver(true);
    // The new run keeps this one's model, effort, and mode unless the message changed them.
    const {
      model = run?.model,
      effort = run?.effort,
      permission = run?.permission,
    } = stuck.options;
    const failed = await startOver(stuck.text, { model, effort, permission });
    setStartingOver(false);
    if (failed) setRefused({ ...stuck, why: failed });
  };

  // Sent from here, but no turnStarted (or followUpDropped) for it yet.
  const rows = useMemo<Row[]>(() => {
    const seen = new Set(items.flatMap((i) => ("turnId" in i && i.turnId ? [i.turnId] : [])));
    const pending = [...sent]
      .filter(([turnId]) => !seen.has(turnId))
      .map(([turnId, text]) => ({ kind: "pending" as const, key: `pending:${turnId}`, text }));
    const all = [...items, ...pending];
    return all.length === 0 && prompt
      ? [{ kind: "pending", key: "pending:prompt", text: prompt }]
      : all;
  }, [items, sent, prompt]);

  let disabledReason: string | undefined;
  if (connection?.status === "failed") disabledReason = "Disconnected from wispd";
  else if (!connected) disabledReason = "Connecting to wispd…";
  else if (!run) disabledReason = error ? "This chat couldn't load" : "Loading…";
  let optionsDisabled: string | undefined;
  // `sendModel` is `sendOptions`' successor, which also takes the model (RYA-163).
  if (connected && !("sendModel" in connection.capabilities))
    optionsDisabled = "This host's wispd can't change a thread's model, effort, or access";
  else if (isRunning(run?.status))
    optionsDisabled = "The model, effort, and access can change once it finishes";
  // A finished run with a commit can go to GitHub (RYA-168), until Accept removes its branch.
  const canOpenPr =
    connected &&
    "openPr" in connection.capabilities &&
    !noRepo &&
    !!run?.diff &&
    !isRunning(run.status) &&
    run.status !== "accepted";

  return (
    <>
      {rows.length > 0 ? (
        <TranscriptView rows={rows} sent={unsent} live={isRunning(run?.status)} onResend={resend} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center text-[13px] text-faint-foreground">
          {error ? (
            <>
              <p className="font-medium text-foreground">This chat couldn't load</p>
              <p className="text-muted-foreground">{error}</p>
            </>
          ) : (
            connected && "Loading…"
          )}
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-6 pb-5">
        {/* A loaded transcript that stopped updating, a failed Send again, or Open PR. */}
        {(error ?? resendError ?? prError) && rows.length > 0 && (
          <p role="alert" className="px-2 pb-2 text-[12.5px] text-danger">
            {error ?? resendError ?? prError}
          </p>
        )}
        {notice && (
          <p role="status" className="px-2 pb-2 text-[12.5px] text-muted-foreground">
            {notice}
          </p>
        )}
        {stuck && (
          <p role="alert" className="px-2 pb-2 text-[12.5px] text-danger">
            This chat can't continue: {stuck.why}{" "}
            <button
              type="button"
              disabled={startingOver}
              onClick={() => void restart()}
              className="font-medium text-foreground underline underline-offset-2 disabled:opacity-50"
            >
              Start over
            </button>
          </p>
        )}
        <Composer
          onSend={sendText}
          onStop={isRunning(run?.status) ? cancel : undefined}
          disabledReason={disabledReason}
          tab={
            tab ??
            (run && (
              <RunTab run={run}>
                {canOpenPr && <OpenPr hostId={hostId} run={run} onError={setPrError} />}
              </RunTab>
            ))
          }
          backend={run?.backend}
          started={run}
          optionsDisabled={optionsDisabled}
        />
      </div>
    </>
  );
}

/**
 * The transcript as a virtualized list. It follows new output while scrolled to
 * the bottom, and stays put once the user scrolls up.
 */
export function TranscriptView({
  rows,
  sent,
  live,
  onResend,
}: {
  rows: Row[];
  sent: ReadonlyMap<string, string>;
  live: boolean;
  onResend?: (turnId: string, text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Which tool calls and thoughts are expanded, kept here since rows unmount off screen.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (key: string, next: boolean) =>
      setOpen((prev) => {
        const set = new Set(prev);
        if (next) set.add(key);
        else set.delete(key);
        return set;
      }),
    [],
  );

  // While the run goes, a work row follows a message that has no reply yet, standing for what
  // the agent is doing before it does anything.
  const view = useMemo(() => {
    const grouped = groupWork(rows);
    const last = grouped.at(-1);
    if (live && (last?.kind === "user" || last?.kind === "pending"))
      grouped.push({ kind: "work", key: "work:pending", items: [] });
    return grouped;
  }, [rows, live]);
  // The agent's text streams in its own row, so a work row is only live while it is the last
  // (a notice after it doesn't count).
  const tail = view.findLastIndex((r) => r.kind !== "notice");
  const activeIndex = live && view[tail]?.kind === "work" ? tail : -1;

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: 24,
    getItemKey: (i) => view[i]!.key,
  });
  const total = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [total, view.length]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Transcript"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto select-text"
    >
      <div className="relative w-full" style={{ height: total }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = view[v.index]!;
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              <div className="mx-auto max-w-3xl px-6 py-2">
                <RowView
                  row={row}
                  sentText={"turnId" in row && row.turnId ? sent.get(row.turnId) : undefined}
                  live={live}
                  open={open.has(row.key)}
                  openKeys={row.kind === "work" ? open : undefined}
                  active={v.index === activeIndex}
                  onToggle={toggle}
                  onResend={onResend}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  row: ViewRow;
  /** The text of a follow-up this window sent, which the log doesn't hold. */
  sentText?: string;
  /** Whether the run is going, so a tool call with no result is still in progress. */
  live: boolean;
  open: boolean;
  /** For a work row: which of its items are expanded. */
  openKeys?: ReadonlySet<string>;
  /** For a work row: whether it is the one the agent is working in now. */
  active?: boolean;
  onToggle: (key: string, open: boolean) => void;
  /** Sends a dropped follow-up again. */
  onResend?: (turnId: string, text: string) => void;
}

/** One transcript row. Memoized: an unchanged item keeps its object, so it skips re-rendering. */
export const RowView = memo(function RowView({
  row,
  sentText,
  live,
  open,
  openKeys,
  active,
  onToggle,
  onResend,
}: RowProps) {
  switch (row.kind) {
    case "work":
      return (
        <WorkGroup
          work={row}
          active={active ?? false}
          live={live}
          open={open}
          openKeys={openKeys ?? new Set()}
          onToggle={onToggle}
        />
      );
    case "user":
    case "pending": {
      // A wake-up is wisp's message to the coordinator, not the user's (0025).
      if (row.kind === "user" && row.wake)
        return (
          <Disclosure
            id={row.key}
            open={open}
            onToggle={onToggle}
            summary={
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Workflow aria-hidden className="size-3.5" />
                From wisp: subagents finished
              </span>
            }
          >
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {row.text}
            </p>
          </Disclosure>
        );
      const text = row.text ?? sentText;
      return (
        <div className="flex justify-end">
          <div
            className={`max-w-[85%] rounded-2xl bg-selected px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap ${row.kind === "pending" ? "opacity-60" : ""}`}
          >
            {/* A follow-up from an older log, which has no text for it. */}
            {text ?? <span className="text-muted-foreground italic">Follow-up message</span>}
          </div>
        </div>
      );
    }
    case "assistant":
      return <MarkdownText text={row.text} />;
    case "reasoning":
      return (
        <Disclosure
          id={row.key}
          open={open}
          onToggle={onToggle}
          summary={<span className="text-muted-foreground">Thinking</span>}
        >
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {row.text}
          </p>
        </Disclosure>
      );
    case "tool":
      return <ToolCall item={row} live={live} open={open} onToggle={onToggle} />;
    case "todo":
      return (
        <ul aria-label="Checklist" className="space-y-1 text-[13px]">
          {row.items.map((todo, i) => (
            <li key={i} className="flex items-start gap-2">
              {todo.status === "completed" ? (
                <CircleCheck
                  aria-label="Done"
                  className="mt-0.5 size-3.5 shrink-0 text-faint-foreground"
                />
              ) : todo.status === "inProgress" ? (
                <LoaderCircle aria-label="In progress" className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <Circle
                  aria-label="To do"
                  className="mt-0.5 size-3.5 shrink-0 text-faint-foreground"
                />
              )}
              <span
                className={todo.status === "completed" ? "text-muted-foreground line-through" : ""}
              >
                {todo.text}
              </span>
            </li>
          ))}
        </ul>
      );
    case "notice":
      return (
        <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
          {row.tone === "warning" ? (
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>
            {row.text}
            {/* A dropped follow-up this window sent: offer it again, rather than lose it. */}
            {row.turnId && sentText !== undefined && onResend && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => onResend(row.turnId!, sentText)}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Send again
                </button>
              </>
            )}
          </span>
        </p>
      );
    case "end": {
      const { outcome } = row;
      if (outcome.status === "failed") {
        // A coordinator's no-write stop lists what it changed after its first line, one
        // `git status` line each (0024).
        const [first, ...changed] = outcome.message.split("\n");
        return (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 px-3.5 py-2.5 text-[13px]"
          >
            <p className="font-medium text-danger">Failed: {failureText(outcome.failure)}</p>
            <p className="mt-0.5 text-muted-foreground">{first}</p>
            {changed.length > 0 && (
              <pre className="mt-2 max-h-60 overflow-auto rounded-lg border border-border bg-sidebar p-2.5 font-mono text-[12px]">
                {changed.join("\n")}
              </pre>
            )}
          </div>
        );
      }
      const label =
        outcome.status === "completed"
          ? "Done"
          : outcome.status === "cancelled"
            ? "Stopped"
            : outcome.status === "interrupted"
              ? "Interrupted when wispd stopped. Send a message to pick up where it left off."
              : "Ended";
      return (
        <div className="flex items-center gap-3 text-[12px] text-faint-foreground">
          <span className="h-px flex-1 bg-border" />
          {label}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }
  }
});

/**
 * A run of thinking, tool calls, and checklists under one dropdown. While the agent works its
 * header says what it's doing now; afterward it says how long it worked, and hides the rest.
 */
function WorkGroup({
  work,
  active,
  live,
  open,
  openKeys,
  onToggle,
}: {
  work: Work;
  active: boolean;
  live: boolean;
  open: boolean;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
}) {
  const now = active ? activity(work.items.at(-1)) : undefined;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        disabled={work.items.length === 0}
        onClick={() => onToggle(work.key, !open)}
        className="group/work flex max-w-full cursor-default items-center gap-1.5 rounded-md py-0.5 text-[13px] hover:text-foreground"
      >
        {now ? (
          <>
            <span className="shrink-0 animate-pulse">{now.label}</span>
            {now.detail && <span className="truncate text-muted-foreground">{now.detail}</span>}
          </>
        ) : (
          <span className="text-muted-foreground">{workedFor(work.startedAt, work.endedAt)}</span>
        )}
        {work.items.length > 0 && (
          <ChevronRight
            aria-hidden
            className={`size-3.5 shrink-0 text-faint-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && (
        <div className="mt-2 ml-1 space-y-2.5 border-l border-border pl-4">
          {work.items.map((item) => (
            <RowView
              key={item.key}
              row={item}
              live={live}
              open={openKeys.has(item.key)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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

/** The header of the work in progress: what its latest item is doing. */
function activity(item?: Item): { label: string; detail?: string } {
  switch (item?.kind) {
    case "reasoning":
      return { label: "Thinking" };
    case "tool":
      return (
        wispdCall(item) ?? {
          label: verbs[item.name ?? ""] ?? item.name ?? "Working",
          detail: toolHint(item.input),
        }
      );
    case "todo":
      return { label: "Planning" };
    default:
      return { label: "Working" };
  }
}

function ToolCall({
  item,
  live,
  open,
  onToggle,
}: {
  item: Extract<Item, { kind: "tool" }>;
  live: boolean;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
}) {
  const icons: Partial<Record<string, ReactNode>> = {
    ok: <Check aria-label="Succeeded" />,
    error: <CircleX aria-label="Failed" className="text-danger" />,
    denied: <Ban aria-label="Denied" className="text-danger" />,
  };
  const wispd = wispdCall(item);
  let icon = item.status ? icons[item.status] : undefined;
  icon ??=
    live && !item.status ? (
      <LoaderCircle aria-label="Running" className="animate-spin" />
    ) : (
      <CircleDashed aria-label="No result" />
    );
  return (
    <Disclosure
      id={item.key}
      open={open}
      onToggle={onToggle}
      summary={
        <>
          <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
          <span className="shrink-0 font-medium">{wispd?.label ?? item.name ?? "Tool"}</span>
          {wispd ? (
            <span className="truncate text-muted-foreground">{wispd.detail}</span>
          ) : (
            <span className="truncate font-mono text-[12px] text-muted-foreground">
              {toolHint(item.input)}
            </span>
          )}
        </>
      }
    >
      <div className="space-y-2 text-[12px]">
        {item.input !== undefined && <Block label="Input">{inputText(item.input)}</Block>}
        {item.output !== undefined && <Block label="Output">{item.output}</Block>}
      </div>
    </Disclosure>
  );
}

/** A collapsed-by-default row, open state kept by the transcript. */
function Disclosure({
  id,
  open,
  onToggle,
  summary,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(e) => e.currentTarget.open !== open && onToggle(id, e.currentTarget.open)}
      className="group/disclosure"
    >
      <summary className="flex cursor-default list-none items-center gap-2 rounded-md py-0.5 text-[13px] hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-faint-foreground transition-transform group-open/disclosure:rotate-90"
        />
        {summary}
      </summary>
      <div className="mt-1.5 ml-5.5">{children}</div>
    </details>
  );
}

function Block({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <p className="mb-1 text-[11.5px] text-faint-foreground">{label}</p>
      <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-sidebar p-2.5 font-mono whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
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
function wispdCall(item: Extract<Item, { kind: "tool" }>) {
  const label = item.name?.startsWith(wispdTools)
    ? wispdLabels[item.name.slice(wispdTools.length)]
    : undefined;
  return label
    ? { label, detail: item.subagent ?? toolHint(item.input, ["prompt", "path"]) }
    : undefined;
}

function inputText(input: JsonValue): string {
  if (input && typeof input === "object" && !Array.isArray(input) && input["truncated"] === true) {
    const bytes = typeof input["bytes"] === "number" ? input["bytes"] : 0;
    return `Too large to show (${Math.ceil(bytes / 1024)} KB)`;
  }
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

// Agent output is untrusted: no raw HTML (no rehype-raw), and react-markdown's
// default urlTransform drops javascript: and other unsafe links. Links open in
// a new window, which main hands to the system browser, https only.
const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Never load images: a link with the alt text, which opens externally like any link.
  img: ({ src, alt }) => (
    // An unsafe source arrives as "" from urlTransform: no href at all, then.
    <a href={typeof src === "string" && src ? src : undefined} target="_blank" rel="noreferrer">
      {alt || "Image"}
    </a>
  ),
};

/** An agent message, rendered from Markdown with GitHub's extensions. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(ref.current?.textContent ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group/code relative">
      <pre
        ref={ref}
        className="overflow-x-auto rounded-lg border border-border bg-sidebar p-3 font-mono text-[12.5px] leading-relaxed"
      >
        {children}
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={copy}
        className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md bg-sidebar text-muted-foreground opacity-0 group-hover/code:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5"
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

/**
 * An open run in the composer's tab: that it runs in a worktree, and the worktree's branch,
 * followed by `children`, such as Open PR.
 */
export function RunTab({ run, children }: { run: AgentRun; children?: ReactNode }) {
  return (
    <>
      <span className={tabItem}>
        <FolderGit2 aria-hidden />
        Worktree
      </span>
      <span className="flex min-w-0 items-center">
        {run.branch && (
          <span className={tabItem} title="Worktree branch">
            <GitBranch aria-hidden />
            <span className="truncate">{run.branch}</span>
          </span>
        )}
        {children}
      </span>
    </>
  );
}

/**
 * Open PR: wispd pushes the run's branch and opens a pull request titled like the thread, then
 * this links to it, in the browser. It unmounts while the run works, so after another turn the
 * button is back, to push the new commit to the same pull request.
 */
function OpenPr({
  hostId,
  run,
  onError,
}: {
  hostId: string;
  run: AgentRun;
  onError: (error?: string) => void;
}) {
  const [url, setUrl] = useState<string>();
  const [opening, setOpening] = useState(false);
  if (url) {
    const number = /\/pull\/(\d+)$/.exec(url)?.[1];
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={url}
        className={`${tabItem} rounded-md hover:bg-hover hover:text-foreground`}
      >
        <GitPullRequest aria-hidden />
        {number ? `PR #${number}` : "Pull request"}
      </a>
    );
  }
  const open = async () => {
    setOpening(true);
    onError(undefined);
    const answer = await window.wisp.request(hostId, "agent/openPr", {
      runId: run.id,
      title: titleOf(run),
    });
    setOpening(false);
    if ("error" in answer) onError(describeError(answer.error));
    else setUrl(answer.result.url);
  };
  return (
    <button
      type="button"
      disabled={opening}
      onClick={() => void open()}
      className={`${tabItem} rounded-md enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-60`}
    >
      <GitPullRequestArrow aria-hidden />
      {opening ? "Opening PR…" : "Open PR"}
    </button>
  );
}
