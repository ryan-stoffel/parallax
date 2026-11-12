import {
  ArrowUp,
  BookOpen,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  GitBranch,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldQuestion,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { AgentRun, InboxItem, Orchestrator, Question } from "../protocol/generated/protocol";
import { runAttention, type Attention } from "./attention";
import { WorkingMark } from "./AttentionMark";
import {
  AllFiles,
  board,
  ContextBody,
  ContextReader,
  type OrchestratorContext,
} from "./ContextPanel";
import { questionOf, type InboxView } from "./Inbox";
import { dayLabel, locale } from "./locale";
import { notify } from "./notifications";
import { OpenHint } from "./OpenHint";
import { clockOptions } from "./prefs";
import type { OrchestratorAgentsView } from "./OrchestratorAgents";
import { age, useMinute } from "./Sidebar";
import { titleOf } from "./threads";
import { IconButton } from "./ui";
import type { Approval } from "./transcript";

type Group = "waiting" | "working" | "ready" | "resolved";

interface Row {
  run: AgentRun;
  title: string;
  group: Group;
  attention: Attention;
  /** Its newest inbox item, unread or not. */
  latest?: InboxItem;
  unread: InboxItem[];
  question?: Question;
  approval?: Approval;
}

/**
 * An orchestrator's home in the side panel, in the order the user acts on it (0083). Its headline
 * says what is open, beside a book that opens All files, its context folder as a tree. Then its
 * threads, read from their runs so they are never behind: Needs you
 * (a question answered in place, a permission request, or an unread failure), Working, and To
 * review, the finishes not opened yet. Then Plan, the status board the orchestrator writes, with
 * when it last changed. Then Earlier, the finishes already opened. Opening a finish marks what it
 * reported read (0043).
 */
export function OrchestratorHome({
  hostId,
  context,
  orchestrator,
  agents,
  titles = {},
  inbox,
  answerable,
  onOpen,
}: {
  hostId: string;
  /** The orchestrator's context files: its status board, and all of them behind the book. */
  context: OrchestratorContext;
  orchestrator: Orchestrator;
  agents: OrchestratorAgentsView;
  titles?: Readonly<Record<string, string>>;
  inbox: InboxView;
  answerable: boolean;
  onOpen: (runId: string) => void;
}) {
  const [openPath, setOpenPath] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const now = useMinute();
  const rows = rowsOf(orchestrator, agents, inbox, answerable, titles);
  const waiting = rows.filter((r) => r.group === "waiting");
  const working = rows.filter((r) => r.group === "working");
  const ready = rows.filter((r) => r.group === "ready");
  const earlier = rows.filter((r) => r.group === "resolved");
  const open = (row: Row) => {
    onOpen(row.run.id);
    const read = row.unread.filter((i) => i.kind !== "needsYou").map((i) => i.id);
    if (read.length) void inbox.seen(read);
  };
  const answer = (row: Row) => (text: string) =>
    row.question
      ? inbox.answer(
          row.unread.find((i) => i.kind === "needsYou")!,
          row.question,
          text,
        )
      : Promise.resolve(undefined);

  const { files, error } = context;
  const opened = files.find((f) => f.path === openPath);
  const notes = files.find((f) => f.path === board);
  const { lead, rest } = headline(rows);

  if (opened)
    return (
      <ContextReader
        hostId={hostId}
        orchestrator={orchestrator.id}
        files={files}
        file={opened}
        onOpen={setOpenPath}
        onBack={() => setOpenPath(undefined)}
      />
    );
  if (browsing)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setBrowsing(false)}
          className="mx-2 flex min-w-0 items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{orchestrator.name}</span>
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <h3 className={`${sectionHeading} px-2.5`}>All files</h3>
          <AllFiles files={files} onOpen={setOpenPath} />
        </div>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
      <header className="flex items-start gap-3 px-1 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading leading-tight font-semibold tracking-tight">{lead}</h2>
          {rest && <p className="mt-1 text-body text-muted-foreground">{rest}</p>}
        </div>
        {files.length > 0 && (
          <IconButton label="All files" onClick={() => setBrowsing(true)}>
            <BookOpen />
          </IconButton>
        )}
      </header>
      {waiting.length > 0 && (
        <section aria-label="Needs you">
          <h3 className={sectionHeading}>Needs you</h3>
          <ul className={group}>
            {waiting.map((row) => (
              <WaitingRow
                key={row.run.id}
                row={row}
                now={now}
                onOpen={() => open(row)}
                onAnswer={answer(row)}
              />
            ))}
          </ul>
        </section>
      )}
      {working.length > 0 && (
        <section aria-label="Working">
          <h3 className={sectionHeading}>Working</h3>
          <ul className={group}>
            {working.map((row) => (
              <li key={row.run.id}>
                <ChildButton
                  icon={<WorkingMark />}
                  title={plainTitle(row.title)}
                  state="Working"
                  detail={facts(row.run)}
                  end={age(row.run.updatedAt, now)}
                  onOpen={() => open(row)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {ready.length > 0 && (
        <section aria-label="To review">
          <h3 className={sectionHeading}>To review</h3>
          <ul className={group}>
            {ready.map((row) => (
              <FinishedRow key={row.run.id} row={row} now={now} onOpen={() => open(row)} />
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Plan">
        <h3 className={`${sectionHeading} flex items-baseline justify-between gap-3`}>
          Plan
          {notes && (
            <span className="text-meta font-normal tracking-normal normal-case">
              Updated {updated(notes.modifiedAt, now)}
            </span>
          )}
        </h3>
        <div className="px-1">
          {notes ? (
            <ContextBody
              hostId={hostId}
              orchestrator={orchestrator.id}
              files={files}
              file={notes}
              onOpen={setOpenPath}
            />
          ) : (
            !error && (
              <p className="text-body text-muted-foreground">
                The orchestrator writes its plan here once it starts on the work.
              </p>
            )
          )}
          {error && (
            <p role="alert" className="text-body text-danger">
              Couldn't load the plan. {error}
            </p>
          )}
        </div>
      </section>
      {earlier.length > 0 && (
        <section aria-label="Earlier">
          <h3 className={sectionHeading}>Earlier</h3>
          <ul className={group}>
            {earlier.map((row) => (
              <FinishedRow key={row.run.id} row={row} now={now} onOpen={() => open(row)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// A section's heading, and its rows grouped in one rounded list with hairlines between them.
const sectionHeading =
  "px-1 pt-6 pb-2 text-caption font-medium tracking-[0.08em] text-faint-foreground uppercase";
const group = "divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The tab's headline: the most pressing open state and how many threads are in it, then the other
 * open states. With nothing open it says so.
 */
export function headline(rows: readonly Pick<Row, "group">[]): { lead: string; rest?: string } {
  const n = (g: Group) => rows.filter((r) => r.group === g).length;
  const states = [
    {
      n: n("waiting"),
      lead: count(n("waiting"), "thread needs you", "threads need you"),
      rest: count(n("waiting"), "needs you", "need you"),
    },
    {
      n: n("working"),
      lead: count(n("working"), "thread working", "threads working"),
      rest: `${n("working")} working`,
    },
    {
      n: n("ready"),
      lead: count(n("ready"), "thread to review", "threads to review"),
      rest: `${n("ready")} to review`,
    },
  ].filter((s) => s.n > 0);
  const [first, ...others] = states;
  if (!first)
    return rows.length > 0
      ? { lead: "Nothing open", rest: count(rows.length, "thread finished", "threads finished") }
      : { lead: "No threads yet", rest: "Threads the orchestrator starts show up here." };
  return { lead: first.lead, rest: others.map((s) => s.rest).join(", ") || undefined };
}

/** "just now", "6m ago", or "2d ago": how long since `at`. */
const updated = (at: string, now: number) => {
  const since = age(at, now);
  return since === "now" ? "just now" : `${since} ago`;
};

/** A finish's clock time today, else its day: "10:16 AM", "Yesterday", or "Oct 20". */
const finished = (at: string, now: number) => {
  const day = dayLabel(Date.parse(at), now, { month: "short", day: "numeric" });
  return day === "Today" ? new Date(at).toLocaleTimeString(locale(), clockOptions()) : day;
};

/** 1234 as "1.2k", for a diff's counts in a row. */
const short = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`);

/**
 * A title without a Conventional Commit prefix, which plxd's thread titles often lead with:
 * "fix(GH-27): x" reads "x". Any other title is left as it is.
 */
export const plainTitle = (title: string) =>
  /^(?:feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert)(?:\([^)]+\))?!?: +(\S.*)$/.exec(
    title,
  )?.[1] ?? title;

/**
 * Each child of `orchestrator` once, newest first, with its group: waiting on the user (a question,
 * an approval, or an unread failure), working, or finished: ready while its news is unread and
 * resolved once read.
 */
function rowsOf(
  orchestrator: Orchestrator,
  agents: OrchestratorAgentsView,
  inbox: InboxView,
  answerable: boolean,
  titles: Readonly<Record<string, string>>,
): Row[] {
  return agents.runs
    .filter((r) => r.id !== orchestrator.run && r.policy !== "noWrite")
    .map((run) => {
      const items = inbox.items.filter((i) => i.run === run.id);
      const unread = items.filter((i) => !i.seenAt);
      const asking = unread.find((i) => i.kind === "needsYou");
      const question = asking && answerable ? questionOf(asking, inbox.questions) : undefined;
      const approval = agents.waiting[run.id]?.[0];
      const attention = runAttention(run, (asking ? 1 : 0) + (approval ? 1 : 0));
      const failedUnread = unread.some((i) => i.kind === "failed");
      const group: Group =
        attention === "needsYou" || (attention === "failed" && failedUnread)
          ? "waiting"
          : attention === "working"
            ? "working"
            : unread.length > 0
              ? "ready"
              : "resolved";
      return {
        run,
        title: titles[run.id] ?? titleOf(run),
        group,
        attention,
        latest: items.at(-1),
        unread,
        question,
        approval,
      };
    })
    .toSorted((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
}

/** How many children wait on the user, as the orchestrator tab's header and its badge count them. */
export const waitingCount = (
  orchestrator: Orchestrator,
  agents: OrchestratorAgentsView,
  inbox: InboxView,
) => rowsOf(orchestrator, agents, inbox, false, {}).filter((r) => r.group === "waiting").length;

/** What a child last reported, without its title, which plxd's text leads with. */
function subjectOf(row: Row): string | undefined {
  if (row.question && row.question.status !== "answered") return row.question.question;
  if (row.approval) {
    const input = row.approval.request.input;
    const command =
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      typeof input["command"] === "string"
        ? input["command"]
        : undefined;
    return `Wants to run ${row.approval.request.toolName}${command ? `: ${command}` : ""}`;
  }
  const text = row.latest?.text;
  if (!text) return undefined;
  return text.startsWith(`${row.title}: `) ? text.slice(row.title.length + 2) : text;
}

/**
 * A run's branch, its diff, and its pull requests' numbers, as its row's second line. Nothing for
 * a run with none of them.
 */
function facts(run: AgentRun): ReactNode {
  const { branch, diff, pullRequests = [] } = run;
  if (!branch && !diff && pullRequests.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {branch && (
        <span className="flex min-w-0 items-center gap-1">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {diff && (
        <span className="shrink-0 tabular-nums">
          <span className="text-diff-added">+{short(diff.insertions)}</span>{" "}
          <span className="text-diff-removed">−{short(diff.deletions)}</span>
        </span>
      )}
      {pullRequests.map((url) => (
        <span key={url} className="shrink-0 tabular-nums">
          #{url.split("/").at(-1)}
        </span>
      ))}
    </span>
  );
}

/**
 * A child that waits on the user: what it asks, wants to run, or failed on, and how long ago. A
 * question takes its answer in place.
 */
function WaitingRow({
  row,
  now,
  onOpen,
  onAnswer,
}: {
  row: Row;
  now: number;
  onOpen: () => void;
  onAnswer: (text: string) => Promise<string | undefined>;
}) {
  const failed = row.attention === "failed";
  const asking = row.question && row.question.status !== "answered";
  return (
    <li>
      <ChildButton
        icon={
          failed ? (
            <CircleAlert className="text-danger" />
          ) : row.approval && !asking ? (
            <ShieldQuestion className="text-warning" />
          ) : (
            <MessageCircleQuestion className="text-warning" />
          )
        }
        title={plainTitle(row.title)}
        state={failed ? "Failed" : "Needs you"}
        detail={asking ? undefined : subjectOf(row)}
        end={age(row.latest?.createdAt ?? row.run.updatedAt, now)}
        onOpen={onOpen}
      />
      {asking && row.question && (
        <QuestionBox
          question={row.question.question}
          assumption={row.question.assumption || undefined}
          onAnswer={onAnswer}
        />
      )}
    </li>
  );
}

/**
 * A finished child: its check or alert, its title, its branch and diff, and when it finished.
 * Bright while what it reported is unread; dim once read.
 */
function FinishedRow({ row, now, onOpen }: { row: Row; now: number; onOpen: () => void }) {
  const unread = row.group === "ready";
  const failed = row.attention === "failed";
  return (
    <li>
      <ChildButton
        icon={
          failed ? (
            <CircleAlert className={unread ? "text-danger" : "text-danger/50"} />
          ) : (
            <CircleCheck className={unread ? "text-added" : "text-faint-foreground/60"} />
          )
        }
        title={plainTitle(row.title)}
        dim={!unread}
        state={failed ? "Failed" : "Done"}
        detail={facts(row.run)}
        end={finished(row.run.updatedAt, now)}
        onOpen={onOpen}
      />
    </li>
  );
}

/**
 * A child's row: its state's icon, its title, a line under it, and a time at its end, which gives
 * way on hover to the arrow that says the row opens its chat. Screen readers hear `state` after
 * the title in place of the icon.
 */
function ChildButton({
  icon,
  title,
  dim = false,
  state,
  detail,
  end,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  dim?: boolean;
  state: string;
  detail?: ReactNode;
  end: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left hover:bg-hover"
    >
      <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          data-title
          className={`block truncate text-body leading-5 font-medium ${dim ? "text-muted-foreground" : "text-foreground"}`}
        >
          {title}
        </span>
        <span className="sr-only">{state}</span>
        {detail && (
          <span className="block truncate text-meta leading-5 text-muted-foreground">{detail}</span>
        )}
      </span>
      <span className="relative shrink-0 pt-0.5 text-meta text-faint-foreground tabular-nums">
        <span
          aria-hidden
          className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0 motion-reduce:transition-none"
        >
          {end}
        </span>
        <span className="absolute inset-0 flex items-center justify-end">
          <OpenHint />
        </span>
      </span>
    </button>
  );
}

/**
 * A child's question, answered in place: the question, a button that keeps what the child went
 * with, and a box for any other answer.
 */
function QuestionBox({
  question,
  assumption,
  onAnswer,
}: {
  question: string;
  assumption?: string;
  onAnswer: (text: string) => Promise<string | undefined>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    const failed = await onAnswer(answer.trim());
    setBusy(false);
    if (failed) notify({ tone: "error", title: "Couldn't send your answer", body: failed });
    else setText("");
  };
  return (
    <div className="mr-3 mb-3 ml-10 overflow-hidden rounded-lg border border-border bg-background">
      <p className="px-3 pt-2.5 pb-2 text-body leading-snug text-foreground">{question}</p>
      <div className="flex flex-col border-t border-border">
        {assumption && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(assumption)}
            className="flex w-full items-baseline gap-3 border-b border-border px-3 py-2 text-left text-body hover:bg-hover disabled:opacity-50"
          >
            <span className="min-w-0 flex-1">{assumption}</span>
            <span className="shrink-0 text-meta text-muted-foreground">Keep its pick</span>
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
          className="flex items-center gap-2 py-1 pr-1.5 pl-3"
        >
          <input
            aria-label={`Answer: ${question}`}
            placeholder={assumption ? "Or answer something else" : "Your answer"}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            className="h-7 min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            aria-label="Send answer"
            disabled={busy || !text.trim()}
            className="send-sky grid size-6 shrink-0 place-items-center rounded-full bg-send text-send-foreground disabled:bg-selected disabled:text-faint-foreground"
          >
            {busy ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
