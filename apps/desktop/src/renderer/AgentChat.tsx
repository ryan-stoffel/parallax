import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeftRight,
  ArrowRight,
  Ban,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  FilePlus,
  FileText,
  FoldVertical,
  Folder,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  GitPullRequestArrow,
  Globe,
  Hammer,
  ImageOff,
  Info,
  ListChecks,
  Pencil,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import type { RpcError } from "../preload/bridge";
import type {
  AgentDelivery,
  AgentRun,
  AgentToolStatus,
  ImageId,
  JsonValue,
  PromptImage,
} from "../protocol/generated/protocol";
import {
  ApprovalDetails,
  ApprovalQueue,
  ApprovalSummary,
  DiffRow,
  diffBand,
  queueOf,
  RequestPreview,
  useAnswers,
  withAnswers,
  type Asked,
  type ToolLook,
} from "./Approval";
import { duration, useSeconds } from "./AttentionMark";
import { Composer, tabItem, type ComposerProps, type Unanswered } from "./Composer";
import { useConnection } from "./ConnectionStatus";
import { describeError, githubProblem } from "./errors";
import { ForkButton, ForkContext, type ForkTarget } from "./Fork";
import type { Host } from "./hosts";
import { imageCaps, imageUrl, loadImage } from "./images";
import { Loader, type LoaderStyle } from "./Loader";
import { GitHubLogo, LinearLogo } from "./logos";
import { markdownBlocks, SPLIT_FROM } from "./markdownBlocks";
import { useCatalog, type Provider, type RunOptions } from "./models";
import { kinds } from "./providers";
import {
  latestPlan,
  PlanStrip,
  PlanLine,
  ProposedPlan,
  withPlans,
  type PlanRow,
  type ProposedPlanRow,
} from "./Plan";
import { searchText, useFind } from "./Find";
import { plainText, PromptRail, ScrollToEnd, type Prompt } from "./PromptRail";
import { attachThreads, SentThread, ThreadLinksContext, type ThreadLinks } from "./threadContext";
import { QueueStrip } from "./QueueStrip";
import { ResumeCard } from "./ResumeCard";
import { hostIcon } from "./RunTargetMenu";
import {
  knownModel,
  modelName,
  nativeSubagents,
  SubagentCall,
  SubagentsContext,
  type NativeSubagent,
} from "./Subagents";
import { titleOf, type ForkChoice } from "./threads";
import {
  failureText,
  groupWork,
  isRunning,
  isSubagentTool,
  subagentLabels,
  subagentRows,
  subagentState,
  waitingApprovals,
  workedFor,
  plxdTools,
  type Approval,
  type Item,
  type Subagent,
  type Work,
} from "./transcript";
import { SetUpGithub } from "./ui";
import { useAgentRun, type SentMessage } from "./useAgentRun";
import { clockOptions } from "./prefs";

/** A row: a transcript item, or a message this window sent that hasn't reached the agent yet. */
type Row =
  | Item
  | {
      kind: "pending";
      key: string;
      text: string;
      images?: PromptImage[];
      threads?: string[];
      turnId?: string;
    };
/**
 * What the list shows: a turn's activity is folded into one `Work` row, its plan apart. While a
 * turn goes, a `working` row under its prompt says how long it has gone, and a `musing` row stands
 * for what the agent does next when nothing is in flight (PLX-584).
 */
type ViewRow =
  | Row
  | Work
  | PlanRow
  | ProposedPlanRow
  | { kind: "working"; key: string; since?: string }
  | { kind: "musing"; key: string };

/** The run's worktree, which a tool row's paths read relative to. */
const RootContext = createContext<string | undefined>(undefined);

/** Focuses the composer's editor (Composer.tsx), as when the plan strip goes with focus in it. */
const focusComposer = () => document.getElementById("composer-input")?.focus();
/** A pinned plan's Markdown, rendered as the transcript renders the agent's. */
const markdown = (text: string) => <MarkdownText text={text} />;

/**
 * The permission requests waiting on the user, pinned over the composer (PLX-196): tools named as
 * the transcript names them, and focus back to the composer once the last one goes.
 */
export function PinnedApprovals(
  props: Omit<ComponentProps<typeof ApprovalQueue>, "describe" | "markdown" | "returnFocus">,
) {
  return (
    <ApprovalQueue
      {...props}
      describe={describeTool}
      markdown={markdown}
      returnFocus={focusComposer}
    />
  );
}

/**
 * An agent run as a chat: its transcript, the composer, and the run's footer.
 * The same view serves normal threads, subagents, and a Project's coordinator.
 */
