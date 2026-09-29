import { ArrowUp, GitBranch, LoaderCircle, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AgentRun, WispEvent } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { backendLogos, statusLooks } from "./Sidebar";
import { titleOf } from "./threads";
import { accountLabel, statusLabel, updateRun } from "./transcript";
import { uuidv7 } from "./uuidv7";

/** A Project's runs, oldest first, kept live, and a way to start one by hand. */
export interface ProjectAgentsView {
  runs: AgentRun[];
  /** Why the list couldn't load or stopped updating, for people. */
  error?: string;
  /**
   * Starts a subagent on `prompt` with the worker's default account. Reuse `runId`, with the same
   * prompt, to retry. Resolves to an error message, or undefined.
   */
  start: (runId: string, prompt: string) => Promise<string | undefined>;
}

/** Applies one of a Project's events to its runs: a new run joins, and a changed one is replaced. */
export function applyAgentEvent(runs: AgentRun[], event: WispEvent): AgentRun[] {
  if (!("runId" in event)) return runs;
  const i = runs.findIndex((r) => r.id === event.runId);
  const run = updateRun(runs[i], event);
  if (!run || run === runs[i]) return runs;
  return i < 0 ? [...runs, run] : runs.with(i, run);
}

/**
 * A Project's runs, coordinator included, kept live: `agent/list {project}`, then the Project's
 * events after its `seq`, starting over on `resync`. Empty with no Project, and loads only while
 * `connected`.
 */
export function useProjectAgents(
  hostId: string,
  project: string | undefined,
  connected: boolean,
): ProjectAgentsView {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [error, setError] = useState<string>();
  // Another Project starts empty, rather than showing this one's runs until its list loads.
  const scope = `${hostId}/${project}`;
  const [shown, setShown] = useState(scope);
  if (shown !== scope) {
    setShown(scope);
    setRuns([]);
    setError(undefined);
  }

  useEffect(() => {
    if (!connected || !project) return;
    let stopped = false;
    let unsubscribe = () => {};

    async function load() {
      const list = await window.wisp.request(hostId, "agent/list", { project });
      if (stopped) return;
      if ("error" in list) return setError(list.error.message);
      setRuns(list.result.runs);
      setError(undefined);
      const since = { after: list.result.seq, project, logId: list.logId };
      unsubscribe = window.wisp.subscribe(hostId, since, (message) => {
        if (stopped) return;
        if (message.type === "resync") return void load();
        if (message.type === "error") return setError(message.error.message);
        setRuns((prev) => applyAgentEvent(prev, message.event.event));
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
      const answer = await window.wisp.request(hostId, "agent/start", {
        runId,
        project,
        prompt,
        policy: "workspaceWrite",
      });
      if ("error" in answer) return describeError(answer.error);
      // Unless its agent.started got here first, with whatever followed it.
      const { run } = answer.result;
      setRuns((prev) => (prev.some((r) => r.id === run.id) ? prev : [...prev, run]));
      return undefined;
    },
    [hostId, project],
  );

  return { runs, error, start };
}

/**
 * The side panel's Agents view for a Project: its subagents, newest first, without the coordinator
 * (0024), each opening its chat; then a box that starts one by hand.
 */
export function AgentsPanel({
  agents,
  openId,
  onOpen,
  disabledReason,
}: {
  agents: ProjectAgentsView;
  /** The subagent whose chat is open. */
  openId?: string;
  onOpen: (runId: string) => void;
  /** Why starting one is off right now. */
  disabledReason?: string;
}) {
  const shown = agents.runs.filter((r) => r.policy !== "noWrite").toReversed();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {shown.length > 0 ? (
        <ul aria-label="Agents" className="min-h-0 flex-1 overflow-y-auto px-2">
          {shown.map((run) => (
            <AgentRow
              key={run.id}
              run={run}
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

/** A subagent's row: status and title, who started it, then its branch, changes, and account. */
function AgentRow({ run, open, onOpen }: { run: AgentRun; open: boolean; onOpen: () => void }) {
  const look = statusLooks[run.status] ?? statusLooks.completed!;
  const Logo = backendLogos[run.backend];
  return (
    <li>
      <button
        type="button"
        aria-current={open ? "page" : undefined}
        onClick={onOpen}
        className={`flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left hover:bg-hover ${open ? "bg-selected" : ""}`}
      >
        <span className="flex w-full items-center gap-2">
          <look.Icon aria-hidden className={`size-3.5 shrink-0 ${look.color}`} />
          <span className="min-w-0 flex-1 truncate text-[13px]">{titleOf(run)}</span>
          <span className="shrink-0 text-[11.5px] text-faint-foreground">
            {run.coordinatorThread ? "by coordinator" : "by you"}
          </span>
        </span>
        <span className="flex w-full items-center gap-2 pl-5.5 text-[11.5px] text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
          <span className={`shrink-0 ${look.color}`}>{statusLabel(run.status)}</span>
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
            {accountLabel(run.accountId)}
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
