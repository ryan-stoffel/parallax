import { ArrowUp, LoaderCircle } from "lucide-react";
import { useState, type CSSProperties } from "react";

import type { AgentRun, InboxItem, Project, Question } from "../protocol/generated/protocol";
import { runAttention, type Attention } from "./attention";
import { questionOf, type InboxView } from "./Inbox";
import { locale } from "./locale";
import { notify } from "./notifications";
import { OpenHint } from "./OpenHint";
import { clockOptions } from "./prefs";
import type { ProjectAgentsView } from "./ProjectAgents";
import { age, ProjectIcon } from "./Sidebar";
import { titleOf } from "./threads";
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

const dayMs = 24 * 60 * 60 * 1000;

/**
 * A Project's home in the side panel, read like a log. Its head is the Project and a sentence on
 * where it stands. Under it, Now: the children working or waiting on the user, each with what it
 * last said, a question taking its answer in place. Then the log: each finished child once, newest
 * first, under its day, with the time it finished, its mark, and its diff. A finish is bright
 * until it's opened, which marks what it reported read (0043).
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
  const rows = rowsOf(project, agents, inbox, answerable, titles);
  const live = rows.filter((r) => r.group === "working" || r.group === "waiting");
  const log = rows.filter((r) => r.group === "ready" || r.group === "resolved");
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
      <header className="px-2.5 pt-5 pb-3">
        <h2 className="flex items-center gap-2 font-brand text-[18px] leading-tight font-semibold tracking-tight">
          <ProjectIcon icon={project.icon} className="size-[18px] shrink-0" />
          <span className="truncate">{project.name}</span>
        </h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground">{standing(rows)}</p>
      </header>
      {live.length > 0 && (
        <section aria-label="Now">
          <h3 className={dayHeading}>Now</h3>
          <ul>
            {live.map((row) => (
              <LiveRow key={row.run.id} row={row} onOpen={() => open(row)} onAnswer={answer(row)} />
            ))}
          </ul>
        </section>
      )}
      {daysOf(log).map(({ label, rows }) => (
        <section key={label} aria-label={label}>
          <h3 className={dayHeading}>{label}</h3>
          <ul>
            {rows.map((row) => (
              <LogRow key={row.run.id} row={row} onOpen={() => open(row)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const dayHeading = "px-2.5 pt-5 pb-1 text-[12px] text-faint-foreground";

/**
 * Where the Project stands, in a sentence or two: who works and who waits on the user, else All
 * quiet; then how many finished in the last week.
 */
export function standing(rows: readonly Pick<Row, "group" | "run">[], now = Date.now()): string {
  const working = rows.filter((r) => r.group === "working").length;
  const waiting = rows.filter((r) => r.group === "waiting").length;
  const done = rows.filter(
    (r) =>
      (r.group === "ready" || r.group === "resolved") &&
      now - Date.parse(r.run.updatedAt) < 7 * dayMs,
  ).length;
  const live = [
    working > 0 && `${working} ${working === 1 ? "agent" : "agents"} working`,
    waiting > 0 && `${waiting} ${waiting === 1 ? "needs" : "need"} you`,
  ].filter(Boolean);
  const first = live.length ? `${live.join(", ")}.` : "All quiet.";
  return done > 0 ? `${first} ${done} done this week.` : first;
}

/** Finished rows under their day, Today, Yesterday, or the date, newest first. */
function daysOf(rows: readonly Row[]): { label: string; rows: Row[] }[] {
  const days: { label: string; rows: Row[] }[] = [];
  for (const row of rows.toSorted((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt))) {
    const label = dayLabel(Date.parse(row.run.updatedAt));
    if (days.at(-1)?.label === label) days.at(-1)!.rows.push(row);
    else days.push({ label, rows: [row] });
  }
  return days;
}

