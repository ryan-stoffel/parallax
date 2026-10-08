import { ArrowUp, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { AgentRun, InboxItem, Project, Question } from "../protocol/generated/protocol";
import { runAttention, type Attention } from "./attention";
import { DoneMark } from "./AttentionMark";
import { questionOf, type InboxView } from "./Inbox";
import { Loader } from "./Loader";
import { locale } from "./locale";
import { OpenHint } from "./OpenHint";
import type { ProjectAgentsView } from "./ProjectAgents";
import { instanceLogo } from "./providers";
import { age, backendLogos, ProjectIcon } from "./Sidebar";
import { titleOf } from "./threads";
import type { Approval } from "./transcript";
import { clockOptions } from "./prefs";

type Group = "waiting" | "working" | "ready" | "resolved";

const groups: { key: Group; label: string; empty?: string }[] = [
  { key: "waiting", label: "Waiting on you", empty: "Questions, failures, and approvals." },
  { key: "working", label: "Working" },
  { key: "ready", label: "Done" },
  { key: "resolved", label: "Resolved" },
];

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
 * A Project's home in the side panel, built as Claude's and Cursor's Projects are: the Project and
 * a line on where it stands, then each child once, grouped Waiting on you, Working, Done, and
 * Resolved (folded). A child's row is its title and what it last reported, from the inbox (0043),
 * which this view stands in for: a question takes its answer in place, and opening a child marks
 * what it reported read. A child is Done while its finish is unread, and Resolved once read.
 */
export function ProjectHome({
  project,
  agents,
  titles = {},
  inbox,
  answerable,
  onOpen,
}: {
  project: Project;
  agents: ProjectAgentsView;
  titles?: Readonly<Record<string, string>>;
  inbox: InboxView;
  answerable: boolean;
  onOpen: (runId: string) => void;
}) {
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const rows = rowsOf(project, agents, inbox, answerable, titles);
  const of = (g: Group) => rows.filter((r) => r.group === g);
  const waiting = of("waiting").length;
  const working = of("working").length;
  const open = (row: Row) => {
    onOpen(row.run.id);
    const read = row.unread.filter((i) => i.kind !== "needsYou").map((i) => i.id);
    if (read.length) void inbox.seen(read);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <header className="relative flex items-start gap-3 px-2.5 pt-4 pb-5">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2.5 font-mono text-[17px] tracking-tight">
            <ProjectIcon icon={project.icon} className="size-5" />
            <span className="truncate">{project.name}</span>
          </h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {waiting > 0
              ? `${waiting} ${waiting === 1 ? "thing is" : "things are"} waiting on you.`
              : "Nothing is waiting on you."}
            {working > 0 && ` ${working} working.`}
          </p>
        </div>
        <Activity runs={rows.map((r) => r.run)} items={inbox.items} />
      </header>
      {groups.map((g) => {
        const list = of(g.key);
        if (list.length === 0 && !g.empty) return null;
        const folded = g.key === "resolved" && !resolvedOpen;
        return (
          <section key={g.key} aria-label={g.label} className="mb-1.5">
            <h3>
              <button
                type="button"
                disabled={g.key !== "resolved"}
                aria-expanded={g.key === "resolved" ? resolvedOpen : undefined}
                onClick={() => setResolvedOpen(!resolvedOpen)}
                className="flex w-full items-center gap-2 rounded-lg bg-selected/60 px-2.5 py-1.5 text-left text-[13px] text-foreground/85 enabled:hover:bg-selected"
              >
                {g.key === "resolved" && (
                  <ChevronRight
                    aria-hidden
                    className={`size-3.5 text-faint-foreground transition-transform ${resolvedOpen ? "rotate-90" : ""}`}
                  />
                )}
                {g.label}
                <span className="font-mono text-[11.5px] text-faint-foreground tabular-nums">
                  {list.length}
                </span>
                {g.key === "waiting" && list.length > 0 && (
                  <span aria-hidden className="ml-auto size-1.5 rounded-full bg-warning" />
                )}
              </button>
            </h3>
            {list.length === 0 ? (
              <p className="px-2.5 pt-2 pb-1 text-[12.5px] text-faint-foreground">{g.empty}</p>
            ) : (
              !folded && (
                <ul className="pt-1">
                  {list.map((row) => (
                    <ChildRow
                      key={row.run.id}
                      row={row}
                      onOpen={() => open(row)}
                      onAnswer={(text) =>
                        row.question
                          ? inbox.answer(
                              row.unread.find((i) => i.kind === "needsYou")!,
                              row.question,
                              text,
                            )
                          : Promise.resolve(undefined)
                      }
                    />
                  ))}
                </ul>
              )
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Each child of `project` once, newest first, with its group on the Project tab: Waiting on you
 * (a question, an approval, or an unread failure), Working, Done (unread news), or Resolved.
 */
function rowsOf(
  project: Project,
  agents: ProjectAgentsView,
  inbox: InboxView,
  answerable: boolean,
  titles: Readonly<Record<string, string>>,
): Row[] {
  return agents.runs
    .filter((r) => r.id !== project.coordinator && r.policy !== "noWrite")
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

/** How many children wait on the user, as the Project tab's header and its badge count them. */
export const waitingCount = (project: Project, agents: ProjectAgentsView, inbox: InboxView) =>
  rowsOf(project, agents, inbox, false, {}).filter((r) => r.group === "waiting").length;

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

function ChildRow({
  row,
  onOpen,
  onAnswer,
}: {
  row: Row;
  onOpen: () => void;
  onAnswer: (text: string) => Promise<string | undefined>;
}) {
  const Logo = backendLogos[row.run.backend] ?? instanceLogo(row.run.backend);
  const unread = row.unread.length > 0;
  const asking = row.question && row.question.status !== "answered";
  const subject = subjectOf(row);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={`truncate text-[13.5px] ${unread || row.group === "working" ? "text-foreground" : "text-muted-foreground"}`}
          >
            {row.title}
          </span>
          {!asking && (
            <span className="line-clamp-2 text-[12.5px] leading-snug text-faint-foreground">
              {row.group === "working" && !subject ? (
                <span className="flex items-center gap-1.5 text-working">
                  <Loader kind="matrix" variant="ripple" size={11} />
                  Working
                </span>
              ) : (
                (subject ??
                (row.attention === "failed" ? (
                  "Failed"
                ) : (
                  <span className="flex items-center gap-1.5 text-added [&_svg]:size-3">
                    <DoneMark animate={false} />
                    Done
                  </span>
                )))
              )}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          {row.run.diff && row.group === "waiting" && (
            <span className="font-mono text-[11px] tabular-nums">
              <span className="text-added">+{row.run.diff.insertions}</span>{" "}
              <span className="text-danger">−{row.run.diff.deletions}</span>
            </span>
          )}
          <span className="flex items-center gap-1.5 [&_svg]:size-3.5">
            {Logo && <Logo aria-hidden />}
            <Mark row={row} unread={unread} />
          </span>
          {/* The age gives way to an arrow on hover: the row opens that chat. */}
          <span className="relative grid w-7 place-items-end">
            <span className="font-mono text-[11px] text-faint-foreground tabular-nums transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
              {age(row.latest?.createdAt ?? row.run.updatedAt)}
            </span>
            <span className="absolute inset-0 flex items-center justify-end">
              <OpenHint />
            </span>
          </span>
        </span>
      </button>
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

/** A row's state beside its provider: working, waiting, failed, done, or done and read. */
function Mark({ row, unread }: { row: Row; unread: boolean }) {
  if (row.group === "working") return <Loader kind="matrix" variant="scan" size={11} />;
  if (row.group === "waiting")
    return row.attention === "failed" ? (
      <CircleAlert aria-label="Failed" className="text-danger" />
    ) : (
      <span aria-label="Waiting on you" className="grid size-3.5 place-items-center">
        <span className="size-1.5 rounded-full bg-warning" />
      </span>
    );
  return (
    <span aria-label="Done" className={unread ? "text-added" : "text-faint-foreground"}>
      <DoneMark animate={false} />
    </span>
  );
}

/**
 * A child's question, answered in place as an app asks one: the question, what the child went
 * with as the first choice, and a box for any other answer. Picking the choice sends it.
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
  const [error, setError] = useState<string>();
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    const failed = await onAnswer(answer.trim());
    setBusy(false);
    setError(failed);
    if (!failed) setText("");
  };
  return (
    <div className="mx-2.5 mb-2 overflow-hidden rounded-xl border border-border bg-surface">
      <p className="px-3.5 pt-3 pb-2.5 text-[13px] leading-snug text-foreground">{question}</p>
      <div className="flex flex-col gap-1 px-1.5 pb-1.5">
        {assumption && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(assumption)}
            className="group/choice flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-hover disabled:opacity-50"
          >
            <span className="grid size-5 shrink-0 place-items-center rounded-md border border-border font-mono text-[10.5px] text-muted-foreground group-hover/choice:border-foreground/25 group-hover/choice:text-foreground">
              1
            </span>
            <span className="min-w-0 flex-1">{assumption}</span>
            <span className="shrink-0 text-[11.5px] text-faint-foreground">Its pick so far</span>
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
          className="flex items-center gap-2.5 rounded-lg px-2 py-1 focus-within:bg-hover"
        >
          <span className="grid size-5 shrink-0 place-items-center rounded-md border border-border font-mono text-[10.5px] text-muted-foreground">
            {assumption ? 2 : 1}
          </span>
          <input
            aria-label={`Answer: ${question}`}
            placeholder={assumption ? "Something else" : "Your answer"}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] placeholder:text-faint-foreground focus-visible:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            aria-label="Send answer"
            disabled={busy || !text.trim()}
            className="grid size-6 shrink-0 place-items-center rounded-full bg-send text-send-foreground disabled:opacity-25"
          >
            {busy ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </button>
        </form>
      </div>
      {error && (
        <p role="alert" className="px-3.5 pb-2.5 text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// The activity chart's span and columns: the last three hours, ten minutes a column.
const columns = 18;
const columnMs = 10 * 60 * 1000;
const rows = 5;

const clock = (at: number) => new Date(at).toLocaleTimeString(locale(), clockOptions());

/**
 * The Project's pulse as a dot matrix: a column every ten minutes over the last three hours, lit
 * as high as how many agents started and reported then. Hovering a column says when and what.
 */
function Activity({ runs, items }: { runs: readonly AgentRun[]; items: readonly InboxItem[] }) {
  const [hover, setHover] = useState<number>();
  const now = Date.now();
  const started = Array.from({ length: columns }, () => 0);
  const reported = Array.from({ length: columns }, () => 0);
  const add = (counts: number[], at: string) => {
    const back = Math.floor((now - Date.parse(at)) / columnMs);
    if (back >= 0 && back < columns) counts[columns - 1 - back]! += 1;
  };
  for (const r of runs) add(started, r.createdAt);
  for (const i of items) add(reported, i.createdAt);
  const total = started.map((n, c) => n + reported[c]!);
  const most = Math.max(1, ...total);
  const label = (c: number) => {
    const end = now - (columns - 1 - c) * columnMs;
    const parts = [
      started[c] && `${started[c]} started`,
      reported[c] && `${reported[c]} ${reported[c] === 1 ? "update" : "updates"}`,
    ].filter(Boolean);
    return `${c === columns - 1 ? "Now" : clock(end - columnMs)}: ${parts.length ? parts.join(", ") : "quiet"}`;
  };
  return (
    <figure className="relative shrink-0 pt-0.5" onMouseLeave={() => setHover(undefined)}>
      <div className="grid grid-flow-col grid-rows-5 gap-[3px]">
        {total.flatMap((n, c) => {
          const lit = n === 0 ? 0 : Math.max(1, Math.round((n / most) * rows));
          return Array.from({ length: rows }, (_, r) => (
            <span
              key={`${c}/${r}`}
              onMouseEnter={() => setHover(c)}
              className={`size-[4px] rounded-[1px] transition-opacity ${hover !== undefined && hover !== c ? "opacity-40" : ""} ${rows - r <= lit ? (c === columns - 1 ? "bg-accent" : "bg-foreground/50") : "bg-foreground/10"}`}
            />
          ));
        })}
      </div>
      <figcaption className="absolute top-full right-0 mt-1.5 whitespace-nowrap font-mono text-[10.5px] text-faint-foreground tabular-nums">
        {hover === undefined ? "Last 3 hours" : label(hover)}
      </figcaption>
    </figure>
  );
}
