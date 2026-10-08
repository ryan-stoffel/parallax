import { GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Project, PromptImage } from "../protocol/generated/protocol";
import { AgentChat, CheckoutLabel, PinnedApprovals, TranscriptView } from "./AgentChat";
import { AgentsBar } from "./AgentsBar";
import { queueOf, useAnswers, type Asked } from "./Approval";
import { Composer, tabItem } from "./Composer";
import { offlineReason, useConnection } from "./ConnectionStatus";
import type { Host } from "./hosts";
import { describeError } from "./errors";
import { imageCaps } from "./images";
import type { RunOptions } from "./models";
import { accountOptions, defaultBackend } from "./NewThread";
import type { ProjectAgentsView } from "./ProjectAgents";
import { RefMenu } from "./RefMenu";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { uuidv7 } from "./uuidv7";

/**
 * A Project's coordinator chat (0024). Until its first message the Project introduces itself, and
 * sending starts the coordinator, showing the message with the transcript's loader at once. From
 * then on it is the coordinator run's `AgentChat`, so replies, Stop, and the transcript work as a
 * thread's do. Every message goes to the coordinator, which starts the Project's children (0042).
 * Either way its children ride over the composer (`AgentsBar`), and its inbox is the side panel's.
 * Key it by host and Project.
 */
