import { GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Orchestrator, PromptImage } from "../protocol/generated/protocol";
import { AgentChat, CheckoutLabel, PinnedApprovals, TranscriptView } from "./AgentChat";
import { AgentsBar, isGoing, orchestratorAgentRows } from "./AgentsBar";
import { ComposerTabs } from "./ComposerTabs";
import { queueOf, useAnswers, type Asked } from "./Approval";
import { Composer, tabItem } from "./Composer";
import { offlineReason, useConnection } from "./ConnectionStatus";
import type { Host } from "./hosts";
import { describeError } from "./errors";
import { imageCaps } from "./images";
import { uploadBytes } from "./uploads";
import type { RunOptions } from "./models";
import { notify } from "./notifications";
import { accountOptions, defaultBackend } from "./settings/shared";
import type { OrchestratorAgentsView } from "./OrchestratorAgents";
import { RefMenu } from "./RefMenu";
import { ProjectIcon } from "./Sidebar";
import type { ThreadsView } from "./threads";
import type { ThreadLinks } from "./threadContext";
import { uuidv7 } from "./uuidv7";

/**
 * An orchestrator chat (0024). Until its first message the orchestrator introduces itself, and
 * sending starts the orchestrator, showing the message with the transcript's loader at once. From
 * then on it is the orchestrator run's `AgentChat`, so replies, Stop, and the transcript work as a
 * thread's do. Every message goes to the orchestrator, which starts the orchestrator's children
 * (0042). Either way its children ride over the composer (`AgentsBar`), and its inbox is the side
 * panel's. Key it by host and orchestrator.
 */
