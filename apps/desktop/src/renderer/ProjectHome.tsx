import {
  ArrowUp,
  BookOpen,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  MessageCircleQuestion,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { AgentRun, InboxItem, Project, Question } from "../protocol/generated/protocol";
import { runAttention, type Attention } from "./attention";
import { WorkingMark } from "./AttentionMark";
import { AllFiles, board, ContextBody, ContextReader, type ProjectContext } from "./ContextPanel";
import { questionOf, type InboxView } from "./Inbox";
import { dayLabel, locale } from "./locale";
import { notify } from "./notifications";
import { OpenHint } from "./OpenHint";
import { clockOptions } from "./prefs";
import type { ProjectAgentsView } from "./ProjectAgents";
import { age, ProjectIcon } from "./Sidebar";
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

const dayMs = 24 * 60 * 60 * 1000;

/**
 * A Project's home in the side panel, set like Cursor's project page. Its head is the Project's
 * icon, name, and how many of its threads are open, a chip for each open state, and a book that
 * opens All files, its context folder as a tree. Then where it stands: the coordinator's status
 * board, its tasks as circles and its pull requests, issues, and other files linked. Then Running:
 * the children working or waiting on the user, each with what it last said, a question taking its
 * answer in place. Then the log: each finished child once, newest first, under its day, with its
 * diff and the time it finished. A finish is bright until it's opened, which marks what it reported
 * read (0043).
 */
export function ProjectHome({
  hostId,
  context,
  project,
  agents,
  titles = {},
  inbox,
  answerable,
  onOpen,
}: {
  hostId: string;
  /** The Project's context files: its status board, and all of them behind the book. */
  context: ProjectContext;
  project: Project;
  agents: ProjectAgentsView;
  titles?: Readonly<Record<string, string>>;
  inbox: InboxView;
  answerable: boolean;
  onOpen: (runId: string) => void;
}) {
  const [openPath, setOpenPath] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
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

  const { files, error } = context;
  const opened = files.find((f) => f.path === openPath);
  const notes = files.find((f) => f.path === board);

  if (opened)
    return (
      <ContextReader
        hostId={hostId}
        project={project.id}
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
          className="mx-2 flex min-w-0 items-center gap-1 self-start rounded-lg py-1 pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <h3 className={`${sectionHeading} px-2.5`}>All files</h3>
          <AllFiles files={files} onOpen={setOpenPath} />
        </div>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
      <header className="flex items-center gap-3 px-1 pt-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface">
          <ProjectIcon icon={project.icon} className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-brand text-[19px] leading-tight font-semibold tracking-tight">
            {project.name}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{openLine(rows)}</p>
        </div>
        {files.length > 0 && (
          <span className="ml-auto self-start">
            <IconButton label="All files" onClick={() => setBrowsing(true)}>
              <BookOpen />
            </IconButton>
          </span>
        )}
      </header>
      <OpenCounts rows={rows} />
      <section aria-label="Where it stands" className="px-1">
        {notes ? (
          <ContextBody
            hostId={hostId}
            project={project.id}
            files={files}
            file={notes}
            onOpen={setOpenPath}
          />
        ) : (
          <p className="pt-5 text-[12.5px] text-muted-foreground">
            The coordinator keeps a status board here once it starts on the work.
          </p>
        )}
        {error && (
          <p role="alert" className="pt-1.5 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </section>
      {live.length > 0 && (
        <section aria-label="Running">
          <h3 className={sectionHeading}>Running</h3>
          <ul className={group}>
            {live.map((row) => (
              <LiveRow key={row.run.id} row={row} onOpen={() => open(row)} onAnswer={answer(row)} />
            ))}
          </ul>
        </section>
      )}
      {daysOf(log).map(({ label, rows }) => (
        <section key={label} aria-label={label}>
          <h3 className={sectionHeading}>{label}</h3>
          <ul className={group}>
            {rows.map((row) => (
              <LogRow key={row.run.id} row={row} onOpen={() => open(row)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// A section's heading, and its rows grouped in one rounded list with hairlines between them.
const sectionHeading =
  "px-1 pt-6 pb-2 text-[11px] font-medium tracking-[0.08em] text-faint-foreground uppercase";
const group = "divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface";

/**
 * How many of a Project's threads are open, working, waiting, or done but unread, and how many
 * finished in the last week.
 */
export function openLine(rows: readonly Pick<Row, "group" | "run">[], now = Date.now()): string {
  const open = rows.filter((r) => r.group !== "resolved").length;
  const done = rows.filter(
    (r) =>
      (r.group === "ready" || r.group === "resolved") &&
      now - Date.parse(r.run.updatedAt) < 7 * dayMs,
  ).length;
  const first = open > 0 ? `${open} open ${open === 1 ? "thread" : "threads"}` : "No open threads";
  return done > 0 ? `${first} · ${done} done this week` : first;
}

/**
 * The open threads by state, as a row of chips under the head, each with its rows' icon: working,
 * needing the user, and done but unread. Only states with threads show.
 */
function OpenCounts({ rows }: { rows: readonly Row[] }) {
  const count = (g: Group) => rows.filter((r) => r.group === g).length;
  const chips = [
    { label: "working", n: count("working"), icon: <WorkingMark /> },
    {
      label: count("waiting") === 1 ? "needs you" : "need you",
      n: count("waiting"),
      icon: <MessageCircleQuestion className="text-warning" />,
    },
    { label: "to review", n: count("ready"), icon: <CircleCheck className="text-added" /> },
  ].filter((c) => c.n > 0);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Open threads" className="mt-3 flex flex-wrap gap-1.5 px-1">
      {chips.map((c) => (
        <li
          key={c.label}
          className="flex h-6 items-center gap-1.5 rounded-full border border-border bg-surface pr-2.5 pl-2 text-[12px] text-muted-foreground [&_svg]:size-3.5"
        >
          <span aria-hidden className="grid">
            {c.icon}
          </span>
          <span className="font-medium text-foreground tabular-nums">{c.n}</span>
          {c.label}
        </li>
      ))}
    </ul>
  );
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
 * Each child of `project` once, newest first, with its group: waiting on the user (a question, an
 * approval, or an unread failure) or working, which the Project tab shows in Running; or finished,
 * ready while its news is unread and resolved once read, which it shows in the log.
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
  const state = waiting ? (failed ? "Failed" : "Needs you") : "Working";
  return (
    <li>
      <ChildButton
        icon={
          !waiting ? (
            <WorkingMark />
          ) : failed ? (
            <CircleAlert className="text-danger" />
          ) : (
            <MessageCircleQuestion className="text-warning" />
          )
        }
        title={plainTitle(row.title)}
        state={state}
        detail={asking ? undefined : subjectOf(row)}
        end={
          waiting ? (
            <span className={failed ? "text-danger" : "text-warning"}>{state}</span>
          ) : (
            <span className="font-mono tabular-nums">
              {age(row.latest?.createdAt ?? row.run.updatedAt)}
            </span>
          )
        }
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
 * A finished child in the log: its check, its title, its diff, and when it finished. Bright while
 * what it reported is unread; dim once read.
 */
function LogRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const unread = row.group === "ready";
  const failed = row.attention === "failed";
  const diff = row.run.diff;
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
        detail={
          diff
            ? `${diff.files} ${diff.files === 1 ? "file" : "files"}, +${short(diff.insertions)} −${short(diff.deletions)}`
            : failed
              ? "Failed"
              : undefined
        }
        end={
          <span aria-hidden className="font-mono tabular-nums">
            {new Date(row.run.updatedAt).toLocaleTimeString(locale(), clockOptions())}
          </span>
        }
        onOpen={onOpen}
      />
    </li>
  );
}

/**
 * A child's row: its state's icon, its title, a line under it, and one thing at its end, which
 * gives way on hover to the arrow that says the row opens its chat. Screen readers hear `state`
 * after the title in place of the icon.
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
  detail?: string;
  end: ReactNode;
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
          className={`block truncate text-[13.5px] leading-5 font-medium ${dim ? "text-muted-foreground" : "text-foreground"}`}
        >
          {title}
        </span>
        <span className="sr-only">{state}</span>
        {detail && (
          <span className="block truncate text-[12px] leading-5 text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      <span className="relative shrink-0 pt-0.5 text-[11.5px] text-faint-foreground">
        <span
          aria-hidden
          className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
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
    <div className="mr-3 mb-3 ml-10 overflow-hidden rounded-lg border border-border bg-background">
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
