import { Folder, GitBranch, SquarePen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Project, PromptImage } from "../protocol/generated/protocol";
import { AgentChat, PinnedApprovals } from "./AgentChat";
import { queueOf, useAnswers, type Asked } from "./Approval";
import { Composer, tabItem } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { imageCaps } from "./images";
import type { RunOptions } from "./models";
import { accountOptions, defaultBackend } from "./NewThread";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { uuidv7 } from "./uuidv7";

/** How a Project works, shown before its first message on a plxd with `projectTasks`. */
const steps = [
  "Start tasks from New task. Each gets its own agent and worktree, side by side.",
  "Talk to the coordinator here to plan the work, split it up, or change course.",
  "Check the Overview on the right: what needs you, what's working, and what's done.",
];

/**
 * A Project's coordinator chat (0024). Until its first message the Project introduces itself, and
 * sending starts the coordinator. From then on it is the coordinator run's `AgentChat`, so replies,
 * Stop, and the transcript work as a thread's do. New tasks start from the Project's New task
 * page, which `onNewTask` opens, and its inbox is the Project sidebar's. Key it by host and Project.
 */
export function ProjectChat({
  hostId,
  project,
  prompt,
  startCoordinator,
  others,
  onNewTask,
}: {
  hostId: string;
  project: Project;
  /** The coordinator's first message, shown until its transcript loads. */
  prompt?: string;
  startCoordinator: ThreadsView["startCoordinator"];
  /** Permission requests the Project's subagents wait on, pinned over the composer (PLX-196). */
  others?: readonly Asked[];
  /** Opens the New task page, on a plxd with `projectTasks`. */
  onNewTask?: () => void;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  // The first message's run id, reused when it's sent again after failing (0007).
  const [runId] = useState(uuidv7);
  const [starting, setStarting] = useState(false);
  // The coordinator run this chat last started, set before it does so its chat opens as starting.
  const [started, setStarted] = useState<string>();
  // Which account the coordinator got, when the host had no coordinator account.
  const [notice, setNotice] = useState<string>();
  // The coordinator default's backend, whose models and efforts the first message offers.
  const [backend, setBackend] = useState<string>();
  // Before there's a coordinator, subagents started by hand still ask here (PLX-196).
  const { answers, answer, dismiss } = useAnswers(hostId);
  const asked = useMemo(() => queueOf(others ?? [], answers), [others, answers]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void defaultBackend(hostId, "coordinator").then((b) => live && setBackend(b));
    return () => {
      live = false;
    };
  }, [hostId, connected]);

  // The Project's repository and branch, which the coordinator runs in (0027).
  const tab = (
    <>
      <span className={tabItem} title={project.repoPath}>
        <Folder aria-hidden />
        <span className="truncate">{project.repoPath}</span>
      </span>
      {project.branch && (
        <span className={tabItem} title={project.branch}>
          <GitBranch aria-hidden />
          <span className="truncate">{project.branch}</span>
        </span>
      )}
    </>
  );

  // Starts the coordinator as run `id`. With no coordinator account on the host, the run gets the
  // host's first Claude account, its login before its keys (0004), and the chat says so. A Project
  // with a mode runs in it (0042), so it gets no permission.
  const start = async (
    id: string,
    text: string,
    { model, effort, permission }: RunOptions,
    images: PromptImage[],
  ) => {
    setStarted(id);
    const options = { model, effort, ...(!project.permission && { permission }) };
    let error = await startCoordinator(project.id, id, text, images, options);
    const kind = error?.data?.kind;
    if (kind === "noDefaultAccount" || kind === "accountNotFound") {
      const accounts = await accountOptions(hostId);
      if (typeof accounts === "string") return accounts;
      const first = accounts[0];
      if (!first)
        return "No account can run the coordinator yet. Sign in to Claude Code, or add an API key, then try again.";
      error = await startCoordinator(project.id, id, text, images, {
        ...options,
        account: first.account,
      });
      if (!error) setNotice(`Using ${first.label} for this Project's coordinator.`);
    }
    return error && describeError(error);
  };

  if (project.coordinator)
    return (
      <>
        <AgentChat
          key={project.coordinator}
          hostId={hostId}
          runId={project.coordinator}
          prompt={prompt}
          going={started === project.coordinator}
          notice={notice}
          tab={tab}
          // A new coordinator replaces one that can't take messages (0024).
          startOver={(text, options, images) => start(uuidv7(), text, options, images)}
          others={others}
          projectMode={project.permission}
        />
      </>
    );

  const send = async (text: string, options: RunOptions, images: PromptImage[]) => {
    setStarting(true);
    const failed = await start(runId, text, options, images);
    setStarting(false);
    return failed;
  };

  let disabledReason: string | undefined;
  if (starting) disabledReason = "Starting the coordinator…";
  else if (connection?.status === "failed") disabledReason = "Disconnected from plxd";
  else if (!connected) disabledReason = "Connecting to plxd…";
  else if (!("coordinator" in connection.capabilities))
    disabledReason = "This host's plxd can't run a Project's coordinator yet";

  return (
    <>
      {/* It gives way first in a short window, so a pinned card and the composer keep their room,
          and whole: once it doesn't fit, it wraps into a second column, out of view, rather than
          show cut in two (PLX-259). */}
      <div className="flex min-h-0 flex-1 flex-col flex-wrap content-start justify-end overflow-hidden">
        {/* The first column's width, so the second starts past the edge. */}
        <span aria-hidden className="w-full" />
        <div className="mx-auto w-full max-w-3xl px-8 pb-6">
          <ProjectIcon icon={project.icon} className="size-7" />
          <h2 className="mt-3 text-[20px] font-medium tracking-tight">{project.name}</h2>
          {onNewTask ? (
            <>
              <ol className="mt-4 flex max-w-lg flex-col gap-2 text-[13.5px] text-muted-foreground">
                {steps.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-selected text-[11px] text-foreground tabular-nums">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={onNewTask}
                className="mt-5 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[13px] hover:bg-hover [&_svg]:size-4"
              >
                <SquarePen aria-hidden className="text-muted-foreground" />
                New task
              </button>
            </>
          ) : (
            <p className="mt-1.5 max-w-md text-[14px] text-muted-foreground">
              Agents working on {project.name} report back and coordinate here.
            </p>
          )}
        </div>
      </div>
      {/* As in AgentChat: bounded, so a pinned card's preview gives way to a grown composer. */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">
        <PinnedApprovals
          asked={asked}
          answers={answers}
          onAnswer={(a, choice, message) => void answer(a, choice, message)}
          onDismiss={dismiss}
          disabledReason={connected ? undefined : "Connecting to plxd…"}
        />
        <Composer
          newThread
          onSend={send}
          backend={backend}
          hostId={hostId}
          disabledReason={disabledReason}
          tab={tab}
          imageCaps={imageCaps(connection)}
          menus={connected && "composerMenus" in connection.capabilities ? { hostId } : undefined}
          // The coordinator asks only through a plxd that sends its requests.
          manualDenied={connected && !("approvals" in connection.capabilities) ? "host" : undefined}
          projectMode={project.permission}
          hint="Ask the coordinator to plan the work, split it up, or answer a question"
        />
      </div>
    </>
  );
}
