import { MessagesSquare, ShieldQuestion, SquarePen } from "lucide-react";

import type { AgentRun, InboxItem, Project, Question } from "../protocol/generated/protocol";
import { childOrder, runAttention, type Attention } from "./attention";
import { useConnection } from "./ConnectionStatus";
import type { Host } from "./hosts";
import { AnswerForm, questionOf, useInbox, type InboxView } from "./Inbox";
import { useShortcutLabel } from "./keybindings";
import type { ProjectAgentsView } from "./ProjectAgents";
import { age, current, ProjectIcon, row, sectionHeading, statusLooks } from "./Sidebar";
import { titleOf } from "./threads";

const groupLabels: Partial<Record<Attention, string>> = {
  needsYou: "Needs you",
  working: "Working",
  done: "Done",
  failed: "Failed",
};

/** Whether a Needs you item's question still waits on the user. */
const waiting = (q?: Question) => q?.status === "open" || q?.status === "escalated";

/**
 * A Project's overview, the side panel's first view while it's open: the Project, New task, its
 * coordinator, then its agents grouped by what they ask of the user, each with its latest unread
 * inbox item (0043) under its title. The inbox lives here: a question waiting on the user is
 * answered in place, and opening an agent marks its news seen.
 */
export function ProjectOverview({
  host,
  project,
  agents,
  titles = {},
  openId,
  task,
  tasks,
  onOpen,
  onNewTask,
}: {
  host: Host;
  project: Project;
  agents: ProjectAgentsView;
  titles?: Readonly<Record<string, string>>;
  /** The open child, or absent for the coordinator. */
  openId?: string;
  /** Whether the New task page is open. */
  task: boolean;
  /** Whether the host's plxd starts tasks (`projectTasks`), which New task needs. */
  tasks: boolean;
  /** Opens a child's chat, or the coordinator's for none. */
  onOpen: (runId?: string) => void;
  onNewTask: () => void;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const answerable = connected && "questions" in connection.capabilities;
  const inbox = useInbox(
    host.id,
    project.id,
    connected && "inbox" in connection.capabilities,
    answerable,
  );
  const newTaskKeys = useShortcutLabel("projectTarget");
  const unread = inbox.items.filter((i) => !i.seenAt);
  const newsOf = (runId: string) => unread.filter((i) => i.run === runId);
  // A run's question waiting on the user, from its newest unread Needs you item.
  const askOf = (runId: string) => {
    const item = newsOf(runId).findLast((i) => i.kind === "needsYou");
    const question = item && answerable ? questionOf(item, inbox.questions) : undefined;
    return item && waiting(question) ? { item, question: question! } : undefined;
  };
  const attention = (run: AgentRun): Attention =>
    askOf(run.id) ? "needsYou" : runAttention(run, agents.waiting[run.id]?.length ?? 0);
  const children = agents.runs
    .filter((r) => r.policy !== "noWrite" && r.id !== project.coordinator)
    .toReversed();
  const open = (runId?: string) => {
    onOpen(runId);
    // Its news is read once it's open, except a question still waiting on an answer.
    const ask = runId && askOf(runId)?.item.id;
    const seen = newsOf(runId ?? project.coordinator ?? "")
      .filter((i) => i.id !== ask)
      .map((i) => i.id);
    if (seen.length > 0) void inbox.seen(seen);
  };
  const coordinatorRun = agents.runs.find((r) => r.id === project.coordinator);
  const coordinatorNews = project.coordinator ? newsOf(project.coordinator).at(-1) : undefined;
  const coordinatorLook = coordinatorRun && statusLooks[coordinatorRun.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-px px-2">
        <div className="flex items-center gap-2.5 px-2 pt-1 pb-3">
          <ProjectIcon icon={project.icon} className="size-6 shrink-0 [&_svg]:size-6" />
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-medium">{project.name}</h2>
            <p className="truncate text-[12px] text-faint-foreground" title={project.repoPath}>
              {project.repoPath.split(/[\\/]/).at(-1)}
              {project.branch && ` · ${project.branch}`}
            </p>
          </div>
        </div>
        {tasks && (
          <button
            type="button"
            aria-current={task ? "page" : undefined}
            onClick={onNewTask}
            className={`${row} mb-1 border border-border ${task ? current : "bg-surface"}`}
          >
            <SquarePen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">New task</span>
            {newTaskKeys && (
              <kbd className="font-sans text-[11.5px] text-faint-foreground">{newTaskKeys}</kbd>
            )}
          </button>
        )}
        <button
          type="button"
          aria-current={!task && !openId ? "page" : undefined}
          onClick={() => open(undefined)}
          className={`${row} flex-col items-stretch gap-0.5 ${!task && !openId ? current : ""}`}
        >
          <span className="flex items-center gap-2">
            <MessagesSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">Coordinator</span>
            {coordinatorLook && coordinatorRun && runAttention(coordinatorRun, 0) === "working" && (
              <coordinatorLook.Icon aria-hidden className={`size-3.5 ${coordinatorLook.color}`} />
            )}
            {coordinatorNews && <UnreadDot />}
          </span>
          {coordinatorNews && (
            <span className="line-clamp-2 pl-6 text-[12px] text-muted-foreground">
              {coordinatorNews.text}
            </span>
          )}
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className={`${sectionHeading} justify-between`}>
          <span>
            Agents {children.length > 0 && <span className="tabular-nums">{children.length}</span>}
          </span>
          {unread.length > 0 && (
            <button
              type="button"
              onClick={() =>
                void inbox.seen(
                  unread.filter((i) => !askOf(i.run) || i.kind !== "needsYou").map((i) => i.id),
                )
              }
              className="rounded px-1 text-[12px] font-normal text-faint-foreground hover:text-foreground"
            >
              Mark all read
            </button>
          )}
        </div>
        {children.length === 0 && (
          <p className="px-2 py-1 text-[12.5px] text-faint-foreground">
            {tasks
              ? "No agents yet. Start one with New task, or ask the coordinator to plan the work."
              : "No agents yet. The coordinator starts them as it splits the work."}
          </p>
        )}
        {childOrder.map((kind) => {
          const group = children.filter((r) => attention(r) === kind);
          if (group.length === 0) return null;
          return (
            <section key={kind} aria-label={groupLabels[kind]} className="mb-1.5">
              <h3 className="px-2 pt-1.5 pb-0.5 text-[11.5px] text-faint-foreground">
                {groupLabels[kind]}
              </h3>
              <ul className="flex flex-col gap-px">
                {group.map((run) => (
                  <AgentNavRow
                    key={run.id}
                    run={run}
                    title={titles[run.id] ?? titleOf(run)}
                    news={newsOf(run.id).at(-1)}
                    ask={askOf(run.id)}
                    approvals={agents.waiting[run.id]?.length ?? 0}
                    selected={!task && run.id === openId}
                    inbox={inbox}
                    onOpen={() => open(run.id)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const UnreadDot = () => (
  <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-accent" />
);

/**
 * A child in the Project sidebar: its status and title, then its latest unread news with plxd's
 * "<title>: " cut, or, while it waits on an answer, the question, what it went with, and a way to
 * keep that or answer differently.
 */
function AgentNavRow({
  run,
  title,
  news,
  ask,
  approvals,
  selected,
  inbox,
  onOpen,
}: {
  run: AgentRun;
  title: string;
  news?: InboxItem;
  ask?: { item: InboxItem; question: Question };
  approvals: number;
  selected: boolean;
  inbox: InboxView;
  onOpen: () => void;
}) {
  const look = statusLooks[run.status] ?? statusLooks.completed!;
  const prefix = `${title}: `;
  const subtitle =
    news && (news.text.startsWith(prefix) ? news.text.slice(prefix.length) : news.text);
  return (
    <li className={`rounded-md ${selected ? current : ""}`}>
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        title={title}
        className={`${row} flex-col items-stretch gap-0.5 ${selected ? "hover:bg-transparent" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {approvals > 0 || ask ? (
            <ShieldQuestion aria-hidden className="size-3.5 shrink-0 text-warning" />
          ) : (
            <look.Icon aria-hidden className={`size-3.5 shrink-0 ${look.color}`} />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {news ? (
            <UnreadDot />
          ) : (
            <span className="shrink-0 text-[11.5px] text-faint-foreground tabular-nums">
              {age(run.updatedAt)}
            </span>
          )}
        </span>
        {approvals > 0 && !ask && (
          <span className="pl-5.5 text-[12px] text-foreground/80">Waiting on your approval</span>
        )}
        {subtitle && !ask && (
          <span className="line-clamp-2 pl-5.5 text-[12px] text-muted-foreground">{subtitle}</span>
        )}
      </button>
      {ask && (
        <div className="pr-2 pb-2 pl-7.5">
          <p className="line-clamp-3 text-[12.5px] text-foreground">{ask.question.question}</p>
          {ask.question.assumption && (
            <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
              Going with <span className="text-foreground/85">{ask.question.assumption}</span>
            </p>
          )}
          <AnswerForm
            label="Answer"
            question={ask.question.question}
            keep={ask.question.assumption || undefined}
            onAnswer={(text) => inbox.answer(ask.item, ask.question, text)}
          />
        </div>
      )}
    </li>
  );
}
