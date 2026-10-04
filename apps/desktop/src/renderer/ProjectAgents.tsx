import { ArrowUp, GitBranch, LoaderCircle, ShieldQuestion, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentRun, ParallaxEvent } from "../protocol/generated/protocol";
import { childOrder, runAttention } from "./attention";
import { describeError } from "./errors";
import { instanceLogo, instanceName } from "./providers";
import { backendLogos, statusLooks } from "./Sidebar";
import { projectRuns, titleOf, waitingSince, type ThreadsState } from "./threads";
import {
  accountLabel,
  statusLabel,
  trackApprovals,
  updateRun,
  type Approval,
  type ApprovalsByRun,
} from "./transcript";
import { uuidv7 } from "./uuidv7";

/** A Project's runs, oldest first, kept live, and a way to start one by hand. */
export interface ProjectAgentsView {
  runs: AgentRun[];
  /** By run id: the permission requests each run waits on, oldest first (PLX-196). */
  waiting: Readonly<Record<string, readonly Approval[]>>;
  /** Why the list couldn't load or stopped updating, for people. */
  error?: string;
  /**
   * Starts a subagent on `prompt` with the worker's default account. Reuse `runId`, with the same
   * prompt, to retry. Resolves to an error message, or undefined.
   */
  start: (runId: string, prompt: string) => Promise<string | undefined>;
}

/** Applies one of a Project's events to its runs: a new run joins, and a changed one is replaced. */
export function applyAgentEvent(runs: AgentRun[], event: ParallaxEvent): AgentRun[] {
  if (!("runId" in event)) return runs;
  const i = runs.findIndex((r) => r.id === event.runId);
  const run = updateRun(runs[i], event);
  if (!run || run === runs[i]) return runs;
  return i < 0 ? [...runs, run] : runs.with(i, run);
}

/**
 * A Project's runs, coordinator included, kept live: `agent/list {project}`, then the Project's
 * events after its `seq`, starting over on `resync`. Empty with no Project, and loads only while
 * `connected`. The permission requests its runs wait on come from the same events, after each
 * running run's log is read once for those from before. With `approvals`, the host's plxd
 * advertises them, and a subagent started here forwards its requests (PLX-196, 0031).
 */
export function useProjectAgents(
  hostId: string,
  project: string | undefined,
  connected: boolean,
  approvals = false,
): ProjectAgentsView {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [asked, setAsked] = useState<ApprovalsByRun>({});
  const [error, setError] = useState<string>();
  // Another Project starts empty, rather than showing this one's runs until its list loads.
  const scope = `${hostId}/${project}`;
  const [shown, setShown] = useState(scope);
  if (shown !== scope) {
    setShown(scope);
    setRuns([]);
    setAsked({});
    setError(undefined);
  }
  // The scope shown now, so `start` drops a late answer from a Project the user has left.
  const current = useRef(scope);
  useEffect(() => {
    current.current = scope;
  }, [scope]);

  useEffect(() => {
    if (!connected || !project) return;
    let stopped = false;
    let unsubscribe = () => {};

    async function load() {
      const list = await window.parallax.request(hostId, "agent/list", { project });
      if (stopped) return;
      if ("error" in list) return setError(list.error.message);
      setRuns(list.result.runs);
      setError(undefined);
      // Requests from before the list are in the logs of runs that still go.
      const backlog = await waitingSince(hostId, list.result.runs, () => stopped);
      if (stopped) return;
      setAsked(trackApprovals({}, backlog));
      const since = { after: list.result.seq, project, logId: list.logId };
      unsubscribe = window.parallax.subscribe(hostId, since, (message) => {
        if (stopped) return;
        if (message.type === "resync") return void load();
        if (message.type === "error") return setError(message.error.message);
        setRuns((prev) => applyAgentEvent(prev, message.event.event));
        setAsked((prev) => trackApprovals(prev, [message.event]));
      });
    }

    void load();
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [hostId, project, connected]);

  const start = useCallback(
    async (runId: string, prompt: string) => {
      if (!project) return "No Project is open.";
      const answer = await window.parallax.request(hostId, "agent/start", {
        runId,
        project,
        prompt,
        policy: "workspaceWrite",
        ...(approvals && { approvals }),
      });
      if ("error" in answer) return describeError(answer.error);
      // Unless its agent.started got here first, with whatever followed it.
      const { run } = answer.result;
      if (current.current === `${hostId}/${project}`)
        setRuns((prev) => (prev.some((r) => r.id === run.id) ? prev : [...prev, run]));
      return undefined;
    },
    [hostId, project, approvals],
  );

  const waiting = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(asked).flatMap(([id, t]) =>
          t.items.length > 0 ? [[id, t.items as Approval[]]] : [],
        ),
      ),
    [asked],
  );

  return { runs, waiting, error, start };
}

/**
 * `agents` with Project `project`'s other runs in `state` (`projectRuns`), such as a child's own
 * children, which `agent/list {project}` doesn't list (0042), and what each waits on. Oldest first.
 */
export function withProjectThreads(
  agents: ProjectAgentsView,
  state: ThreadsState,
  project: string,
  inProject: ReadonlyMap<string, string>,
): ProjectAgentsView {
  const listed = new Set(agents.runs.map((r) => r.id));
  const more = projectRuns(state, project, inProject).filter((r) => !listed.has(r.id));
  if (more.length === 0) return agents;
  const waiting = { ...agents.waiting };
  for (const r of more) {
    const items = state.approvals[r.id]?.items;
    if (items?.length) waiting[r.id] = items as Approval[];
  }
  const runs = [...agents.runs, ...more].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ...agents, runs, waiting };
}

