import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { AgentRun, InboxItem, Project, Question } from "../protocol/generated/protocol";
import { runAttention, type Attention } from "./attention";
import { AnswerForm, questionOf, type InboxView } from "./Inbox";
import { Loader } from "./Loader";
import type { ProjectAgentsView } from "./ProjectAgents";
import { instanceLogo } from "./providers";
import { age, backendLogos, ProjectIcon } from "./Sidebar";
import { titleOf } from "./threads";
import type { Approval } from "./transcript";

type Group = "waiting" | "working" | "ready" | "resolved";

const groups: { key: Group; label: string; empty?: string }[] = [
  { key: "waiting", label: "Waiting on you", empty: "Questions, failures, and approvals." },
  { key: "working", label: "Working" },
  { key: "ready", label: "Ready" },
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
 * a line on where it stands, then each child once, grouped Waiting on you, Working, Ready, and
 * Resolved (folded). A child's row is its title and what it last reported, from the inbox (0043),
 * which this view stands in for: a question takes its answer in place, and opening a child marks
 * what it reported read. A child is Ready while its finish is unread, and Resolved once read.
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
  const rows: Row[] = agents.runs
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
  const subject = subjectOf(row);
  const unread = row.unread.length > 0;
  const asking = row.question && row.question.status !== "answered";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={`truncate text-[13.5px] ${unread || row.group === "working" ? "text-foreground" : "text-muted-foreground"}`}
          >
            {row.title}
          </span>
          <span className="line-clamp-2 text-[12.5px] leading-snug text-faint-foreground">
            {row.group === "working" && !subject ? (
              <span className="flex items-center gap-1.5 text-working">
                <Loader kind="matrix" variant="ripple" size={11} />
                Working
              </span>
            ) : (
              (subject ?? (row.attention === "failed" ? "Failed" : "Finished"))
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          {row.run.diff && row.group === "waiting" && (
            <span className="font-mono text-[11px] tabular-nums">
              <span className="text-added">+{row.run.diff.insertions}</span>{" "}
              <span className="text-danger">−{row.run.diff.deletions}</span>
            </span>
          )}
          <span className="flex h-5 items-center gap-1 rounded-full border border-border px-1.5 [&_svg]:size-3">
            {Logo && <Logo aria-hidden />}
            {row.group === "working" ? (
              <Loader kind="matrix" variant="scan" size={10} />
            ) : (
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${row.group === "waiting" ? (row.attention === "failed" ? "bg-danger" : "bg-warning") : unread ? "bg-accent" : "bg-foreground/20"}`}
              />
            )}
          </span>
          <span className="w-7 text-right font-mono text-[11px] text-faint-foreground tabular-nums">
            {age(row.latest?.createdAt ?? row.run.updatedAt)}
          </span>
        </span>
      </button>
      {asking && row.question && (
        <div className="px-2.5 pb-2">
          {row.question.assumption && (
            <p className="text-[12px] text-muted-foreground">
              Going with <span className="text-foreground">{row.question.assumption}</span> until
              you say otherwise.
            </p>
          )}
          <AnswerForm
            label="Answer"
            question={row.question.question}
            keep={row.question.assumption || undefined}
            onAnswer={onAnswer}
          />
        </div>
      )}
    </li>
  );
}

// The activity chart's span and columns: the last three hours, ten minutes a column.
const columns = 18;
const columnMs = 10 * 60 * 1000;
const rows = 5;

/**
 * The Project's pulse as a dot matrix: a column every ten minutes over the last three hours, lit
 * as high as how much its agents started and reported then. Decoration: the text says where it
 * stands.
 */
function Activity({ runs, items }: { runs: readonly AgentRun[]; items: readonly InboxItem[] }) {
  const now = Date.now();
  const counts = Array.from({ length: columns }, () => 0);
  const add = (at: string) => {
    const back = Math.floor((now - Date.parse(at)) / columnMs);
    if (back >= 0 && back < columns) counts[columns - 1 - back]! += 1;
  };
  for (const r of runs) add(r.createdAt);
  for (const i of items) add(i.createdAt);
  const most = Math.max(1, ...counts);
  return (
    <div aria-hidden className="grid shrink-0 grid-flow-col grid-rows-5 gap-[3px] pt-0.5">
      {counts.flatMap((n, c) => {
        const lit = n === 0 ? 0 : Math.max(1, Math.round((n / most) * rows));
        return Array.from({ length: rows }, (_, r) => (
          <span
            key={`${c}/${r}`}
            className={`size-[4px] rounded-[1px] ${rows - r <= lit ? (c === columns - 1 ? "bg-accent" : "bg-foreground/50") : "bg-foreground/10"}`}
          />
        ));
      })}
    </div>
  );
}
