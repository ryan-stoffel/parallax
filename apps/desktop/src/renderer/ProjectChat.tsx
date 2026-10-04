import { Folder, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Project, PromptImage } from "../protocol/generated/protocol";
import { AgentChat, PinnedApprovals } from "./AgentChat";
import { queueOf, useAnswers, type Asked } from "./Approval";
import { Composer, tabItem } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { imageCaps } from "./images";
import { Inbox, useInbox } from "./Inbox";
import type { RunOptions } from "./models";
import { accountOptions, defaultBackend } from "./NewThread";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { appShortcut } from "./ui";
import { uuidv7 } from "./uuidv7";

/**
 * A Project's coordinator chat (0024). Until its first message the Project introduces itself, and
 * sending starts the coordinator. From then on it is the coordinator run's `AgentChat`, so replies,
 * Stop, and the transcript work as a thread's do. Either way the Project's unread inbox (0043) sits
 * at the top, on a plxd with `inbox`. On a plxd with `projectTasks`, its composer sends a New task,
 * which starts a child, or Ask, which goes to the coordinator (0042). Key it by host and Project.
 */
export function ProjectChat({
  hostId,
  project,
  prompt,
  startCoordinator,
  startTask,
  others,
  onOpenRun,
}: {
  hostId: string;
  project: Project;
  /** The coordinator's first message, shown until its transcript loads. */
  prompt?: string;
  startCoordinator: ThreadsView["startCoordinator"];
  startTask: ThreadsView["startTask"];
  /** Permission requests the Project's subagents wait on, pinned over the composer (PLX-196). */
  others?: readonly Asked[];
  /** Opens a run's chat, as an inbox item links to its child. */
  onOpenRun: (runId: string) => void;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const answerable = connected && "questions" in connection.capabilities;
  const inboxView = useInbox(
    hostId,
    project.id,
    connected && "inbox" in connection.capabilities,
    answerable,
  );
  const inbox = <Inbox view={inboxView} answerable={answerable} onOpen={onOpenRun} />;
  // The first message's run id, reused when it's sent again after failing (0007).
  const [runId] = useState(uuidv7);
  const [starting, setStarting] = useState(false);
  // The coordinator run this chat last started, set before it does so its chat opens as starting.
  const [started, setStarted] = useState<string>();
  // Which account the coordinator got, when the host had no coordinator account.
  const [notice, setNotice] = useState<string>();
  // The coordinator default's backend, whose models and efforts the first message offers.
  const [backend, setBackend] = useState<string>();
  const tasks = connected && "projectTasks" in connection.capabilities;
  // The worker default's backend, a New task's, as New Thread's.
  const [taskBackend, setTaskBackend] = useState<string>();
  // The composer's target, New task until switched, kept as the coordinator starts.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!tasks) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (appShortcut(e) !== "projectTarget") return;
      e.preventDefault();
      setAsking((a) => !a);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tasks]);
  // Before there's a coordinator, subagents started by hand still ask here (PLX-196).
  const { answers, answer, dismiss } = useAnswers(hostId);
  const asked = useMemo(() => queueOf(others ?? [], answers), [others, answers]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void defaultBackend(hostId, "coordinator").then((b) => live && setBackend(b));
    if (tasks) void defaultBackend(hostId, "worker").then((b) => live && setTaskBackend(b));
    return () => {
      live = false;
    };
  }, [hostId, connected, tasks]);

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

  // A New task never waits on the coordinator, so the box is free for the next one at once.
  const newTask = tasks
    ? {
        backend: taskBackend,
        asking,
        onAsking: setAsking,
        onSend: async (
          text: string,
          options: RunOptions,
          images: PromptImage[],
          threads: string[],
        ) => {
          const error = await startTask(project.id, uuidv7(), text, images, options, threads);
          return error && describeError(error);
        },
      }
    : undefined;

  if (project.coordinator)
    return (
      <>
        {inbox}
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
          newTask={newTask}
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
      {inbox}
      {/* It gives way first in a short window, so a pinned card and the composer keep their room,
          and whole: once it doesn't fit, it wraps into a second column, out of view, rather than
          show cut in two (PLX-259). */}
      <div className="flex min-h-0 flex-1 flex-col flex-wrap content-start justify-end overflow-hidden">
        {/* The first column's width, so the second starts past the edge. */}
        <span aria-hidden className="w-full" />
        <div className="mx-auto w-full max-w-3xl px-8 pb-6">
          <ProjectIcon icon={project.icon} className="size-7" />
          <h2 className="mt-3 text-[20px] font-medium tracking-tight">{project.name}</h2>
          <p className="mt-1.5 max-w-md text-[14px] text-muted-foreground">
            {tasks
              ? "Describe a task to start an agent on it, or ask the coordinator to plan the work. Agents report back here."
              : `Agents working on ${project.name} report back and coordinate here.`}
          </p>
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
          newTask={newTask}
        />
      </div>
    </>
  );
}