export function AgentChat({
  hostId,
  host,
  runId,
  title,
  notice,
  prompt,
  going,
  noRepo,
  tab,
  strip,
  startOver,
  others,
  projectMode,
  pullRequests,
  onPrOpened,
  onSetUpGithub,
  compose,
  onComposed,
  threadLinks,
  subagent,
  onOpenSubagent,
  onSubagents,
  forked,
  onFork,
}: {
  hostId: string;
  runId: string;
  /** The thread's title, which Open PR names the pull request after. Else, its run's. */
  title?: string;
  /** A quiet note shown over the composer, such as which account a new thread got. */
  notice?: string;
  /** The run's first prompt, shown until the transcript loads, so a new thread opens on it. */
  prompt?: string;
  /**
   * Whether the run is known to be starting or running, as one this window just started is. Until
   * the transcript loads, `prompt` then shows as on its way to it, with the loader under it.
   */
  going?: boolean;
  /** A thread with no repo: its scratch repository has no origin, so it gets no Open PR. */
  noRepo?: boolean;
  /** The host the run is on, named in the composer's tab. */
  host?: Host;
  /** The composer's tab in place of the run's worktree, such as a coordinator's repository. */
  tab?: ReactNode;
  /** A strip tucked over the composer, above the plan's, such as a Project's agents. */
  strip?: ReactNode;
  /**
   * Starts a new run with `text` and `images` in place of this one once this one can't take
   * messages, as a Project's coordinator can (0024). Resolves to an error message, or undefined.
   */
  startOver?: (
    text: string,
    options: RunOptions,
    images: PromptImage[],
  ) => Promise<string | undefined>;
  /**
   * Permission requests other runs wait on, pinned here with this run's own, as a Project's other
   * runs' are in each of its chats (PLX-196).
   */
  others?: readonly Asked[];
  /** The Project's permission mode, shown in place of Access, for a run in a Project (0042). */
  projectMode?: ComposerProps["projectMode"];
  /** The run tab's link to its linked pull requests (PLX-319), in place of Open PR. */
  pullRequests?: ReactNode;
  /** Opens the pull request Open PR opened, in place of linking to it. */
  onPrOpened?: (url: string) => void;
  /** Offered when Open PR fails because `gh` is missing or signed out (PLX-423). */
  onSetUpGithub?: () => void;
  /**
   * A message from outside the chat, such as the PR view's: sent, or put in the composer to finish.
   * `onComposed` says it's taken, so each one is taken once.
   */
  compose?: { text: string; send: boolean };
  onComposed?: () => void;
  /**
   * The host's threads: the composer attaches them where plxd takes them (PLX-378), and the
   * transcript's attached threads open from their chips.
   */
  threadLinks?: ThreadLinks;
  /** The agent's own subagent shown in place of the chat, by its call's id (PLX-382). */
  subagent?: string;
  /** Opens one of the agent's own subagents in run `runId`, as its call's row does. */
  onOpenSubagent?: (runId: string, callId: string) => void;
  /** Told run `runId`'s own subagents whenever they change, for the top bar's chips. */
  onSubagents?: (runId: string, subagents: NativeSubagent[]) => void;
  /** Whether the thread is a fork (0050), whose history copied from the original shows muted. */
  forked?: boolean;
  /**
   * Forks the thread at a turn, or at its latest with none, and opens the fork (0050). Its
   * messages offer Fork only with it. Resolves to plxd's error, if it refused.
   */
  onFork?: (turnId: string | undefined, choice: ForkChoice) => Promise<RpcError | undefined>;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const catalog = useCatalog(hostId);
  const queueEnabled = connected && "queue" in connection.capabilities;
  const { transcript, error, sent, send, cancel, queue, queueError, older, loadOlder } =
    useAgentRun(
      hostId,
      runId,
      connected,
      queueEnabled,
      connected && "eventsBefore" in connection.capabilities,
    );
  // Permission requests (PLX-196): those answered here read as answered at once.
  const { answers, answer, dismiss } = useAnswers(hostId);
  const [resendError, setResendError] = useState<string>();
  const [prError, setPrError] = useState<RpcError>();
  // Open PR's failure for `gh` missing or signed out, as a short line by Set up GitHub.
  const prGithub = onSetUpGithub && githubProblem(prError);
  // Dropped follow-ups already sent again, so their Send again goes away (back on failure).
  const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
  const resend = useCallback(
    (turnId: string, message: SentMessage) => {
      setResent((prev) => new Set(prev).add(turnId));
      void send(message.text, undefined, message.images, message.threads).then((failed) => {
        setResendError(failed?.message);
        if (failed)
          setResent((prev) => {
            const next = new Set(prev);
            next.delete(turnId);
            return next;
          });
      });
    },
    [send],
  );
  useEffect(() => {
    if (!compose) return;
    if (compose.send) void send(compose.text).then((failed) => setResendError(failed?.message));
    onComposed?.();
  }, [compose, send, onComposed]);
  // Queued messages the user cancelled from here, whose followUpDropped notice is left out.
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set());
  const unsent = useMemo(
    () => new Map([...sent].filter(([turnId]) => !resent.has(turnId))),
    [sent, resent],
  );
  const { run } = transcript;
  const items = useMemo(() => withAnswers(transcript.items, answers), [transcript.items, answers]);
  const asked = useMemo(
    () =>
      queueOf(
        [...waitingApprovals(items).map((approval) => ({ runId, approval })), ...(others ?? [])],
        answers,
      ),
    [items, others, answers, runId],
  );
  const plan = useMemo(() => latestPlan(items), [items]);
  const showImage = useCallback((id: ImageId) => loadImage(hostId, runId, id), [hostId, runId]);

  // A message plxd wouldn't send because the run can't be resumed, which `startOver` can take.
  const [refused, setRefused] = useState<{
    text: string;
    options: RunOptions;
    images: PromptImage[];
    why: string;
  }>();
  const [startingOver, setStartingOver] = useState(false);
  const sendText = async (
    text: string,
    options: RunOptions,
    images: PromptImage[],
    threads: string[],
    delivery?: AgentDelivery,
  ) => {
    const failed = await send(text, options, images, threads, delivery);
    if (!startOver || failed?.data?.kind !== "runNotResumable") return failed?.message;
    setRefused({ text, options, images, why: failed.message });
    return ""; // Back in the box; the line above it says why and offers Start over.
  };
  // A run that ended before its CLI reported a session never answered: it starts over with its
  // own first message. ponytail: without that message's images, which would need fetching first.
  const stuck =
    startOver &&
    (refused ??
      (run && !isRunning(run.status) && !run.sessionId
        ? {
            text: run.prompt,
            options: {},
            images: [],
            why: "it stopped before its session started.",
          }
        : undefined));
  const restart = async () => {
    if (!stuck) return;
    setStartingOver(true);
    // The new run keeps this one's model, effort, and mode unless the message changed them.
    const {
      model = run?.model,
      effort = run?.effort,
      permission = run?.permission,
    } = stuck.options;
    const failed = await startOver(stuck.text, { model, effort, permission }, stuck.images);
    setStartingOver(false);
    if (failed) setRefused({ ...stuck, why: failed });
  };

  // Sent from here, but no turnStarted (or followUpDropped) for it yet.
  const rows = useMemo<Row[]>(() => {
    const seen = new Set(items.flatMap((i) => ("turnId" in i && i.turnId ? [i.turnId] : [])));
    const pending = [...sent]
      .filter(([turnId]) => !seen.has(turnId) && !queue.some((m) => m.id === turnId))
      .map(([turnId, { text, images, threads }]) => ({
        kind: "pending" as const,
        key: `pending:${turnId}`,
        text,
        images,
        threads,
        turnId,
      }));
    const shown = items.filter(
      (i) => !(i.kind === "notice" && i.turnId && cancelled.has(i.turnId)),
    );
    const all = [...shown, ...pending];
    if (all.length > 0 || !prompt) return all;
    return [
      going
        ? { kind: "pending", key: "pending:prompt", text: prompt }
        : { kind: "user", key: "prompt", text: prompt },
    ];
  }, [items, sent, prompt, going, queue, cancelled]);
  // The user's prompts, for the composer's Up: not Parallax's wake-ups or other threads' messages.
  const history = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.kind === "pending") return [row.text];
        if (row.kind !== "user" || notTheUsers(row)) return [];
        const text = row.text ?? (row.turnId && sent.get(row.turnId)?.text);
        return text ? [text] : [];
      }),
    [rows, sent],
  );
  // The latest prompt while nothing from the agent follows it, which Stop puts back in the box:
  // its text, its attached threads, and its images: at hand when sent from here, or fetched from
  // plxd by id on Stop.
  const unanswered = useMemo<(Unanswered & { turnId?: string }) | undefined>(() => {
    // The last message queued from here comes after every row.
    const queued = queue.findLast((m) => sent.has(m.id));
    if (queued) {
      const { text, images, threads } = sent.get(queued.id)!;
      return { text, images: async () => images, threads, turnId: queued.id };
    }
    const at = rows.findLastIndex((r) => r.kind === "user" || r.kind === "pending");
    const row = rows[at];
    if (
      (row?.kind !== "user" && row?.kind !== "pending") ||
      (row.kind === "user" && notTheUsers(row))
    )
      return undefined;
    if (
      !rows.slice(at + 1).every((r) => ["notice", "end", "session", "modelSwitch"].includes(r.kind))
    )
      return undefined;
    const mine = row.kind === "user" && row.turnId ? sent.get(row.turnId) : undefined;
    const text = row.text ?? mine?.text;
    if (text == null) return undefined;
    const atHand = (row.kind === "pending" ? row.images : mine?.images) ?? [];
    const ids = row.kind === "user" && !mine ? (row.images ?? []) : [];
    const images = async () => {
      const got = await Promise.all(
        ids.map((imageId) =>
          window.parallax.request(hostId, "agent/image", { runId, imageId }).catch(() => undefined),
        ),
      );
      return [...atHand, ...got.flatMap((a) => (a && "result" in a ? [a.result] : []))];
    };
    const threads = row.threads ?? mine?.threads;
    // Only one still on its way can be dropped, and so offer Send again.
    return { text, images, threads, turnId: row.kind === "pending" ? row.turnId : undefined };
  }, [rows, sent, queue, hostId, runId]);
  // A stopped prompt goes back in the box, so if plxd drops it, it offers no Send again too.
  const stop = async () => {
    const back = unanswered;
    const failed = await cancel();
    if (!failed && back?.turnId) setResent((prev) => new Set(prev).add(back.turnId!));
    return failed;
  };

  // One that couldn't load, stopped updating, or lost plxd shows nothing in progress.
  const stalled = error !== undefined || (connection !== undefined && !connected);
  const live = isRunning(run?.status) && !stalled;
  const native = useMemo(
    () => JSON.stringify(nativeSubagents(transcript.subagents, live)),
    [transcript.subagents, live],
  );
  useEffect(
    () => onSubagents?.(runId, JSON.parse(native) as NativeSubagent[]),
    [native, onSubagents, runId],
  );
  const subagents = useMemo(
    () =>
      onOpenSubagent && {
        subagents: transcript.subagents ?? {},
        live,
        open: (callId: string) => onOpenSubagent(runId, callId),
      },
    [transcript.subagents, live, onOpenSubagent, runId],
  );
  const shown = subagent ? transcript.subagents?.[subagent] : undefined;

  let disabledReason: string | undefined;
  if (connection?.status === "failed") disabledReason = "Disconnected from plxd";
  else if (!connected) disabledReason = "Connecting to plxd…";
  else if (!run) disabledReason = error ? "This chat couldn't load" : "Loading…";
  let optionsDisabled: string | undefined;
  // `sendModel` is `sendOptions`' successor, which also takes the model (PLX-163). With
  // `sendAccount`, a message that changes them while the run works waits for it to finish.
  const moves = connected && "sendAccount" in connection.capabilities;
  if (connected && !("sendModel" in connection.capabilities))
    optionsDisabled = "This host's plxd can't change a thread's model, effort, or access";
  else if (isRunning(run?.status) && !moves)
    optionsDisabled = "The model, effort, and access can change once it finishes";
  // The instances the run can't move to, by why: any but its own on a plxd that can't move runs,
  // and for a coordinator, those that can't run one.
  const unavailable: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (i.id === run?.backend) continue;
    else if (!moves)
      unavailable[i.id] =
        `${i.name} is unavailable in this thread. Start a new thread to switch providers.`;
    else if (run?.policy === "noWrite" && !i.coordinator)
      unavailable[i.id] = `${i.name} can't run a Project's coordinator yet.`;
  // Manual's requests come here only from a run that asked for them, on a plxd that sends them.
  let manualDenied: "host" | "run" | undefined;
  if (connected && !("approvals" in connection.capabilities)) manualDenied = "host";
  else if (run && !run.approvals) manualDenied = "run";
  // A finished run with a commit can go to GitHub (PLX-168), until Accept removes its branch.
  const canOpenPr =
    connected &&
    "openPr" in connection.capabilities &&
    !noRepo &&
    !!run?.diff &&
    !isRunning(run.status) &&
    run.status !== "accepted";

  const forkTarget = useMemo<ForkTarget | undefined>(
    () => (run && onFork && connected ? { hostId, run, onFork } : undefined),
    [hostId, run, onFork, connected],
  );
  const pinned = (
    <PinnedApprovals
      asked={asked}
      answers={answers}
      onAnswer={(a, choice, message) => void answer(a, choice, message)}
      onDismiss={dismiss}
      disabledReason={connected ? undefined : (disabledReason ?? "Connecting to plxd…")}
    />
  );

  if (subagent)
    return (
      <SubagentsContext value={subagents}>
        {shown ? (
          <SubagentView sub={shown} live={live} stalled={stalled} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-faint-foreground">
            {error ?? (run ? "This subagent isn't in the transcript" : "Loading…")}
          </div>
        )}
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">{pinned}</div>
      </SubagentsContext>
    );

  return (
    <SubagentsContext value={subagents}>
      {rows.length > 0 ? (
        <ThreadLinksContext value={threadLinks}>
          <ForkContext value={forkTarget}>
            <TranscriptView
              rows={rows}
              sent={unsent}
              live={isRunning(run?.status)}
              stalled={stalled}
              turnDone={transcript.turnDone}
              root={run?.worktreePath}
              // plxd logs a fork's copied history with its agent.started, at its creation (0050).
              copiedAt={forked ? run?.createdAt : undefined}
              onResend={resend}
              loadImage={showImage}
              onNearTop={older ? loadOlder : undefined}
              end={
                run?.status === "waiting" && (
                  <ResumeCard hostId={hostId} run={run} disabledReason={disabledReason} />
                )
              }
            />
          </ForkContext>
        </ThreadLinksContext>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center text-[13px] text-faint-foreground">
          {error ? (
            <>
              <p className="font-medium text-foreground">This chat couldn't load</p>
              <p className="text-muted-foreground">{error}</p>
            </>
          ) : (
            connected && "Loading…"
          )}
        </div>
      )}
      {/* A column the window bounds, so a pinned card's preview gives way to a grown composer. */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">
        {/* Requests waiting on the user, pinned so they can't scroll away. */}
        {pinned}
        {/* A loaded transcript that stopped updating, a failed Send again, or Open PR. */}
        {(error ?? resendError ?? prError) && rows.length > 0 && (
          <p role="alert" className="flex items-center gap-2 px-2 pb-2 text-[12.5px] text-danger">
            {error ?? resendError ?? (prGithub || describeError(prError!))}
            {!error && !resendError && prGithub && <SetUpGithub onClick={onSetUpGithub!} />}
          </p>
        )}
        {notice && (
          <p role="status" className="px-2 pb-2 text-[12.5px] text-muted-foreground">
            {notice}
          </p>
        )}
        {stuck && (
          <p role="alert" className="px-2 pb-2 text-[12.5px] text-danger">
            This chat can't continue: {stuck.why}{" "}
            <button
              type="button"
              disabled={startingOver}
              onClick={() => void restart()}
              className="font-medium text-foreground underline underline-offset-2 disabled:opacity-50"
            >
              Start over
            </button>
          </p>
        )}
        {strip}
        {/* The latest turn's plan, while the run works on it. */}
        {plan && isRunning(run?.status) && !stalled && (
          <PlanStrip
            items={plan.items}
            active={plan.active}
            loader={loaders.planning}
            returnFocus={focusComposer}
          />
        )}
        {queueEnabled && (
          <QueueStrip
            hostId={hostId}
            runId={runId}
            messages={queue}
            running={isRunning(run?.status)}
            disabledReason={disabledReason}
            loadError={queueError}
            onCancelled={(id) => setCancelled((prev) => new Set(prev).add(id))}
          />
        )}
        <Composer
          onSend={(text, options, images, threads) =>
            sendText(text, options, images, threads, queueEnabled ? "queue" : undefined)
          }
          onSteer={
            queueEnabled && isRunning(run?.status)
              ? (text, options, images, threads) =>
                  sendText(text, options, images, threads, "steer")
              : undefined
          }
          history={history}
          onStop={isRunning(run?.status) ? stop : undefined}
          unanswered={unanswered}
          disabledReason={disabledReason}
          tab={
            tab ??
            (run && (
              <RunTab run={run} host={host}>
                {pullRequests ||
                  (canOpenPr && (
                    <OpenPr
                      hostId={hostId}
                      run={run}
                      title={title ?? titleOf(run)}
                      onError={setPrError}
                      onOpened={onPrOpened}
                    />
                  ))}
              </RunTab>
            ))
          }
          backend={run?.backend}
          started={run}
          hostId={hostId}
          contextAndFast={connected && "contextAndFast" in connection.capabilities}
          unavailable={unavailable}
          optionsDisabled={optionsDisabled}
          imageCaps={imageCaps(connection)}
          manualDenied={manualDenied}
          projectMode={projectMode}
          insert={compose && !compose.send ? compose.text : undefined}
          menus={
            connected && "composerMenus" in connection.capabilities ? { hostId, runId } : undefined
          }
          attach={attachThreads(connection, threadLinks, runId)}
        />
      </div>
    </SubagentsContext>
  );
}