/** Today, Yesterday, or the date, such as "Mon, Oct 20", of `at`. */
export function dayLabel(at: number, now = Date.now()): string {
  const start = new Date(now).setHours(0, 0, 0, 0);
  if (at >= start) return "Today";
  if (at >= start - dayMs) return "Yesterday";
  return new Date(at).toLocaleDateString(locale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** 1234 as "1.2k", for a diff's counts in a row. */
const short = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`);

/**
 * A title without a Conventional Commit prefix, which plxd's thread titles often lead with: "fix(GH-27):
 * x" reads "x". Any other title is left as it is.
 */
export const plainTitle = (title: string) =>
  /^(?:feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert)(?:\([^)]+\))?!?: +(\S.*)$/.exec(
    title,
  )?.[1] ?? title;

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

/**
 * A child that works or waits on the user: its mark, its title, and what it last said; or, waiting,
 * Needs you, and its question to answer in place.
 */
function LiveRow({
  row,
  onOpen,
  onAnswer,
}: {
  row: Row;
  onOpen: () => void;
  onAnswer: (text: string) => Promise<string | undefined>;
}) {
  const waiting = row.group === "waiting";
  const failed = row.attention === "failed";
  const asking = row.question && row.question.status !== "answered";
  const said = asking ? undefined : subjectOf(row);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
      >
        <span aria-hidden className="mt-[5px] grid size-2.5 shrink-0 [&_svg]:size-2.5">
          <Pixel state={waiting ? (failed ? "failed" : "waiting") : "working"} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span data-title className="truncate text-[13.5px] leading-5 text-foreground">
            {plainTitle(row.title)}
          </span>
          {said && (
            <span className="line-clamp-2 text-[12px] leading-snug text-faint-foreground">
              {said}
            </span>
          )}
        </span>
        <span className="relative shrink-0 pt-0.5 text-[11px]">
          <span
            className={`transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0 ${waiting ? (failed ? "text-danger" : "text-warning") : "font-mono text-faint-foreground tabular-nums"}`}
          >
            {waiting
              ? failed
                ? "Failed"
                : "Needs you"
              : age(row.latest?.createdAt ?? row.run.updatedAt)}
          </span>
          <span className="absolute inset-0 flex items-center justify-end">
            <OpenHint />
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

/**
 * A finished child in the log: its mark, its title, its diff, and when it finished. Bright while
 * what it reported is unread; dim once read.
 */
function LogRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const unread = row.group === "ready";
  const failed = row.attention === "failed";
  const diff = row.run.diff;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
      >
        <span aria-hidden className="grid size-2.5 shrink-0 [&_svg]:size-2.5">
          <Pixel state={failed ? "failed" : unread ? "done" : "read"} />
        </span>
        <span
          data-title
          className={`min-w-0 flex-1 truncate text-[13px] ${unread ? "text-foreground" : "text-muted-foreground"}`}
        >
          {plainTitle(row.title)}
        </span>
        <span className="sr-only">{failed ? "Failed" : "Done"}</span>
        <span className="relative flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint-foreground tabular-nums">
          <span className="flex gap-2 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
            {diff && (
              <span>
                <span className="text-added/70">+{short(diff.insertions)}</span>{" "}
                <span className="text-danger/70">−{short(diff.deletions)}</span>
              </span>
            )}
            <span aria-hidden>
              {new Date(row.run.updatedAt).toLocaleTimeString(locale(), clockOptions())}
            </span>
          </span>
          <span className="absolute inset-0 flex items-center justify-end">
            <OpenHint />
          </span>
        </span>
      </button>
    </li>
  );
}

const pixelColors = {
  working: "text-accent",
  waiting: "text-warning",
  failed: "text-danger",
  done: "text-added",
  read: "text-foreground/30",
};

/**
 * A state as a 3×3 pixel glyph, like a dot-matrix display: lit in a wave while working, a
 * checkerboard while it waits or failed, and full once done. Screen readers skip it.
 */
function Pixel({ state }: { state: keyof typeof pixelColors }) {
  const checker = state === "waiting" || state === "failed";
  return (
    <svg viewBox="0 0 8 8" className={`pixel pixel-${state} ${pixelColors[state]}`}>
      {Array.from({ length: 9 }, (_, i) => {
        const [x, y] = [i % 3, Math.floor(i / 3)];
        return (
          <rect
            key={i}
            x={x * 3}
            y={y * 3}
            width="2"
            height="2"
            rx="0.4"
            fill="currentColor"
            opacity={checker && i % 2 === 1 ? 0.2 : 1}
            // The working wave runs corner to corner.
            style={{ "--i": x + y } as CSSProperties}
          />
        );
      })}
    </svg>
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
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    const failed = await onAnswer(answer.trim());
    setBusy(false);
    if (failed) notify({ tone: "error", title: "Couldn't send your answer", body: failed });
    else setText("");
  };
  return (
    <div className="mr-2.5 mb-2 ml-[34px] overflow-hidden rounded-xl border border-border bg-surface">
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
            className="send-sky grid size-6 shrink-0 place-items-center rounded-full bg-send text-send-foreground disabled:opacity-25"
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