export function ProjectChat({
  hostId,
  host,
  repo,
  project,
  prompt,
  startCoordinator,
  updateProject,
  others,
  agents,
  titles,
  needs,
  onOpenRun,
}: {
  hostId: string;
  host?: Host;
  /** The repo entry at the Project's repository, whose branches its picker lists. */
  repo?: string;
  project: Project;
  /** The coordinator's first message, shown until its transcript loads. */
  prompt?: string;
  startCoordinator: ThreadsView["startCoordinator"];
  updateProject: ThreadsView["updateProject"];
  /** Permission requests the Project's subagents wait on, pinned over the composer (PLX-196). */
  others?: readonly Asked[];
  /** The Project's runs, whose children show over the composer. */
  agents: ProjectAgentsView;
  titles?: Readonly<Record<string, string>>;
  /** The children whose questions wait in the inbox. */
  needs?: ReadonlySet<string>;
  /** Opens a child's chat. */
  onOpenRun: (runId: string) => void;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  // The first message's run id, reused when it's sent again after failing (0007).
  const [runId] = useState(uuidv7);
  // The messages sent while the coordinator starts, the first one first, shown as on their way.
  const [starting, setStarting] = useState<{ text: string; images: PromptImage[] }[]>();
  // The first message's start, which messages sent meanwhile wait on.
  const starts = useRef<Promise<string | undefined>>(undefined);
  // Why a message sent while it started didn't reach the coordinator.
  const [heldError, setHeldError] = useState<string>();
  // The coordinator run this chat last started, set before it does so its chat opens as starting.
  const [started, setStarted] = useState<string>();
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

  // Why the base branch couldn't change.
  const [branchError, setBranchError] = useState<string>();
  // On a plxd with an integration branch, the picker sets the base branch new children's work is
  // cut from (0045). The coordinator's checkout keeps its branch: nothing switches it yet.
  const pickBase =
    repo !== undefined &&
    connected &&
    "integrationBranch" in connection.capabilities &&
    "repoRefs" in connection.capabilities;
  const branch = pickBase ? (project.baseBranch ?? project.branch) : project.branch;
  // The coordinator runs in the Project's repository, on its checkout (0027).
  const tab = (
    <>
      <CheckoutLabel host={host} checkout />
      {pickBase ? (
        <>
          <RefMenu
            hostId={hostId}
            repo={repo}
            checkout
            value={branch}
            onChange={(baseBranch) =>
              void updateProject(project.id, { baseBranch }).then(setBranchError)
            }
          />
          {branchError && (
            <span role="alert" className="truncate text-[12px] text-danger">
              {branchError}
            </span>
          )}
        </>
      ) : (
        branch && (
          <span className={tabItem} title={branch}>
            <GitBranch aria-hidden />
            <span className="truncate">{branch}</span>
          </span>
        )
      )}
    </>
  );

  // Starts the coordinator as run `id`. With no coordinator account on the host, the run gets the
  // host's first Claude account, its login before its keys (0004). A Project with a mode runs in
  // it (0042), so it gets no permission.
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
    }
    return error && describeError(error);
  };

  const bar = (
    <AgentsBar
      agents={agents}
      titles={titles}
      coordinator={project.coordinator}
      needs={needs}
      onOpen={onOpenRun}
    />
  );

  if (project.coordinator)
    return (
      <>
        <AgentChat
          key={project.coordinator}
          hostId={hostId}
          runId={project.coordinator}
          prompt={prompt}
          going={started === project.coordinator}
          notice={heldError}
          tab={tab}
          strip={bar}
          // A new coordinator replaces one that can't take messages (0024).
          startOver={(text, options, images) => start(uuidv7(), text, options, images)}
          others={others}
          projectMode={project.permission}
        />
      </>
    );

  // The first message starts the coordinator. One sent while it starts waits for it, then goes
  // to its queue, so messages can be sent back to back from the first.
  const send = async (text: string, options: RunOptions, images: PromptImage[]) => {
    const message = { text, images };
    setStarting((sent) => [...(sent ?? []), message]);
    if (!starts.current) {
      starts.current = start(runId, text, options, images);
      const failed = await starts.current;
      if (failed) {
        starts.current = undefined;
        setStarting(undefined);
      }
      return failed;
    }
    const failed = await starts.current;
    if (failed) return failed;
    // The new run keeps the first message's model and effort.
    const sent = await window.parallax.request(hostId, "agent/send", {
      runId,
      turnId: uuidv7(),
      text,
      ...(images.length > 0 && { images }),
      ...(connected && "queue" in connection.capabilities && { delivery: "queue" as const }),
    });
    if ("error" in sent) setHeldError(`"${text}" wasn't sent: ${describeError(sent.error)}`);
    return undefined;
  };

  let disabledReason = offlineReason(connection);
  if (connected && !("coordinator" in connection.capabilities))
    disabledReason = "This host's plxd can't run a Project's coordinator yet";

  return (
    <>
      {starting ? (
        // Laid out as AgentChat is, so opening the coordinator's chat doesn't move anything.
        <TranscriptView
          rows={starting.map((m, i) => ({ kind: "pending", key: `pending:${i}`, ...m }))}
          sent={new Map()}
          live={false}
        />
      ) : (
        // It gives way first in a short window, so a pinned card and the composer keep their
        // room, and whole: once it doesn't fit, it wraps into a second column, out of view,
        // rather than show cut in two (PLX-259).
        <div className="flex min-h-0 flex-1 flex-col flex-wrap content-start justify-center overflow-hidden text-center">
          {/* The first column's width, so the second starts past the edge. */}
          <span aria-hidden className="w-full" />
          <div className="flex w-full flex-col items-center px-8 pb-[8vh]">
            <ProjectIcon icon={project.icon} className="size-10" />
            <h2 className="mt-5 text-[18px] font-medium tracking-tight">{project.name}</h2>
            <p className="mt-2 max-w-sm text-[14px] text-muted-foreground">
              Describe a feature or a bug and the coordinator starts an agent on it. Send several
              back to back to run them together.
            </p>
          </div>
        </div>
      )}
      {/* As in AgentChat: bounded, so a pinned card's preview gives way to a grown composer. */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">
        <PinnedApprovals
          asked={asked}
          answers={answers}
          onAnswer={(a, choice, message) => void answer(a, choice, message)}
          onDismiss={dismiss}
          disabledReason={connected ? undefined : "Connecting to plxd…"}
        />
        {bar}
        {/* In the same place while it starts, so a failed start puts the message back. */}
        <Composer
          newThread={!starting}
          onSend={send}
          // Hidden while it starts, as the coordinator's chat keeps its run's.
          backend={starting ? undefined : backend}
          hostId={hostId}
          disabledReason={disabledReason}
          tab={tab}
          imageCaps={imageCaps(connection)}
          menus={connected && "composerMenus" in connection.capabilities ? { hostId } : undefined}
          // The coordinator asks only through a plxd that sends its requests.
          manualDenied={connected && !("approvals" in connection.capabilities) ? "host" : undefined}
          projectMode={project.permission}
        />
      </div>
    </>
  );
}