export function OrchestratorChat({
  hostId,
  host,
  repo,
  orchestrator,
  prompt,
  startOrchestrator,
  updateOrchestrator,
  others,
  agents,
  titles,
  needs,
  onOpenRun,
  threadLinks,
  settingsClosed,
}: {
  hostId: string;
  host?: Host;
  /** The repo entry at the orchestrator's repository, whose branches its picker lists. */
  repo?: string;
  orchestrator: Orchestrator;
  /** The orchestrator's first message, shown until its transcript loads. */
  prompt?: string;
  startOrchestrator: ThreadsView["startOrchestrator"];
  updateOrchestrator: ThreadsView["updateOrchestrator"];
  /** Permission requests the orchestrator's subagents wait on, pinned over the composer (PLX-196). */
  others?: readonly Asked[];
  /** The orchestrator's runs, whose children show over the composer. */
  agents: OrchestratorAgentsView;
  titles?: Readonly<Record<string, string>>;
  /** The children whose questions wait in the inbox. */
  needs?: ReadonlySet<string>;
  /** Opens a child's chat. */
  onOpenRun: (runId: string) => void;
  /** The open host's threads, as a thread's chat gets them: its pages, files, and thread chips need them. */
  threadLinks: ThreadLinks;
  /** How many times Settings has closed. The default is read again each time, as it may have changed there. */
  settingsClosed?: number;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  // The first message's run id, reused when it's sent again after failing (0007).
  const [runId] = useState(uuidv7);
  // The messages sent while the orchestrator starts, the first one first, shown as on their way.
  const [starting, setStarting] = useState<{ text: string; images: PromptImage[] }[]>();
  // The first message's start, which messages sent meanwhile wait on.
  const starts = useRef<Promise<string | undefined>>(undefined);
  // The orchestrator run this chat last started, set before it does so its chat opens as starting.
  const [started, setStarted] = useState<string>();
  // The orchestrator default's backend, whose models and efforts the first message offers.
  const [backend, setBackend] = useState<string>();
  // Before there's an orchestrator, subagents started by hand still ask here (PLX-196).
  const { answers, answer, dismiss } = useAnswers(hostId);
  const asked = useMemo(() => queueOf(others ?? [], answers), [others, answers]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void defaultBackend(hostId, "orchestrator").then((b) => live && setBackend(b));
    return () => {
      live = false;
    };
  }, [hostId, connected, settingsClosed]);

  // On a plxd with an integration branch, the picker sets the base branch new children's work is
  // cut from (0045). The orchestrator's checkout keeps its branch: nothing switches it yet.
  const pickBase =
    repo !== undefined &&
    connected &&
    "integrationBranch" in connection.capabilities &&
    "repoRefs" in connection.capabilities;
  const branch = pickBase ? (orchestrator.baseBranch ?? orchestrator.branch) : orchestrator.branch;
  // The orchestrator runs in the orchestrator's repository, on its checkout (0027).
  const tab = (
    <>
      <CheckoutLabel host={host} checkout />
      {pickBase ? (
        <RefMenu
          hostId={hostId}
          repo={repo}
          checkout
          value={branch}
          onChange={(baseBranch) =>
            void updateOrchestrator(orchestrator.id, { baseBranch }).then(
              (error) =>
                error &&
                notify({
                  key: `base-branch/${orchestrator.id}`,
                  tone: "error",
                  title: "Couldn't change the base branch",
                  body: error,
                }),
            )
          }
        />
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

  // Starts the orchestrator as run `id`. With no orchestrator account on the host, the run gets the
  // host's first Claude account, its login before its keys (0004). An orchestrator with a mode runs
  // in it (0042), so it gets no permission.
  const start = async (
    id: string,
    text: string,
    { model, effort, permission }: RunOptions,
    images: PromptImage[],
  ) => {
    setStarted(id);
    const options = { model, effort, ...(!orchestrator.permission && { permission }) };
    let error = await startOrchestrator(orchestrator.id, id, text, images, options);
    const kind = error?.data?.kind;
    if (kind === "noDefaultAccount" || kind === "accountNotFound") {
      const accounts = await accountOptions(hostId);
      if (typeof accounts === "string") return accounts;
      const first = accounts[0];
      if (!first)
        return "No account can run the orchestrator yet. Sign in to Claude Code, or add an API key, then try again.";
      error = await startOrchestrator(orchestrator.id, id, text, images, {
        ...options,
        account: first.account,
      });
    }
    return error && describeError(error);
  };

  const rows = orchestratorAgentRows(agents, titles ?? {}, orchestrator.run, needs);
  const bar = rows.some(isGoing)
    ? {
        key: "agents",
        node: <AgentsBar rows={rows} onOpen={onOpenRun} />,
        compact: <AgentsBar rows={rows} onOpen={onOpenRun} compact />,
      }
    : undefined;

  if (orchestrator.run)
    return (
      <AgentChat
        key={orchestrator.run}
        hostId={hostId}
        runId={orchestrator.run}
        prompt={prompt}
        going={started === orchestrator.run}
        tab={tab}
        strip={bar}
        others={others}
        orchestratorMode={orchestrator.permission}
        threadLinks={threadLinks}
      />
    );

  // The first message starts the orchestrator. One sent while it starts waits for it, then goes
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
    const sent = await window.parallax.request(hostId, "orchestration/dispatch", {
      type: "message.dispatch",
      threadId: runId,
      messageId: uuidv7(),
      text,
      ...(images.length > 0 && { images }),
      dispatchMode: { type: "queue_after_active" },
    });
    if ("error" in sent)
      notify({
        tone: "error",
        title: "Couldn't send a message",
        body: `"${text}" wasn't sent: ${describeError(sent.error)}`,
      });
    return undefined;
  };

  let disabledReason = offlineReason(connection);
  if (connected && !("orchestrator" in connection.capabilities))
    disabledReason = "This host's plxd can't run an orchestrator yet";

  return (
    <>
      {starting ? (
        // Laid out as AgentChat is, so opening the orchestrator's chat doesn't move anything.
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
            <ProjectIcon icon={orchestrator.icon} className="size-8" />
            <h2 className="mt-5 text-heading font-medium tracking-tight">{orchestrator.name}</h2>
            <p className="mt-2 max-w-sm text-reading text-muted-foreground">
              Describe a feature or a bug and the orchestrator starts an agent on it. Send several
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
        <ComposerTabs tabs={bar ? [bar] : []} />
        {/* In the same place while it starts, so a failed start puts the message back. */}
        <Composer
          newThread={!starting}
          onSend={send}
          // Hidden while it starts, as the orchestrator's chat keeps its run's.
          backend={starting ? undefined : backend}
          hostId={hostId}
          connected={connected}
          disabledReason={disabledReason}
          tab={tab}
          imageCaps={imageCaps(connection)}
          uploadBytes={uploadBytes(connection)}
          menus={connected && "composerMenus" in connection.capabilities ? { hostId } : undefined}
          // The orchestrator asks only through a plxd that sends its requests.
          manualDenied={connected && !("approvals" in connection.capabilities) ? "host" : undefined}
          orchestratorMode={orchestrator.permission}
        />
      </div>
    </>
  );
}