const noneSent: ReadonlyMap<string, SentMessage> = new Map();

/**
 * One of the agent's own subagents, read-only (PLX-382): its prompt, what it did, and its final
 * report, then its type, model, and where it stands, in place of a composer.
 */
function SubagentView({ sub, live, stalled }: { sub: Subagent; live: boolean; stalled: boolean }) {
  const rows = useMemo(() => subagentRows(sub), [sub]);
  const state = subagentState(sub, live);
  return (
    <>
      <TranscriptView rows={rows} sent={noneSent} live={state === "running"} stalled={stalled} />
      <div className="mx-auto w-full max-w-3xl px-6 pt-1">
        <p
          role="status"
          aria-label="Subagent"
          className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-2.5 text-[12.5px] text-muted-foreground"
        >
          <Bot aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {[sub.agentType, modelName(sub.model), subagentLabels[state]]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="ml-auto shrink-0 text-faint-foreground">
            Read-only: Claude Code's own subagent
          </span>
        </p>
      </div>
    </>
  );
}

/**
 * The transcript as a virtualized list. It follows new output while scrolled to
 * the bottom, and stays put once the user scrolls up, or older rows come in above.
 */
export function TranscriptView({
  rows,
  sent,
  live,
  stalled = false,
  onResend,
  loadImage,
  onNearTop,
  end,
  copiedAt,
  turnDone = false,
  root,
}: {
  rows: Row[];
  sent: ReadonlyMap<string, SentMessage>;
  live: boolean;
  /** Whether the transcript is out of date, so nothing in it shows as in progress. */
  stalled?: boolean;
  /** Whether the agent's last turn finished while the run winds down, so it shows no work going. */
  turnDone?: boolean;
  /** The run's worktree, which tool rows' paths read relative to. */
  root?: string;
  onResend?: (turnId: string, message: SentMessage) => void;
  /** Fetches a message's image by id, as a data URL. */
  loadImage?: (imageId: ImageId) => Promise<string | undefined>;
  /** Called while the top is within a screen of view, to load older rows (PLX-490). */
  onNearTop?: () => void;
  /** Shown after the last row, such as a waiting run's resume card. */
  end?: ReactNode;
  /** In a fork, when its history copied from the original was logged: rows up to it show muted. */
  copiedAt?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Threads' titles, to name the thread that sent a message or stopped this one (0041).
  const titles = useContext(ThreadLinksContext)?.state.titles;
  const atBottom = useRef(true);
  // Whether Scroll to end's smooth scroll is on its way down.
  const ending = useRef(false);
  // Which tool calls and thoughts are expanded, kept here since rows unmount off screen.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (key: string, next: boolean) =>
      setOpen((prev) => {
        const set = new Set(prev);
        if (next) set.add(key);
        else set.delete(key);
        return set;
      }),
    [],
  );

  const going = live && !stalled && !turnDone;
  // While a turn goes, as T3 Code shows one (PLX-584): a working line under its prompt with how
  // long it has gone, its work as steps, and a musing row at the end whenever the agent has
  // nothing in flight, as after a message or a call that finished. A message on its way to the
  // agent gets both too, even before the run goes again. The musing goes before any notices
  // after the last row, where the work it stands for will be.
  const view = useMemo(() => {
    const grouped: ViewRow[] = groupWork(withPlanApprovals(withPlans(rows)));
    const tail = grouped.findLastIndex((r) => r.kind !== "notice");
    // A compaction under way shows only while it's what the agent is doing.
    const shown = grouped.filter(
      (r, i) => r.kind !== "compaction" || r.done || (going && i === tail),
    );
    const at = shown.findLastIndex((r) => r.kind !== "notice");
    const last = shown[at];
    const pending = last?.kind === "pending";
    const busy =
      (last?.kind === "work" && !last.done && inFlight(last)) ||
      (last?.kind === "assistant" && !!last.partial) ||
      (last?.kind === "approval" && !last.resolved) ||
      (last?.kind === "compaction" && !last.done) ||
      last?.kind === "end";
    if (stalled || !(pending || going)) return shown;
    if (pending || !busy) shown.splice(at + 1, 0, { kind: "musing", key: "musing" });
    const prompt = shown.findLastIndex((r) => r.kind === "user" || r.kind === "pending");
    const since = shown[prompt]?.kind === "user" ? (shown[prompt] as Item).at : undefined;
    if (prompt >= 0) shown.splice(prompt + 1, 0, { kind: "working", key: "working", since });
    return shown;
  }, [rows, going, stalled]);
  // The work the agent is doing now: the last row's, while a call in it runs.
  const tail = view.findLastIndex((r) => r.kind !== "notice" && r.kind !== "musing");
  const tailRow = view[tail];
  const activeIndex =
    going && tailRow?.kind === "work" && !tailRow.done && inFlight(tailRow) ? tail : -1;
  const copied = (row: ViewRow) => {
    const at = row.kind === "work" ? row.startedAt : "at" in row ? row.at : undefined;
    return !!copiedAt && !!at && Date.parse(at) <= Date.parse(copiedAt);
  };
  // A turn forks once it ends (0050), so the latest message offers no Fork while the run goes.
  const latest = view.findLastIndex((r) => r.kind === "user" || r.kind === "pending");
  // The last reply of each turn, by row index, with the turn's id: where Fork and Copy sit.
  const replies = useMemo(() => {
    const byTurn = new Map<string | undefined, number>();
    let turn: string | undefined;
    view.forEach((row, i) => {
      if (row.kind === "user" || row.kind === "pending")
        turn = row.kind === "user" ? row.turnId : undefined;
      else if (row.kind === "assistant") byTurn.set(turn, i);
    });
    return new Map([...byTurn].map(([id, i]) => [i, id]));
  }, [view]);

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: 24,
    getItemKey: (i) => view[i]!.key,
  });
  const total = virtualizer.getTotalSize();
  // Whether it's scrolled up from the end, which offers Scroll to end.
  const [scrolledUp, setScrolledUp] = useState(false);
  // The user's prompts, for the rail, and which one is being read.
  const prompts = useMemo(() => promptsOf(view, sent), [view, sent]);
  const [reading, setReading] = useState(-1);
  // The prompt being read: the last one starting above the viewport's top third, so a prompt
  // counts once its reply fills the view, and at the end, the latest.
  const follow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const line = el.scrollTop + el.clientHeight / 3;
    const starts = virtualizer.measurementsCache;
    const at = atBottom.current
      ? prompts.length - 1
      : prompts.findLastIndex((p) => (starts[p.index]?.start ?? Infinity) <= line);
    setReading(Math.max(0, at));
  }, [prompts, virtualizer]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    follow();
  }, [total, view.length, follow, !!end]);
  // Older rows put in above change the first row, so what's in view keeps its distance from the
  // end instead of from the top. Then, near the top, the next older page loads.
  const first = view[0]?.key;
  const above = useRef({ first, fromEnd: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (first !== above.current.first && !atBottom.current)
      el.scrollTop = el.scrollHeight - above.current.fromEnd;
    above.current = { first, fromEnd: el.scrollHeight - el.scrollTop };
    if (onNearTop && el.scrollTop < el.clientHeight) onNearTop();
  });
  // As the composer grows it shrinks the list from below: keep the latest output in view.
  useEffect(() => {
    const el = scrollRef.current!;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    ending.current = true;
    setScrolledUp(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  const jump = (prompt: Prompt) => {
    ending.current = false;
    virtualizer.scrollToIndex(prompt.index, { align: "start" });
  };
  // What each row says, for Find: the messages, as they read rendered.
  const texts = useMemo(
    () =>
      view.map((row) => {
        if (row.kind === "user")
          return searchText(row.text ?? (row.turnId && sent.get(row.turnId)?.text) ?? "");
        if (row.kind === "pending" || row.kind === "assistant") return searchText(row.text);
        return row.kind === "proposedPlan" ? searchText(row.plan) : "";
      }),
    [view, sent],
  );
  const { bar: findBar } = useFind({
    texts,
    list: scrollRef,
    scrollToRow: (row) => {
      ending.current = false;
      virtualizer.scrollToIndex(row, { align: "center" });
    },
  });

  return (
    // Bounds the rail and Scroll to end, which stay put while the list scrolls under them.
    <RootContext value={root}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          role="log"
          aria-label="Transcript"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            if (atBottom.current) ending.current = false;
            // Scroll to end's smooth scroll passes through the middle, where it stays hidden.
            if (!ending.current) setScrolledUp(!atBottom.current);
            above.current.fromEnd = el.scrollHeight - el.scrollTop;
            if (onNearTop && el.scrollTop < el.clientHeight) onNearTop();
            follow();
          }}
          // Scrolling by hand cuts Scroll to end's scroll short.
          onWheel={() => (ending.current = false)}
          onPointerDown={() => (ending.current = false)}
          onKeyDown={() => (ending.current = false)}
          className="min-h-0 flex-1 overflow-y-auto select-text"
        >
          <div className="relative w-full" style={{ height: total }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = view[v.index]!;
              const muted = copied(row);
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <div
                    data-copied={muted || undefined}
                    className={`mx-auto max-w-3xl px-6 ${listKinds.has(row.kind) && listKinds.has(view[v.index - 1]?.kind ?? "") ? "pb-2" : "py-2"} ${muted ? "opacity-60" : ""}`}
                  >
                    <RowView
                      row={row}
                      sent={"turnId" in row && row.turnId ? sent.get(row.turnId) : undefined}
                      live={going}
                      open={open.has(row.key)}
                      openKeys={row.kind === "work" ? open : undefined}
                      active={v.index === activeIndex}
                      onToggle={toggle}
                      onResend={onResend}
                      loadImage={loadImage}
                      sender={"from" in row && row.from ? titles?.[row.from] : undefined}
                      copied={muted}
                      forkable={!muted && !(live && v.index >= latest)}
                      reply={replies.has(v.index) ? { turnId: replies.get(v.index) } : undefined}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {end && <div className="mx-auto max-w-3xl px-6 pb-6">{end}</div>}
        </div>
        {/* One prompt is no choice of where to go, so there's no rail for it. */}
        {prompts.length > 1 && <PromptRail prompts={prompts} current={reading} onJump={jump} />}
        {scrolledUp && <ScrollToEnd onClick={scrollToEnd} />}
        {findBar}
      </div>
    </RootContext>
  );
}

// Rows of the agent's work, which sit closer after one another, as one list (PLX-584).
const listKinds = new Set(["work", "plan", "todo", "musing", "compaction"]);

/**
 * The user's prompts among `view`'s rows, for the rail: a follow-up's text from `sent` when the
 * log lacks it, and the start of the agent's last reply before the next prompt. Parallax's own
 * wake-ups and other threads' messages aren't the user's, and replies to them aren't replies to
 * the prompt before.
 */
function promptsOf(view: readonly ViewRow[], sent: ReadonlyMap<string, SentMessage>): Prompt[] {
  const prompts: Prompt[] = [];
  let last: Prompt | undefined;
  view.forEach((row, index) => {
    if (row.kind === "user" && notTheUsers(row)) last = undefined;
    else if (row.kind === "user" || row.kind === "pending") {
      const said = row.text ?? (row.kind === "user" && row.turnId && sent.get(row.turnId)?.text);
      const text = said ? plainText(said) : "";
      last = { index, text: text || (row.images?.length ? "Image" : "Follow-up message") };
      prompts.push(last);
    } else if (row.kind === "assistant" && last) {
      const reply = plainText(row.text.split(/\n\s*\n/).find((p) => p.trim()) ?? "");
      if (reply) last.reply = reply;
    }
  });
  return prompts;
}

// A proposed plan the user sent back, by its row, so the row keeps its object (RowView's memo).
const sentBack = new WeakMap<ProposedPlanRow, ProposedPlanRow>();

/**
 * Proposed plans with their `ExitPlanMode` requests (PLX-196): one still waiting is pinned over the
 * composer instead, so it doesn't show twice, and one the user sent back reads as not approved,
 * however its call ended.
 */
function withPlanApprovals(rows: Exclude<ViewRow, Work>[]): Exclude<ViewRow, Work>[] {
  const asked = new Map<string, Approval>();
  for (const row of rows)
    if (row.kind === "approval" && row.request.toolName === "ExitPlanMode" && row.request.callId)
      asked.set(row.request.callId, row);
  if (asked.size === 0) return rows;
  return rows.flatMap((row): Exclude<ViewRow, Work>[] => {
    if (row.kind !== "proposedPlan") return [row];
    const approval = asked.get(row.callId);
    if (approval && !approval.resolved) return [];
    const { decision, by } = approval?.resolved ?? {};
    if (decision !== "denied" || by !== "user" || row.status === "denied") return [row];
    const denied = sentBack.get(row) ?? { ...row, status: "denied" as const };
    sentBack.set(row, denied);
    return [denied];
  });
}

interface RowProps {
  row: ViewRow;
  /** A follow-up this window sent: its text, which an older log lacks, and its images, at hand. */
  sent?: SentMessage;
  /** Whether the run is going, so a tool call with no result is still in progress. */
  live: boolean;
  open: boolean;
  /** For a work row: which of its items are expanded. */
  openKeys?: ReadonlySet<string>;
  /** For a work row: whether it is the one the agent is working in now. */
  active?: boolean;
  onToggle: (key: string, open: boolean) => void;
  /** Sends a dropped follow-up again. */
  onResend?: (turnId: string, message: SentMessage) => void;
  /** Fetches a message's image by id, as a data URL. */
  loadImage?: (imageId: ImageId) => Promise<string | undefined>;
  /** The title of the thread a message or a stop came from, when the row has one and it's known. */
  sender?: string;
  /** Whether a fork copied it from the original (0050), so its logged time is the fork's. */
  copied?: boolean;
  /** For a user's message: whether its turn can fork, where the chat offers Fork. */
  forkable?: boolean;
  /** For an assistant message: set on a turn's last, which offers Copy and Fork at `turnId`. */
  reply?: { turnId?: string };
}

/** A message Parallax or another thread sent, not the user (0025, 0041). */
const notTheUsers = (row: Extract<Item, { kind: "user" }>) => row.wake || row.from !== undefined;

/** One transcript row. Memoized: an unchanged item keeps its object, so it skips re-rendering. */
export const RowView = memo(function RowView({
  row,
  sent,
  live,
  open,
  openKeys,
  active,
  onToggle,
  onResend,
  loadImage,
  sender,
  copied,
  forkable,
  reply,
}: RowProps) {
  switch (row.kind) {
    case "work":
      return row.done ? (
        <WorkGroup
          work={row}
          live={live}
          open={open}
          openKeys={openKeys ?? new Set()}
          onToggle={onToggle}
          copied={copied}
        />
      ) : (
        <Steps
          work={row}
          active={active ?? false}
          live={live}
          open={open}
          openKeys={openKeys ?? new Set()}
          onToggle={onToggle}
        />
      );
    case "working":
      return <WorkingFor since={row.since} />;
    case "musing":
      return (
        <div className="flex h-6 items-center gap-2 text-[13px]">
          <Musing />
        </div>
      );
    case "compaction":
      // Under way, it's the live row; done, a divider where the earlier conversation became a summary.
      return row.done ? (
        <div className="flex items-center gap-2 text-[12px] text-faint-foreground">
          <span className="h-px flex-1 bg-border" />
          <FoldVertical aria-hidden className="size-3.5" />
          <span>Context compacted</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : (
        <div className="flex h-6 items-center gap-2 text-[13px]">
          <Loader {...loaders.compacting} />
          <Shimmer>Compacting context</Shimmer>
        </div>
      );
    case "user":
    case "pending": {
      // A wake-up is Parallax's message to the coordinator, not the user's (0025).
      if (row.kind === "user" && row.wake)
        return (
          <Disclosure
            id={row.key}
            open={open}
            onToggle={onToggle}
            summary={
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Workflow aria-hidden className="size-3.5" />
                From Parallax: subagents finished
              </span>
            }
          >
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {row.text}
            </p>
          </Disclosure>
        );
      // Another thread's message, sent with its Parallax tools (0041).
      if (row.kind === "user" && row.from)
        return (
          <Disclosure
            id={row.key}
            open={open}
            onToggle={onToggle}
            summary={
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Workflow aria-hidden className="size-3.5" />
                {sender ? `From another thread: ${sender}` : "From another thread"}
              </span>
            }
          >
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {row.text ?? "Follow-up message"}
            </p>
          </Disclosure>
        );
      const text = row.text ?? sent?.text;
      // Images sent from here are at hand; the log's come from plxd by id.
      const images = row.kind === "pending" ? row.images : (sent?.images ?? row.images);
      const threads = row.threads ?? sent?.threads;
      return (
        <div className="group/prompt flex flex-col items-end gap-1.5">
          {images && images.length > 0 && (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {images.map((image, i) => (
                <MessageImage key={i} image={image} loadImage={loadImage} />
              ))}
            </div>
          )}
          {/* The threads attached as context, which open from here (PLX-378). */}
          {threads && threads.length > 0 && (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {threads.map((id) => (
                <SentThread key={id} runId={id} />
              ))}
            </div>
          )}
          {/* A message of images alone has no bubble. */}
          {(!images?.length || text?.trim() !== "") && (
            <div className="max-w-[85%] rounded-2xl bg-selected px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap">
              {/* A follow-up from an older log, which has no text for it. */}
              {text ?? <span className="text-muted-foreground italic">Follow-up message</span>}
            </div>
          )}
          <PromptMeta
            at={row.kind === "user" && !copied ? row.at : undefined}
            text={text}
            fork={forkable && row.kind === "user" && <ForkButton turnId={row.turnId} />}
          />
        </div>
      );
    }
    case "assistant": {
      // A long streaming message renders block by block. A short one renders whole, as when finished.
      const body =
        row.partial && row.text.length >= SPLIT_FROM ? (
          <StreamingMarkdown text={row.text} />
        ) : (
          <MarkdownText text={row.text} />
        );
      if (!reply || row.partial) return body;
      return (
        <div className="group/prompt flex flex-col gap-1.5">
          {body}
          <PromptMeta text={row.text} fork={forkable && <ForkButton turnId={reply.turnId} />} />
        </div>
      );
    }
    case "reasoning":
      // The thought itself, on one line, as T3 Code shows it.
      return (
        <Disclosure
          id={row.key}
          open={open}
          onToggle={onToggle}
          summary={
            <>
              <icons.thinking aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{plainText(row.text) || "Thought"}</span>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {row.text}
          </p>
        </Disclosure>
      );
    case "tool":
      return <ToolCall item={row} live={live} open={open} onToggle={onToggle} />;
    case "plan":
    case "todo":
      // The turn's plan and its later updates, as lines: the strip shows the whole list.
      return <PlanLine item={row} />;
    case "proposedPlan":
      return (
        <ProposedPlan id={row.key} status={row.status} open={open} onToggle={onToggle}>
          <MarkdownText text={row.plan} />
        </ProposedPlan>
      );
    case "approval":
      // A permission request's line: waiting, then how it was answered (PLX-196).
      return (
        <Disclosure
          id={row.key}
          open={open}
          onToggle={onToggle}
          summary={
            <ApprovalSummary
              approval={row}
              tool={describeTool(row.request.toolName, row.request.input)}
            />
          }
        >
          <ApprovalDetails approval={row} />
        </Disclosure>
      );
    case "notice":
      return (
        <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
          {row.tone === "warning" ? (
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>
            {row.from && sender ? `Stopped by another thread: ${sender}.` : row.text}
            {/* A dropped follow-up this window sent: offer it again, rather than lose it. */}
            {row.turnId && sent !== undefined && onResend && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => onResend(row.turnId!, sent)}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Send again
                </button>
              </>
            )}
          </span>
        </p>
      );
    case "modelSwitch":
      // Where the thread moved to another model (PLX-495), as T3 Code's context handoff.
      return (
        <div className="flex items-center gap-2 text-[12px] text-faint-foreground">
          <span className="h-px flex-1 bg-border" />
          <ArrowLeftRight aria-hidden className="size-3.5" />
          <span>Switched model</span>
          <ModelLabel model={row.from} />
          <ArrowRight aria-hidden className="size-3.5" />
          <ModelLabel model={row.to} />
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "end": {
      const { outcome } = row;
      if (outcome.status === "failed") {
        // A coordinator's no-write stop lists what it changed after its first line, one
        // `git status` line each (0024).
        const [first, ...changed] = outcome.message.split("\n");
        return (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 px-3.5 py-2.5 text-[13px]"
          >
            <p className="font-medium text-danger">Failed: {failureText(outcome.failure)}</p>
            <p className="mt-0.5 text-muted-foreground">{first}</p>
            {changed.length > 0 && (
              <pre className="mt-2 max-h-60 overflow-auto rounded-xl border border-border bg-code px-3 py-2 font-mono text-[12px]">
                {changed.join("\n")}
              </pre>
            )}
          </div>
        );
      }
      const label =
        outcome.status === "completed"
          ? "Done"
          : outcome.status === "cancelled"
            ? "Stopped"
            : outcome.status === "interrupted"
              ? "Interrupted when plxd stopped. Send a message to pick up where it left off."
              : "Ended";
      return (
        <div className="flex items-center gap-3 text-[12px] text-faint-foreground">
          <span className="h-px flex-1 bg-border" />
          {label}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }
  }
});

/** A model's name after its provider's logo, when this app knows the model. */
function ModelLabel({ model }: { model: string }) {
  const provider = knownModel(model)?.provider;
  const Logo = provider ? kinds[provider]?.Logo : undefined;
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {Logo && <Logo aria-hidden className="size-3.5" />}
      {modelName(model)}
    </span>
  );
}

/**
 * One of a user message's images, as a thumbnail: at hand, or fetched by id. The same height
 * either way, so the row doesn't jump when it loads.
 */
function MessageImage({
  image,
  loadImage,
}: {
  image: PromptImage | ImageId;
  loadImage?: (imageId: ImageId) => Promise<string | undefined>;
}) {
  // By id: its data URL once fetched, or null when plxd couldn't serve it.
  const [fetched, setFetched] = useState<{ id: ImageId; url: string | null }>();
  useEffect(() => {
    if (typeof image !== "string" || !loadImage) return;
    let live = true;
    void loadImage(image).then((url) => live && setFetched({ id: image, url: url ?? null }));
    return () => {
      live = false;
    };
  }, [image, loadImage]);
  const url =
    typeof image === "string" ? (fetched?.id === image ? fetched.url : undefined) : imageUrl(image);
  if (url)
    return (
      <img
        src={url}
        alt="Image"
        className="h-32 max-w-60 rounded-xl border border-border object-cover"
      />
    );
  return (
    <span
      role="img"
      aria-label={url === null ? "Image unavailable" : "Loading image"}
      className="grid h-32 w-32 place-items-center rounded-xl border border-border bg-selected text-faint-foreground"
    >
      {url === null && <ImageOff aria-hidden className="size-5" />}
    </span>
  );
}

/**
 * A finished turn's work under one dropdown (PLX-326): how long it worked, opening to its steps
 * and the messages it folded, as T3 Code's turn fold does. A fork's `copied` work says only
 * "Worked", since its logged times are all the fork's creation (0050).
 */
function WorkGroup({
  work,
  live,
  open,
  openKeys,
  onToggle,
  copied,
}: {
  work: Work;
  live: boolean;
  open: boolean;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
  copied?: boolean;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(work.key, !open)}
        className={`${stepRow} text-muted-foreground`}
      >
        <span className="truncate">
          {copied ? "Worked" : workedFor(work.startedAt, work.endedAt)}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {stepRuns(work.items).map((item) => (
            <RowView
              key={item.key}
              row={item}
              live={live}
              open={openKeys.has(item.key)}
              openKeys={item.kind === "work" ? openKeys : undefined}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The kinds of rows that are steps of the agent's work, as opposed to its messages. */
const stepKinds = new Set(["reasoning", "tool", "todo", "notice"]);

/** A finished turn's items, with each run of steps between its messages as one open `Work`. */
function stepRuns(items: readonly Item[]): (Item | Work)[] {
  const out: (Item | Work)[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.some((i) => i.kind !== "notice"))
      out.push({ kind: "work", key: `steps:${run[0]!.key}`, items: run });
    else out.push(...run);
    run = [];
  };
  for (const item of items)
    if (stepKinds.has(item.kind)) run.push(item);
    else {
      flush();
      out.push(item);
    }
  flush();
  return out;
}

/** Whether a run of steps has a call still running: its last step, a tool with no result yet. */
const inFlight = (work: Work) => {
  const last = work.items.findLast((i) => i.kind !== "notice");
  return last?.kind === "tool" && last.status === undefined;
};

/** A compact step row's geometry, as T3 Code's work log draws one: an icon, a line, a chevron. */
const stepRow =
  "flex min-h-6 w-full max-w-full min-w-0 cursor-default items-center gap-2 rounded-md text-left text-[13px] hover:text-foreground";

/** The chevron at a step row's end, turned down while it's open. */
function Chevron({ open }: { open?: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      className={`ml-auto size-3.5 shrink-0 text-faint-foreground transition-transform group-open/disclosure:rotate-90 ${open ? "rotate-90" : ""}`}
    />
  );
}

/**
 * A run of steps between the agent's messages in a turn still going (PLX-584): one call or thought
 * alone as its own row, or several as one line saying what they did, such as "Ran 3 commands and
 * read 2 files", opening to a row each. While a call in it runs, the line says what the agent is
 * doing instead, with that work's loader.
 */
function Steps({
  work,
  active,
  live,
  open,
  openKeys,
  onToggle,
}: {
  work: Work;
  active: boolean;
  live: boolean;
  open: boolean;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
}) {
  const only = work.items.length === 1 ? work.items[0]! : undefined;
  if (only && !active)
    return <RowView row={only} live={live} open={openKeys.has(only.key)} onToggle={onToggle} />;
  const now = active ? activity(work.items.findLast((i) => i.kind !== "notice")) : undefined;
  const summary = summarize(work.items);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(work.key, !open)}
        className={`${stepRow} text-muted-foreground`}
      >
        {now ? (
          <>
            <Loader {...now.loader} size={14} />
            {/* Keyed, so a new label fades in. */}
            <span key={now.label} className="working-in shrink-0 text-foreground">
              <Shimmer>{now.label}</Shimmer>
            </span>
            {now.detail && <span className="truncate">{now.detail}</span>}
          </>
        ) : (
          <>
            <span
              aria-hidden
              className={`relative shrink-0 ${summary.failed ? "text-danger" : ""}`}
            >
              <summary.Icon className="size-3.5" />
              {summary.failed && (
                <X
                  strokeWidth={3}
                  className="absolute -right-1.5 -bottom-1.5 size-2.5 rounded-full bg-background"
                />
              )}
            </span>
            <span className="truncate">{summary.label}</span>
            {summary.failed && <span className="sr-only">, one failed</span>}
          </>
        )}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="flex flex-col">
          {work.items.map((item) => (
            <RowView
              key={item.key}
              row={item}
              live={live}
              open={openKeys.has(item.key)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The line under a going turn's prompt: how long it has worked so far, ticking each second. */
function WorkingFor({ since }: { since?: string }) {
  // A message still on its way has no time logged yet: from when this row first showed.
  const [from] = useState(() => since ?? new Date().toISOString());
  return (
    <p className="border-b border-border/60 pb-2 text-[13px] text-muted-foreground tabular-nums">
      Working for {duration(useSeconds(since ?? from))}
    </p>
  );
}

// A word for what the agent might be doing before it does anything, and how often it changes.
const musings = [
  "Picturing",
  "Pondering",
  "Sketching",
  "Mulling",
  "Brewing",
  "Tinkering",
  "Percolating",
  "Noodling",
];
const musingMs = 2400;

/**
 * The working line before the agent does anything: a loader and a word that changes every few
 * seconds, which screen readers hear as a steady "Working".
 */
function Musing() {
  // Picked by the wall clock, so a remount (New Thread handing off to the opened thread) keeps the
  // sequence. A word fades in, and the last one out, only once it changes here. Under reduced
  // motion it keeps one.
  const [tick, setTick] = useState(() => Math.floor(Date.now() / musingMs));
  const [first] = useState(tick);
  useEffect(() => {
    if (document.documentElement.classList.contains("reduce-motion")) return;
    const timer = setTimeout(
      () => setTick(Math.max(tick + 1, Math.floor(Date.now() / musingMs))),
      musingMs - (Date.now() % musingMs),
    );
    return () => clearTimeout(timer);
  }, [tick]);
  const word = (at: number) => musings[at % musings.length]!;
  return (
    <>
      <Loader {...loaders.working} />
      <span className="sr-only">Working</span>
      <span aria-hidden className="grid shrink-0 justify-items-start">
        {tick > first && (
          <span key={tick - 1} className="working-out [grid-area:1/1]">
            <Shimmer>{word(tick - 1)}</Shimmer>
          </span>
        )}
        <span key={tick} className={`[grid-area:1/1] ${tick > first ? "working-in" : ""}`}>
          <Shimmer>{word(tick)}</Shimmer>
        </span>
      </span>
    </>
  );
}

// How long the shimmer takes to sweep across its text.
const shimmerMs = 2000;

/** Text with a soft highlight sweeping across it, on the wall clock so a remount carries on. */
function Shimmer({ children }: { children: string }) {
  const [now] = useState(Date.now);
  return (
    <span
      className="working-shimmer"
      style={{ animationDuration: `${shimmerMs}ms`, animationDelay: `${-(now % shimmerMs)}ms` }}
    >
      {children}
    </span>
  );
}

// What a tool is doing, in a word, by the names common tools use.
const verbs: Partial<Record<string, string>> = {
  Bash: "Running",
  Read: "Reading",
  Grep: "Searching",
  Glob: "Searching",
  WebSearch: "Searching",
  WebFetch: "Fetching",
  Edit: "Editing",
  MultiEdit: "Editing",
  Write: "Writing",
  Task: "Running agent",
  Agent: "Running agent",
};

/** The loader for each kind of work. */
const loaders = {
  thinking: { kind: "matrix", variant: "ripple" },
  shell: { kind: "register", variant: "shift" },
  reading: { kind: "bands", variant: "descend" },
  searching: { kind: "matrix", variant: "scan" },
  editing: { kind: "cells", variant: "merge" },
  writing: { kind: "cells", variant: "merge" },
  fetching: { kind: "beacon", variant: "rise" },
  agent: { kind: "orbit", variant: "oppose" },
  skill: { kind: "lift", variant: "rise" },
  mcp: { kind: "beacon", variant: "balance" },
  plxd: { kind: "cells", variant: "spread" },
  planning: { kind: "lift", variant: "breathe" },
  working: { kind: "orbit", variant: "chase" },
  compacting: { kind: "bands", variant: "descend" },
} as const satisfies Record<string, LoaderStyle>;

type Kind = keyof typeof loaders;

/** The icon for each kind of work, in place of its loader once it's done. */
const icons = {
  thinking: Brain,
  shell: SquareTerminal,
  reading: FileText,
  searching: Search,
  editing: Pencil,
  writing: FilePlus,
  fetching: Globe,
  agent: Bot,
  skill: Sparkles,
  mcp: Plug,
  plxd: Workflow,
  planning: ListChecks,
  working: Hammer,
  compacting: FoldVertical,
} as const satisfies Record<Kind, LucideIcon>;

// The kind of work a tool does, by the names common tools use.
const toolKinds: Partial<Record<string, Kind>> = {
  Bash: "shell",
  Read: "reading",
  NotebookRead: "reading",
  LS: "reading",
  Grep: "searching",
  Glob: "searching",
  WebSearch: "searching",
  ToolSearch: "searching",
  Edit: "editing",
  MultiEdit: "editing",
  NotebookEdit: "editing",
  Write: "writing",
  WebFetch: "fetching",
  Task: "agent",
  Agent: "agent",
  Skill: "skill",
  TodoWrite: "planning",
  // Claude Code's task tools, which keep its plan in place of TodoWrite (PLX-248).
  TaskCreate: "planning",
  TaskUpdate: "planning",
  TaskList: "planning",
  TaskGet: "planning",
};

/** The kind of work a tool call does: a plxd or other MCP server's tool, or by its name. */
function toolKind(item: Extract<Item, { kind: "tool" }>): Kind {
  if (item.name?.startsWith(plxdTools)) return "plxd";
  if (mcpTool(item.name)) return "mcp";
  // The table's own names only, so "constructor" or "toString" is any other tool.
  const name = item.name ?? "";
  return (Object.hasOwn(toolKinds, name) && toolKinds[name]) || "working";
}

/** What the agent is doing: a label, what it's doing it to, and the loader drawn beside them. */
export interface Activity {
  label: string;
  detail?: string;
  loader: LoaderStyle;
}

/** The header of the work in progress: what its latest item is doing. */
export function activity(item?: Item): Activity {
  switch (item?.kind) {
    case "reasoning":
      return { label: "Thinking", loader: loaders.thinking };
    case "tool": {
      const loader = loaders[toolKind(item)];
      const plxd = plxdCall(item);
      if (plxd) return { ...plxd, loader };
      // Including a plxd tool this app doesn't know.
      const mcp = mcpTool(item.name);
      if (mcp) return { label: `Using ${mcp.server}`, detail: mcp.tool, loader };
      if (item.name === "Skill")
        return { label: "Using skill", detail: skillName(item.input), loader };
      return {
        label: verbs[item.name ?? ""] ?? item.name ?? "Working",
        detail: toolHint(item.input),
        loader,
      };
    }
    case "todo":
      return { label: "Planning", loader: loaders.planning };
    default:
      return { label: "Working", loader: loaders.working };
  }
}

function ToolCall({
  item,
  live,
  open,
  onToggle,
}: {
  item: Extract<Item, { kind: "tool" }>;
  live: boolean;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
}) {
  // A call that started one of the agent's own subagents opens it (PLX-382).
  const subagents = useContext(SubagentsContext);
  const root = useContext(RootContext);
  if (isSubagentTool(item.name) && subagents?.subagents[item.callId])
    return <SubagentCall item={item} />;
  const kind = toolKind(item);
  const status = item.status ?? (live ? "running" : "none");
  // A status newer than this app reads as no result.
  const look = (statuses as Partial<Record<string, Look>>)[status] ?? statuses.none;
  const Icon = icons[kind];
  return (
    <Disclosure
      id={item.key}
      open={open}
      onToggle={onToggle}
      summary={
        <>
          {/* Its kind: the loader while it runs, then the icon, with a mark unless it succeeded. */}
          <span aria-hidden className={`relative shrink-0 ${look.color}`}>
            {status === "running" ? (
              <Loader {...loaders[kind]} size={14} />
            ) : (
              <Icon className={`size-3.5 ${look.faded ? "opacity-50" : ""}`} />
            )}
            {look.mark && (
              <look.mark
                strokeWidth={3}
                className="absolute -right-1.5 -bottom-1.5 size-2.5 rounded-full bg-background"
              />
            )}
          </span>
          <span className="truncate">{stepLabel(item, root)}</span>
          <span className="sr-only">{look.said}</span>
        </>
      }
    >
      <div className="space-y-2 text-[12px]">
        {item.name && previewed.has(item.name) && isWhole(item.input) ? (
          <div>
            <p className="mb-1 text-[11.5px] text-faint-foreground">Input</p>
            <RequestPreview request={{ toolName: item.name, input: item.input }} />
          </div>
        ) : (
          item.input !== undefined && <Block label="Input">{inputText(item.input)}</Block>
        )}
        {item.output !== undefined && <Block label="Output">{item.output}</Block>}
      </div>
    </Disclosure>
  );
}

/** How a tool call went: its icon's color, mark, and fading, and in words for screen readers. */
interface Look {
  color: string;
  mark?: LucideIcon;
  /** Whether the icon fades, as for a call that never finished. */
  faded?: boolean;
  said: string;
}

// An unfinished call's icon is half its faint color, so it stands apart from a finished one's
// muted icon, and its mark is an ellipsis, which no round icon can swallow as a ring could.
const statuses = {
  running: { color: "", said: "Running" },
  ok: { color: "text-muted-foreground", said: "Succeeded" },
  error: { color: "text-danger", mark: X, said: "Failed" },
  denied: { color: "text-danger", mark: Ban, said: "Denied" },
  none: { color: "text-faint-foreground", mark: Ellipsis, faded: true, said: "No result" },
} satisfies Record<"running" | AgentToolStatus | "none", Look>;

/** A collapsed-by-default step row, its chevron at its end, open state kept by the transcript. */
function Disclosure({
  id,
  open,
  onToggle,
  summary,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(e) => e.currentTarget.open !== open && onToggle(id, e.currentTarget.open)}
      className="group/disclosure"
    >
      <summary
        className={`${stepRow} list-none text-muted-foreground [&::-webkit-details-marker]:hidden`}
      >
        {summary}
        <Chevron />
      </summary>
      {/* Rendered once open, so a closed row doesn't hold its tool's output. */}
      {open && <div className="mt-1.5 ml-5.5">{children}</div>}
    </details>
  );
}

function Block({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <p className="mb-1 text-[11.5px] text-faint-foreground">{label}</p>
      <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-code px-3 py-2 font-mono leading-relaxed whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}

// The input field that says what a call does, by the names common tools use.
const hintFields = ["command", "file_path", "path", "pattern", "url", "query", "description"];

function toolHint(input?: JsonValue, fields = hintFields): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const value = fields.map((f) => input[f]).find((v) => typeof v === "string");
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

/** A path relative to the run's worktree, when it's inside it. */
function relative(path: string, root?: string) {
  if (!root) return path;
  const base = root.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
    ? path.slice(base.length + 1)
    : path;
}

/** The file a call acts on, relative to the run's worktree. */
const filePath = (input?: JsonValue, root?: string) =>
  relative(toolHint(input, ["file_path", "notebook_path", "path"]), root);

/**
 * A tool call's step row as a line, as T3 Code words one (PLX-584): the command it ran, or what it
 * did and to what. A plxd or other MCP server's tool reads by its server and tool.
 */
export function stepLabel(item: Extract<Item, { kind: "tool" }>, root?: string): string {
  const plxd = plxdCall(item);
  if (plxd) return plxd.detail ? `${plxd.label}: ${plxd.detail}` : plxd.label;
  const mcp = mcpTool(item.name);
  if (mcp) return `${mcp.server}: ${mcp.tool}`;
  const { input } = item;
  const path = filePath(input, root);
  const about = (verb: string, what: string, fallback: string) =>
    what ? `${verb} ${what}` : fallback;
  switch (item.name) {
    case "Bash":
      return toolHint(input, ["command"]) || "Ran a command";
    case "Read":
    case "NotebookRead":
      return about("Read", path, "Read a file");
    case "LS":
      return about("Listed", path, "Listed a folder");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return about("Edited", path, "Edited a file");
    case "Write":
      return about("Wrote", path, "Wrote a file");
    case "Grep": {
      const pattern = toolHint(input, ["pattern"]);
      return pattern ? `Searched ${pattern}${path ? ` in ${path}` : ""}` : "Searched code";
    }
    case "Glob":
      return about("Searched files", toolHint(input, ["pattern"]), "Searched files");
    case "WebSearch":
      return about("Searched the web for", toolHint(input, ["query"]), "Searched the web");
    case "WebFetch":
      return about("Fetched", toolHint(input, ["url"]), "Fetched a page");
    case "Skill":
      return about("Used skill", skillName(input), "Used a skill");
    case "Task":
    case "Agent":
      return about("Ran agent", toolHint(input, ["description"]), "Ran an agent");
  }
  const hint = toolHint(input);
  const name = item.name ?? "Tool";
  return hint ? `${name} ${hint}` : name;
}

/** What a run of steps did, in a line, and the icon for it. */
export interface StepsSummary {
  label: string;
  Icon: LucideIcon;
  /** Whether a call in it failed or was denied. */
  failed: boolean;
}

/**
 * What a run of steps did, as T3 Code sums one up (PLX-584): the MCP servers it used, then its two
 * main kinds of call with counts, commands and edits first, then how many others, as in "Used
 * Linear, ran 3 commands, and changed 2 files". Thoughts and notices aren't counted, unless
 * they're all there is.
 */
export function summarize(items: readonly Item[]): StepsSummary {
  const steps = items.filter((i) => i.kind !== "notice");
  const failed = steps.some(
    (i) => i.kind === "tool" && (i.status === "error" || i.status === "denied"),
  );
  const calls = steps.filter((i) => i.kind === "tool" || i.kind === "todo");
  if (calls.length === 0) {
    const n = steps.length;
    return { label: n === 1 ? "Thought" : `Thought ${n} times`, Icon: icons.thinking, failed };
  }
  const servers: string[] = [];
  const kinds = new Set<Kind>();
  // By kind of call, in the order each first came: its calls, and the files of edits.
  const counts = new Map<string, { calls: number; files: Set<string> }>();
  for (const call of calls) {
    const kind = call.kind === "todo" ? "planning" : toolKind(call);
    kinds.add(kind);
    if (call.kind === "tool" && (kind === "mcp" || kind === "plxd")) {
      const server = kind === "plxd" ? "Parallax" : mcpTool(call.name)!.server;
      if (!servers.includes(server)) servers.push(server);
      continue;
    }
    const group = call.kind === "tool" && call.name === "WebSearch" ? "web" : kind;
    const count = counts.get(group) ?? { calls: 0, files: new Set() };
    count.calls++;
    count.files.add(call.kind === "tool" ? filePath(call.input) || call.callId : call.key);
    counts.set(group, count);
  }
  const ranked = [...counts]
    .map(([group, count], order) => ({ group, count, order, rank: callRanks[group] ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, 2)
    .sort((a, b) => a.order - b.order);
  const parts = ranked.map(({ group, count }) => callLabel(group, count.calls, count.files.size));
  if (servers.length > 0) parts.unshift(`Used ${list(servers)}`);
  const others =
    calls.length -
    calls.filter((c) => c.kind === "tool" && ["mcp", "plxd"].includes(toolKind(c))).length -
    ranked.reduce((n, { count }) => n + count.calls, 0);
  if (others > 0) parts.push(`performed ${others} other ${others === 1 ? "action" : "actions"}`);
  const label = list(parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))));
  const [only] = kinds;
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    Icon: kinds.size === 1 ? icons[only!] : icons.working,
    failed,
  };
}

// Commands and edits lead a summary, and calls of tools this app doesn't know come last.
const callRanks: Partial<Record<string, number>> = { shell: 0, editing: 0, writing: 0, working: 2 };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** A kind of call in a summary, by how many there were and how many files they changed. */
function callLabel(group: string, calls: number, files: number): string {
  switch (group) {
    case "shell":
      return `Ran ${plural(calls, "command", "commands")}`;
    case "editing":
    case "writing":
      return `Changed ${plural(files, "file", "files")}`;
    case "reading":
      return `Read ${plural(calls, "file", "files")}`;
    case "searching":
      return `Searched code ${times(calls)}`;
    case "web":
      return `Searched the web ${times(calls)}`;
    case "fetching":
      return `Fetched ${plural(calls, "page", "pages")}`;
    case "agent":
      return `Ran ${plural(calls, "agent", "agents")}`;
    case "skill":
      return `Used ${plural(calls, "skill", "skills")}`;
    case "planning":
      return "Updated the plan";
    default:
      return `Used ${plural(calls, "tool", "tools")}`;
  }
}

/** "a", "a and b", or "a, b, and c". */
function list(parts: string[]): string {
  if (parts.length < 3) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

// A coordinator's plxd tools (0019), by what they did.
const plxdLabels: Partial<Record<string, string>> = {
  spawn_agent: "Started a subagent",
  list_agents: "Listed subagents",
  agent_status: "Checked on a subagent",
  message_agent: "Messaged a subagent",
  cancel_agent: "Stopped a subagent",
  agent_diff: "Read a subagent's diff",
  read_context: "Read shared context",
  write_context: "Wrote shared context",
};

/**
 * A plxd tool call as a short line: what it did, and what it did it to (the new subagent's task,
 * the subagent it named, or the context file). Undefined for any other tool.
 */
function plxdCall(item: Extract<Item, { kind: "tool" }>) {
  const label = item.name?.startsWith(plxdTools)
    ? plxdLabels[item.name.slice(plxdTools.length)]
    : undefined;
  return label
    ? { label, detail: item.subagent ?? toolHint(item.input, ["prompt", "path"]) }
    : undefined;
}

/**
 * An MCP server's tool as Claude Code names it, `mcp__<server>__<tool>`, readably: the server's
 * name, capitalized unless it's plxd's, and the tool's. Undefined for any other tool.
 */
function mcpTool(name: string | null) {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name ?? "") ?? [];
  if (!server || !tool) return undefined;
  const words = server.replace(/[_-]/g, " ");
  return {
    server: server === "plxd" ? server : words.charAt(0).toUpperCase() + words.slice(1),
    tool: tool.replaceAll("_", " "),
  };
}

/** The skill a Skill call runs: `skill`, or `command` from older Claude Code versions. */
const skillName = (input?: JsonValue) => toolHint(input, ["skill", "command"]);

/**
 * A tool as a permission request names it (PLX-196): its kind's icon, then its name and what it
 * acts on, as its row would, or an MCP server's tool by the server, plxd's too. It hasn't run
 * yet, so a plxd tool isn't named by what it did.
 */
export function describeTool(name: string, input?: JsonValue): ToolLook {
  const item = { kind: "tool", key: "", callId: "", name, input } as const;
  const named = namedTool(item);
  return {
    Icon: icons[toolKind(item)],
    label: named?.label ?? name,
    detail: named ? named.detail : toolHint(input),
  };
}

/**
 * A tool call its row names readably: an MCP server's tool by the server, including a plxd tool
 * this app doesn't know, or a skill.
 */
function namedTool(item: Extract<Item, { kind: "tool" }>) {
  const mcp = mcpTool(item.name);
  if (mcp) return { label: mcp.server, detail: mcp.tool };
  if (item.name === "Skill") return { label: "Skill", detail: skillName(item.input) };
  return undefined;
}

// Tools whose input reads better as a permission request shows it: an edit's diff.
const previewed = new Set(["Edit", "MultiEdit", "Write"]);

/** Whether a tool's input arrived whole, not cut for size. */
const isWhole = (input?: JsonValue): input is JsonValue =>
  input !== undefined &&
  !(input && typeof input === "object" && !Array.isArray(input) && input["truncated"] === true);

function inputText(input: JsonValue): string {
  if (input && typeof input === "object" && !Array.isArray(input) && input["truncated"] === true) {
    const bytes = typeof input["bytes"] === "number" ? input["bytes"] : 0;
    return `Too large to show (${Math.ceil(bytes / 1024)} KB)`;
  }
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

/** The icon before a web link, as T3 Code shows one: its site's logo, or a globe (PLX-330). */
export function linkIcon(href?: string) {
  let host;
  try {
    const url = new URL(href ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    host = url.hostname;
  } catch {
    return undefined;
  }
  const on = (site: string) => host === site || host.endsWith(`.${site}`);
  return on("github.com") ? GitHubLogo : on("linear.app") ? LinearLogo : Globe;
}

// Agent output is untrusted: no raw HTML (no rehype-raw), and react-markdown's
// default urlTransform drops javascript: and other unsafe links. Links open in
// a new window, which main hands to the system browser, https only.
const markdownComponents: Components = {
  a: ({ href, children }) => {
    const Icon = linkIcon(href);
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {Icon && (
          <Icon aria-hidden className="mr-1 inline size-3.5 align-[-0.15em] text-foreground" />
        )}
        {children}
      </a>
    );
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    const classes = code?.type === "element" ? code.properties["className"] : undefined;
    const language = Array.isArray(classes)
      ? classes
          .map(String)
          .find((c) => c.startsWith("language-"))
          ?.slice("language-".length)
      : undefined;
    return (
      <CodeBlock language={language} text={code ? textOf(code) : ""}>
        {children}
      </CodeBlock>
    );
  },
  // Never load images: a link with the alt text, which opens externally like any link.
  img: ({ src, alt }) => (
    // An unsafe source arrives as "" from urlTransform: no href at all, then.
    <a href={typeof src === "string" && src ? src : undefined} target="_blank" rel="noreferrer">
      {alt || "Image"}
    </a>
  ),
};

// Highlights a code block whose fence names its language, never a guess; a diff's lines are
// drawn by DiffLines instead.
const highlight: ComponentProps<typeof Markdown>["rehypePlugins"] = [
  [rehypeHighlight, { detect: false, plainText: ["diff", "patch"] }],
];

/** A Markdown tree node's text, as a code block's, for Copy. */
type TextNode = { value?: string; children?: TextNode[] };
const textOf = (node: TextNode): string => node.value ?? node.children?.map(textOf).join("") ?? "";

/**
 * An agent message, rendered from Markdown with GitHub's extensions. `components` replace some
 * elements' renderers, such as the Context view's links; they get the same safe, HTML-free tree.
 */
export function MarkdownText({ text, components }: { text: string; components?: Components }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={gfm}
        rehypePlugins={highlight}
        components={{ ...markdownComponents, ...components }}
      >
        {text}
      </Markdown>
    </div>
  );
}

const gfm = [remarkGfm];

/**
 * A streaming agent message, rendered as MarkdownText renders it, but block by block: an
 * unchanged block keeps its string, so its memo skips rendering it again, and each update
 * renders only the last block (PLX-448). When the message finishes, its row switches to
 * MarkdownText, which renders it whole once and remounts its code blocks.
 */
function StreamingMarkdown({ text }: { text: string }) {
  // The last update's blocks, so the split parses only the end of the message again.
  const blocks = useRef<string[]>([]);
  blocks.current = markdownBlocks(text, blocks.current);
  return (
    <div className="markdown">
      {blocks.current.map((block, i) => (
        <MarkdownBlock key={i} text={block} />
      ))}
    </div>
  );
}

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={gfm} rehypePlugins={highlight} components={markdownComponents}>
      {text}
    </Markdown>
  );
});

/** Copies text to the clipboard. `copied` is true for a moment after, for a Copied check. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return [copied, copy] as const;
}

/** Under a prompt, on hover or focus: when it was sent, Copy for its text, and `fork`. */
function PromptMeta({ at, text, fork }: { at?: string; text?: string | null; fork?: ReactNode }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex h-6 items-center gap-1 text-[12px] text-faint-foreground opacity-0 group-focus-within/prompt:opacity-100 group-hover/prompt:opacity-100">
      {at && <time dateTime={at}>{sentAt(at)}</time>}
      {text && (
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={() => copy(text)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          {copied ? <Check /> : <Copy />}
        </button>
      )}
      {fork}
    </div>
  );
}

/** "3:04 PM" today, and "Sep 25, 3:04 PM" before. */
function sentAt(at: string) {
  const date = new Date(at);
  const time = clockOptions();
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], time)
    : date.toLocaleString([], { month: "short", day: "numeric", ...time });
}

/**
 * A Markdown code block: a header with its fence's language and Copy, over its code, highlighted,
 * or a diff's lines.
 */
function CodeBlock({
  language,
  text,
  children,
}: {
  language?: string;
  text: string;
  children: ReactNode;
}) {
  const [copied, copy] = useCopy();
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-code">
      <div className="flex h-8 items-center justify-between border-b border-border pr-1 pl-3 text-[11.5px] text-faint-foreground">
        <span className="font-mono">{language ?? "text"}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() => copy(text)}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {language === "diff" || language === "patch" ? (
        <DiffLines text={text} />
      ) : (
        <pre className="code-lines overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed">
          {children}
        </pre>
      )}
    </div>
  );
}

/**
 * A unified diff's lines, as a permission request draws an edit. Hunk headers, and the file headers
 * before a file's first hunk, are bands, so a removed `-- comment` inside a hunk stays removed.
 */
function DiffLines({ text }: { text: string }) {
  let inHunk = false;
  return (
    <div className="code-scroll overflow-x-auto py-1.5 font-mono text-[12px] leading-relaxed">
      {text
        .replace(/\n$/, "")
        .split("\n")
        .map((line, i) => {
          if (line.startsWith("diff ")) inHunk = false;
          if (line.startsWith("@@")) inHunk = true;
          const op = line[0];
          if (line.startsWith("@@") || (!inHunk && /^(\+\+\+|---|diff |index )/.test(line)))
            return (
              <div key={i} className={`${diffBand} whitespace-pre-wrap`}>
                {line}
              </div>
            );
          return op === "+" || op === "-" || op === " " ? (
            <DiffRow key={i} op={op} text={line.slice(1)} />
          ) : (
            <DiffRow key={i} op=" " text={line} />
          );
        })}
    </div>
  );
}

/**
 * Where a run works in the composer's tab: `{host} · Local checkout` or `{host} · Worktree`, as
 * New Thread's `RunTargetMenu` reads. A Project's composer shows it too.
 */
export function CheckoutLabel({ host, checkout }: { host?: Host; checkout: boolean }) {
  return (
    <span className={`${tabItem} shrink-0`}>
      {host ? hostIcon(host) : checkout ? <Folder aria-hidden /> : <FolderGit2 aria-hidden />}
      {host && (
        <>
          {host.name}
          <span aria-hidden className="text-faint-foreground">
            ·
          </span>
        </>
      )}
      {checkout ? "Local checkout" : "Worktree"}
    </span>
  );
}

/**
 * An open run in the composer's tab: its host and checkout, then `children`, such as Open PR,
 * and the worktree's branch.
 */
export function RunTab({
  run,
  host,
  children,
}: {
  run: AgentRun;
  host?: Host;
  children?: ReactNode;
}) {
  return (
    <>
      <CheckoutLabel host={host} checkout={!!run.checkout} />
      <span className="flex min-w-0 items-center">
        {children}
        {run.branch && (
          <span className={tabItem} title={`Worktree branch: ${run.branch}`}>
            <GitBranch aria-hidden />
            <span className="truncate">{run.branch}</span>
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Open PR: plxd pushes the run's branch and opens a pull request titled like the thread, then
 * this links to it, in the browser, or hands it to `onOpened`. It unmounts while the run works, so
 * after another turn the button is back, to push the new commit to the same pull request.
 */
function OpenPr({
  hostId,
  run,
  title,
  onError,
  onOpened,
}: {
  hostId: string;
  run: AgentRun;
  title: string;
  onError: (error?: RpcError) => void;
  onOpened?: (url: string) => void;
}) {
  const [url, setUrl] = useState<string>();
  const [opening, setOpening] = useState(false);
  if (url) {
    const number = /\/pull\/(\d+)$/.exec(url)?.[1];
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={url}
        className={`${tabItem} rounded-md hover:bg-hover hover:text-foreground`}
      >
        <GitPullRequest aria-hidden />
        {number ? `PR #${number}` : "Pull request"}
      </a>
    );
  }
  const open = async () => {
    setOpening(true);
    onError(undefined);
    const answer = await window.parallax.request(hostId, "agent/openPr", {
      runId: run.id,
      title,
    });
    setOpening(false);
    if ("error" in answer) onError(answer.error);
    else if (onOpened) onOpened(answer.result.url);
    else setUrl(answer.result.url);
  };
  return (
    <button
      type="button"
      disabled={opening}
      onClick={() => void open()}
      className={`${tabItem} rounded-md enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-60`}
    >
      <GitPullRequestArrow aria-hidden />
      {opening ? "Opening PR…" : "Open PR"}
    </button>
  );
}