/**
 * The side panel's Agents view for a Project: the coordinator's children, without the coordinator
 * (0024), ordered Needs you, Working, Done, Failed, newest first within each (0042), each opening
 * its chat in place; then a box that starts one by hand.
 */
export function AgentsPanel({
  agents,
  titles = {},
  openId,
  onOpen,
  disabledReason,
}: {
  agents: ProjectAgentsView;
  /** By run id: a child's thread title from plxd (0041), over its prompt's. */
  titles?: Readonly<Record<string, string>>;
  /** The subagent whose chat is open. */
  openId?: string;
  onOpen: (runId: string) => void;
  /** Why starting one is off right now. */
  disabledReason?: string;
}) {
  const rank = (run: AgentRun) =>
    childOrder.indexOf(runAttention(run, agents.waiting[run.id]?.length ?? 0));
  const shown = agents.runs
    .filter((r) => r.policy !== "noWrite")
    .toReversed()
    .toSorted((a, b) => rank(a) - rank(b));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {shown.length > 0 ? (
        <ul aria-label="Agents" className="min-h-0 flex-1 overflow-y-auto px-2">
          {shown.map((run) => (
            <AgentRow
              key={run.id}
              run={run}
              title={titles[run.id] ?? titleOf(run)}
              asks={agents.waiting[run.id]?.length ?? 0}
              open={run.id === openId}
              onOpen={() => onOpen(run.id)}
            />
          ))}
        </ul>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
          <Workflow aria-hidden className="mb-1 size-5 text-faint-foreground" />
          <p className="text-[13px] font-medium text-foreground">No agents yet</p>
          <p className="text-[12.5px] text-muted-foreground">
            Subagents the coordinator starts show up here.
          </p>
        </div>
      )}
      {agents.error && (
        <p role="alert" className="px-4 pb-2 text-[12.5px] text-danger">
          {agents.error}
        </p>
      )}
      <StartAgent start={agents.start} disabledReason={disabledReason} />
    </div>
  );
}

/**
 * A subagent's row: status and title, who started it, then its branch, changes, and account. One
 * that waits on the user's approval (`asks`) says so in place of its status.
 */
function AgentRow({
  run,
  title,
  asks,
  open,
  onOpen,
}: {
  run: AgentRun;
  title: string;
  asks: number;
  open: boolean;
  onOpen: () => void;
}) {
  const look = statusLooks[run.status] ?? statusLooks.completed!;
  const Logo = backendLogos[run.backend] ?? instanceLogo(run.backend);
  return (
    <li>
      <button
        type="button"
        aria-current={open ? "page" : undefined}
        onClick={onOpen}
        className={`flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left hover:bg-hover ${open ? "bg-selected" : ""}`}
      >
        <span className="flex w-full items-center gap-2">
          {asks > 0 ? (
            <ShieldQuestion aria-hidden className="size-3.5 shrink-0 text-foreground" />
          ) : (
            <look.Icon aria-hidden className={`size-3.5 shrink-0 ${look.color}`} />
          )}
          <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
          <span className="shrink-0 text-[11.5px] text-faint-foreground">
            {run.coordinatorThread ? "by coordinator" : "by you"}
          </span>
        </span>
        <span className="flex w-full items-center gap-2 pl-5.5 text-[11.5px] text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
          {asks > 0 ? (
            <span className="shrink-0 font-medium text-foreground">Needs approval</span>
          ) : (
            <span className={`shrink-0 ${look.color}`}>{statusLabel(run.status)}</span>
          )}
          {run.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch aria-hidden />
              <span className="truncate">{run.branch}</span>
            </span>
          )}
          {run.diff && (
            <span className="shrink-0 tabular-nums">
              <span className="text-emerald-500">+{run.diff.insertions}</span>{" "}
              <span className="text-danger">−{run.diff.deletions}</span>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {Logo && <Logo />}
            {instanceName(run.accountId) ?? accountLabel(run.accountId)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** A task box that starts a subagent. Enter starts it and Shift+Enter starts a new line. */
function StartAgent({
  start,
  disabledReason,
}: {
  start: ProjectAgentsView["start"];
  disabledReason?: string;
}) {
  const [text, setText] = useState("");
  // Reused until a start succeeds, so a retry never starts two (0007).
  const [runId, setRunId] = useState(uuidv7);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const canStart = !disabledReason && !starting && text.trim() !== "";

  const submit = async () => {
    if (!canStart) return;
    setStarting(true);
    setError(undefined);
    const failed = await start(runId, text);
    setStarting(false);
    if (failed) return setError(failed);
    setText("");
    setRunId(uuidv7());
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="px-3 pb-3"
    >
      <div className="flex items-end gap-1 rounded-2xl border border-border bg-surface p-1.5 focus-within:border-ring">
        <textarea
          aria-label="New subagent's task"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }}
          placeholder={disabledReason ?? "Start a subagent on a task"}
          className="block min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] leading-relaxed placeholder:text-faint-foreground focus-visible:outline-none"
        />
        <button
          type="submit"
          aria-label="Start subagent"
          title="Start subagent"
          disabled={!canStart}
          className="grid size-7 shrink-0 place-items-center rounded-full bg-send text-send-foreground disabled:opacity-25 [&_svg]:size-4"
        >
          {starting ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
        </button>
      </div>
      {error && (
        <p role="alert" className="px-2 pt-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
