import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeftRight,
  ArrowUpLeft,
  ArrowRight,
  Ban,
  Bot,
  Brain,
  Check,
  Copy,
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
  LoaderCircle,
  MousePointerClick,
  Pencil,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import type { RpcError } from "../preload/bridge";
import type {
  AgentDelivery,
  AgentRun,
  AgentToolStatus,
  ImageId,
  JsonValue,
  PromptImage,
  ThreadRun,
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
import { Composer, listCommands, tabItem, type ComposerProps, type Unanswered } from "./Composer";
import { offlineReason, useConnection } from "./ConnectionStatus";
import { isEmpty, threadDrafts, type ComposerContents } from "./drafts";
import { describeError, githubProblem } from "./errors";
import { ForkButton, ForkContext, type ForkTarget } from "./Fork";
import type { Host } from "./hosts";
import { download, readAttachment } from "./documents";
import { DownloadButton, FileCards } from "./FileCards";
import { FileImage, FileLink, FileRunContext, keepFiles, linkedPath } from "./FileLink";
import { HtmlRender, pageUrl } from "./HtmlRender";
import { imageCaps, imageUrl, loadImage } from "./images";
import { FileCard } from "./FileCard";
import { Lightbox } from "./Lightbox";
import { fromBase64 } from "./ooxml";
import {
  encodedImage,
  isImagePath,
  splitFiles,
  uploadBytes,
  uploadFiles,
  withFiles,
  withoutImages,
} from "./uploads";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceStatus,
} from "./Trace";
import { locale } from "./locale";
import { ClaudeLogo, GitHubLogo, LinearLogo, ParallaxGlyph } from "./logos";
import { markdownBlocks, SPLIT_FROM } from "./markdownBlocks";
import { mentionsOf, withMentions } from "./Mention";
import { dollarMath } from "./math";
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
import { GoalStrip, pursuedGoal } from "./Goal";
import { QueueStrip } from "./QueueStrip";
import { AgentsBar, isGoing, type AgentRow } from "./AgentsBar";
import { ComposerTabs, type ComposerTab } from "./ComposerTabs";
import { useShortcutLabel } from "./keybindings";
import { ResumeCard } from "./ResumeCard";
import { SecretCard, SecretLine } from "./Secret";
import { hostIcon } from "./RunTargetMenu";
import {
  knownModel,
  modelName,
  nativeSubagents,
  SubagentCard,
  SubagentsContext,
  type NativeSubagent,
} from "./Subagents";
import { titleOf, type ForkChoice } from "./threads";
import {
  failureText,
  groupWork,
  isObject,
  isRunning,
  subagentLabels,
  subagentRows,
  subagentRuns,
  subagentState,
  waitingApprovals,
  waitingSecrets,
  workedFor,
  plxdTools,
  type Approval,
  type Item,
  type Subagent,
  type SubagentState,
  type Work,
} from "./transcript";
import { TurnChanges, TurnChangesContext, type TurnChangesTarget } from "./TurnChanges";
import { SetUpGithub } from "./ui";
import { useAgentRun, type SentMessage } from "./useAgentRun";
import { presentWaiting, WaitingBar } from "./WaitingBar";
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
 * turn goes, a `working` row under its prompt says how long it has gone, and a `musing` row, a
 * running "Working" line, stands for what the agent does next when nothing is in flight (PLX-584).
 */
type ViewRow =
  | Row
  | Work
  | PlanRow
  | ProposedPlanRow
  | { kind: "working"; key: string; since?: string }
  | { kind: "musing"; key: string };

/**
 * What a transcript's rows read: the run's worktree, which a tool row's paths read relative to,
 * how to fetch one of the run's images by id, for a tool row's images (PLX-640), and which of a
 * sent prompt's `/skill` and `@path` tokens name the thread's commands or files, as chips.
 */
const RowContext = createContext<{
  root?: string;
  loadImage?: (imageId: ImageId) => Promise<string | undefined>;
  known: (token: string) => boolean;
}>({ known: () => false });

/**
 * Focuses the composer's editor (Composer.tsx), as when the plan strip goes with focus in it: the
 * focused side's, while two threads are side by side.
 */
const focusComposer = () =>
  (
    document.querySelector<HTMLElement>("[data-focused] .composer-input") ??
    document.getElementById("composer-input")
  )?.focus();
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
  space,
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
  onPreview,
  onDevice,
  forked,
  onFork,
  onOpenChanges,
}: {
  hostId: string;
  runId: string;
  /** The thread's title, which Open PR names the pull request after. Else, its run's. */
  title?: string;
  /** A quiet note shown over the composer. */
  notice?: string;
  /** The run's first prompt, shown until the transcript loads, so a new thread opens on it. */
  prompt?: string;
  /**
   * Whether the run is known to be starting or running, as one this window just started is. Until
   * the transcript loads, `prompt` then shows as on its way to it, with the loader under it.
   */
  going?: boolean;
  /** A thread with no repo: its scratch repository has no origin, so it gets no run tab or Open PR. */
  noRepo?: boolean;
  /** A chat in a Space: no Access picker, and no run tab, since it has no repository. */
  space?: boolean;
  /** The host the run is on, named in the composer's tab. */
  host?: Host;
  /** The composer's tab in place of the run's worktree, such as a coordinator's repository. */
  tab?: ReactNode;
  /** The back tab over the composer, behind the plan's, such as a Project's agents. */
  strip?: ComposerTab;
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
  /**
   * Opens one of the agent's own subagents in run `runId`, as its call's row does, or with no
   * `callId`, the run's own chat.
   */
  onOpenSubagent?: (runId: string, callId?: string) => void;
  /** Told run `runId`'s own subagents whenever they change, for the top bar's chips. */
  onSubagents?: (runId: string, subagents: NativeSubagent[]) => void;
  /**
   * Told when run `runId`'s browser tools (PLX-639) have run, on opening and after each new one,
   * and whether the newest opened a tab the user should see.
   */
  onPreview?: (runId: string, reveal: boolean) => void;
  /** The thread's agent opened a device with `device_open` (PLX-886), the one its result names. */
  onDevice?: (runId: string, deviceId?: string) => void;
  /** Whether the thread is a fork (0050), whose history copied from the original shows muted. */
  forked?: boolean;
  /**
   * Forks the thread at a turn, or at its latest with none, and opens the fork (0050). Its
   * messages offer Fork only with it. Resolves to plxd's error, if it refused.
   */
  onFork?: (turnId: string | undefined, choice: ForkChoice) => Promise<RpcError | undefined>;
  /** Opens the side panel's Changes view on a turn, by its ordinal, scrolled to `path` if given. */
  onOpenChanges?: (ordinal: number, path?: string) => void;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const catalog = useCatalog(hostId);
  const queueEnabled = connected && "queue" in connection.capabilities;
  const {
    transcript,
    error,
    sent,
    send,
    cancel,
    queue,
    held,
    background,
    watching,
    runs,
    older,
    loadOlder,
  } = useAgentRun(hostId, runId, connected);
  // Permission requests (PLX-196): those answered here read as answered at once.
  const { answers, answer, dismiss } = useAnswers(hostId);
  // The box's unsent prompt (PLX-887): out of the store while the thread is open, and back in as
  // it closes unless the box is empty. The pair nets out under StrictMode's extra mount.
  const [draftKey] = useState(() => `${hostId}/${runId}`);
  const [draft] = useState(() => threadDrafts.get()[draftKey]);
  const contents = useRef<ComposerContents>(undefined);
  useEffect(() => {
    threadDrafts.remove(draftKey);
    return () => {
      const box = contents.current;
      if (box && !isEmpty(box)) threadDrafts.put(draftKey, box);
    };
  }, [draftKey]);
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
  // The sent message being edited in place, with its row, which it hides.
  const [editing, setEditing] = useState<Editing>();
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
  const goal = useMemo(() => pursuedGoal(items), [items]);
  // The oldest secret the agent waits on (0063).
  const secret = useMemo(() => waitingSecrets(items)[0], [items]);
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
    const listed: Row[] =
      all.length > 0 || !prompt
        ? all
        : [
            going
              ? { kind: "pending", key: "pending:prompt", text: prompt }
              : { kind: "user", key: "prompt", text: prompt },
          ];
    if (!editing) return listed;
    // The message being edited shows as its editor instead: by its turn, or with none (a first
    // prompt shown before plxd logs it, under another key once it does), the latest message.
    const { turnId } = editing.row;
    const at = turnId ? -1 : listed.findLastIndex((r) => r.kind === "user" || r.kind === "pending");
    return listed.filter((r, i) => i !== at && !(turnId && "turnId" in r && r.turnId === turnId));
  }, [items, sent, prompt, going, queue, cancelled, editing]);
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
  // The latest prompt while nothing from the agent follows it, which the pencil edits in place
  // and Stop puts back in the box: its text, its attached threads, and its images: at hand when
  // sent from here, or fetched from plxd by id.
  // `row` is the message's row, which the pencil edits; a queued one has its own edit.
  const unanswered = useMemo<
    (Unanswered & { turnId?: string; row?: { key: string; turnId?: string } }) | undefined
  >(() => {
    // The last message queued from here comes after every row.
    const queued = queue.findLast((m) => sent.has(m.id));
    if (queued) {
      const { text, images, threads } = sent.get(queued.id)!;
      return { text: withoutImages(text), images: async () => images, threads, turnId: queued.id };
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
    const said = row.text ?? mine?.text;
    if (said == null) return undefined;
    const text = withoutImages(said);
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
    return {
      text,
      images,
      threads,
      turnId: row.kind === "pending" ? row.turnId : undefined,
      row: { key: row.key, turnId: row.turnId },
    };
  }, [rows, sent, queue, hostId, runId]);
  // Stop holds what waits until Resume (0060), a follow-up the agent hasn't started included, so
  // only a prompt whose turn it stopped goes back in the box.
  const stop = () => cancel();
  const stopBack = unanswered && !unanswered.turnId ? unanswered : undefined;
  // The pencil's stop drops the message instead, which goes back in the box, so if plxd drops it,
  // it offers no Send again too.
  const drop = async () => {
    const back = unanswered;
    const failed = await cancel(true);
    if (!failed && back?.turnId) setResent((prev) => new Set(prev).add(back.turnId!));
    return failed;
  };
  // The pencil: stops the run before the agent answers, and edits the message in place. Its
  // dropped notice, if plxd drops it, is left out while editing.
  const edit = async () => {
    const back = unanswered;
    if (!back?.row) return;
    const images = back.images();
    const failed = await drop();
    if (failed) return setResendError(failed);
    setResendError(undefined);
    if (back.row.turnId) setCancelled((prev) => new Set(prev).add(back.row!.turnId!));
    setEditing({ row: back.row, text: back.text, images: await images, threads: back.threads });
  };
  // Cancel leaves the run stopped. A message plxd dropped gets its notice and Send again back.
  const cancelEdit = () => {
    const turnId = editing?.row.turnId;
    setEditing(undefined);
    if (!turnId) return;
    const without = (prev: ReadonlySet<string>) => new Set([...prev].filter((t) => t !== turnId));
    setCancelled(without);
    setResent(without);
  };
  // A sent edit goes once the run has stopped, so it starts a turn rather than queueing.
  const stopped = !!run && !isRunning(run.status);
  useEffect(() => {
    if (!editing?.ready || !stopped) return;
    const was = editing;
    setEditing(undefined);
    void (async () => {
      // Its images are saved again, as the composer saves them (PLX-799).
      const images = uploadBytes(connection)
        ? await uploadFiles(
            hostId,
            was.images.map((image, i) => encodedImage(image, i + 1)),
          )
        : [];
      if (typeof images === "string") return setEditing({ ...was, ready: false, error: images });
      const text = withFiles(was.text, images);
      const failed = await sendText(text, {}, was.images, [...(was.threads ?? [])]);
      if (failed !== undefined) setEditing({ ...was, ready: false, error: failed || undefined });
    })();
  }, [editing, stopped]);

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
  // The agent's browser tool calls that have answered (PLX-639). Each new one refreshes the side
  // panel's agent tabs; a new preview_open, unless it asked for the background, shows its tab.
  const previews = items.filter(
    (i) => i.kind === "tool" && i.status && i.name?.startsWith(`${plxdTools}preview_`),
  );
  const previewCount = previews.length;
  const seenPreviews = useRef<number>(undefined);
  useEffect(() => {
    const seen = seenPreviews.current;
    seenPreviews.current = previewCount;
    if (previewCount === 0 || seen === previewCount) return;
    // Several calls can answer at once, so any new preview_open counts.
    const opened =
      seen !== undefined &&
      previews
        .slice(seen)
        .some(
          (call) =>
            call.kind === "tool" &&
            call.name === `${plxdTools}preview_open` &&
            call.status === "ok" &&
            !(isObject(call.input) && call.input["open"] === false),
        );
    onPreview?.(runId, opened);
    // `previews` is new each render; its count says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewCount, onPreview, runId]);
  // Each new device_open that worked shows its device in the side panel (PLX-886).
  const devicesOpened = items.filter(
    (i) => i.kind === "tool" && i.name === `${plxdTools}device_open` && i.status === "ok",
  );
  const lastOpened = devicesOpened.at(-1);
  const openedDevice = lastOpened?.kind === "tool" ? openedDeviceId(lastOpened.output) : undefined;
  const seenDevices = useRef<number>(undefined);
  useEffect(() => {
    const seen = seenDevices.current;
    seenDevices.current = devicesOpened.length;
    if (seen !== undefined && devicesOpened.length > seen) onDevice?.(runId, openedDevice);
    // `devicesOpened` is new each render; its length says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devicesOpened.length, onDevice, runId]);
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

  let disabledReason = offlineReason(connection);
  if (connected && !run) disabledReason = error ? "This chat couldn't load" : "Loading…";
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

  // Each turn's run, for its changes card: by its prompt row's turn id, and the first prompt's,
  // whose row has none, by `undefined`. A fork's first run is its copied prompt's, which has no
  // checkpoint, so its copied first reply shows no changes.
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const turnChanges = useMemo<TurnChangesTarget>(() => {
    const turns = new Map<string | undefined, ThreadRun>();
    for (const r of runs) {
      if (r.status === "rolledBack") continue;
      turns.set(r.id, r);
      if (r.ordinal === 1 && !r.text) turns.set(undefined, r);
    }
    return {
      turns,
      folds,
      setFolds: (next) => setFolds((prev) => new Map([...prev, ...Object.entries(next)])),
      open: onOpenChanges,
    };
  }, [runs, folds, onOpenChanges]);

  const forkTarget = useMemo<ForkTarget | undefined>(
    () => (run && onFork && connected ? { hostId, run, onFork } : undefined),
    [hostId, run, onFork, connected],
  );
  const pinned = (
    <>
      <PinnedApprovals
        asked={asked}
        answers={answers}
        onAnswer={(a, choice, message) => void answer(a, choice, message)}
        onDismiss={dismiss}
        disabledReason={offlineReason(connection)}
      />
      {secret && (
        <SecretCard
          key={secret.key}
          hostId={hostId}
          runId={runId}
          secret={secret}
          disabledReason={offlineReason(connection)}
        />
      )}
    </>
  );

  if (subagent)
    return (
      <SubagentsContext value={subagents}>
        {shown ? (
          <SubagentView
            sub={shown}
            live={live}
            stalled={stalled}
            onBack={() => onOpenSubagent?.(runId)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-faint-foreground">
            {error ?? (run ? "This subagent isn't in the transcript" : "Loading…")}
          </div>
        )}
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">{pinned}</div>
      </SubagentsContext>
    );

  // The tabs over the composer, back to front, so the queue sits nearest the box.
  const running = isRunning(run?.status);
  const tabs: ComposerTab[] = [];
  if (strip) tabs.push(strip);
  const subagentTabRows = nativeRows(transcript.subagents, live);
  if (subagents && subagentTabRows.some(isGoing))
    tabs.push({
      key: "subagents",
      label: "Subagents",
      node: <AgentsBar rows={subagentTabRows} label="Subagents" onOpen={subagents.open} />,
    });
  // Once its turn settles, as T3 Code's strip: a turn's own work shows in the transcript.
  if (!running && presentWaiting(background, watching))
    tabs.push({
      key: "waiting",
      label: "Waiting",
      node: (
        <WaitingBar hostId={hostId} runId={runId} background={background} watching={watching} />
      ),
    });
  if (goal && running && !stalled)
    tabs.push({ key: "goal", label: "Goal", node: <GoalStrip objective={goal} /> });
  // The latest turn's plan, while the run works on it.
  if (plan && running && !stalled)
    tabs.push({
      key: "plan",
      label: "Plan",
      node: <PlanStrip items={plan.items} active={plan.active} returnFocus={focusComposer} />,
    });
  if (queueEnabled && queue.length > 0)
    tabs.push({
      key: "queue",
      label: "Queued",
      node: (
        <QueueStrip
          hostId={hostId}
          runId={runId}
          messages={queue}
          held={held}
          running={running}
          disabledReason={disabledReason}
          onCancelled={(id) => setCancelled((prev) => new Set(prev).add(id))}
        />
      ),
    });

  return (
    <SubagentsContext value={subagents}>
      {rows.length > 0 || editing ? (
        <ThreadLinksContext value={threadLinks}>
          <ForkContext value={forkTarget}>
            <TurnChangesContext value={turnChanges}>
              <TranscriptView
                rows={rows}
                sent={unsent}
                live={isRunning(run?.status)}
                stalled={stalled}
                turnDone={transcript.turnDone}
                root={run?.worktreePath}
                runId={runId}
                backend={run?.backend}
                // plxd logs a fork's copied history with its agent.started, at its creation (0050).
                copiedAt={forked ? run?.createdAt : undefined}
                onResend={resend}
                loadImage={showImage}
                onNearTop={older ? loadOlder : undefined}
                onEdit={
                  live && !editing && unanswered?.row
                    ? { key: unanswered.row.key, edit: () => void edit() }
                    : undefined
                }
                end={
                  editing ? (
                    <EditMessage
                      editing={editing}
                      loadImage={showImage}
                      disabledReason={disabledReason}
                      onSend={(text, images) =>
                        setEditing({ ...editing, text, images, ready: true })
                      }
                      onCancel={cancelEdit}
                    />
                  ) : (
                    run?.status === "waiting" && (
                      <ResumeCard hostId={hostId} run={run} disabledReason={disabledReason} />
                    )
                  )
                }
              />
            </TurnChangesContext>
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
        <ComposerTabs tabs={tabs} />
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
          unanswered={stopBack}
          disabledReason={disabledReason}
          tab={
            tab ??
            (run && !space && !noRepo && (
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
          accountId={run?.accountId}
          requestUsage={transcript.requestUsage}
          connected={connected}
          hostId={hostId}
          contextAndFast={connected && "contextAndFast" in connection.capabilities}
          unavailable={unavailable}
          optionsDisabled={optionsDisabled}
          imageCaps={imageCaps(connection)}
          uploadBytes={uploadBytes(connection)}
          manualDenied={manualDenied}
          noAccess={space}
          projectMode={projectMode}
          insert={compose && !compose.send ? compose.text : undefined}
          menus={
            connected && "composerMenus" in connection.capabilities ? { hostId, runId } : undefined
          }
          attach={attachThreads(connection, threadLinks, runId)}
          // What the box last held, where a subagent's view took it away, else the saved draft.
          initial={contents.current ?? draft}
          contents={contents}
        />
      </div>
    </SubagentsContext>
  );
}

const noneSent: ReadonlyMap<string, SentMessage> = new Map();

const subagentAttention: Record<SubagentState, AgentRow["attention"]> = {
  running: "working",
  completed: "done",
  failed: "failed",
  stopped: "done",
};

/** A thread's own subagents as the Subagents tab lists them, oldest first, nested ones left out. */
function nativeRows(subagents: Readonly<Record<string, Subagent>> | undefined, live: boolean) {
  return nativeSubagents(subagents, live)
    .filter((sub) => !sub.parent)
    .map((sub): AgentRow => ({
      id: sub.callId,
      title: sub.title,
      attention: subagentAttention[sub.state],
      Logo: ClaudeLogo,
      ...(sub.model && { detail: modelName(sub.model) }),
    }));
}

/**
 * One of the agent's own subagents, read-only (PLX-382): its prompt, what it did, and its final
 * report, then its type, model, and where it stands, in place of a composer.
 */
function SubagentView({
  sub,
  live,
  stalled,
  onBack,
}: {
  sub: Subagent;
  live: boolean;
  stalled: boolean;
  /** Opens its thread. */
  onBack: () => void;
}) {
  const rows = useMemo(() => subagentRows(sub), [sub]);
  const state = subagentState(sub, live);
  const keys = useShortcutLabel("parentThread");
  return (
    <>
      <TranscriptView rows={rows} sent={noneSent} live={state === "running"} stalled={stalled} />
      <div className="mx-auto w-full max-w-3xl px-6 pt-1">
        <div
          role="status"
          aria-label="Subagent"
          className="flex min-w-0 items-center gap-2.5 rounded-3xl border border-border bg-surface py-2.5 pr-2.5 pl-4 text-[13px] text-muted-foreground"
        >
          <ClaudeLogo aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">
              {modelName(sub.model) ?? "Claude Code"}
            </span>
            {[sub.agentType, subagentLabels[state]].filter(Boolean).map((part) => (
              <span key={part} className="ml-2.5">
                {part}
              </span>
            ))}
          </span>
          <span className="ml-auto shrink-0 text-faint-foreground">Read-only</span>
          <button
            type="button"
            onClick={onBack}
            title={keys ? `Open parent (${keys})` : "Open parent"}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-foreground hover:bg-hover"
          >
            <ArrowUpLeft aria-hidden className="size-4 text-muted-foreground" />
            Open parent
            {keys && <kbd className="font-sans text-[11px] text-faint-foreground">{keys}</kbd>}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Whether a sent prompt's `/name` or `@path` names one of the thread's commands or files, so only
 * those are chips. Commands are fetched once a prompt has a `/name`, and files for each new `@path`.
 */
function useKnownMentions(
  hostId: string | undefined,
  backend: string | undefined,
  runId: string | undefined,
  rows: Row[],
  sent: ReadonlyMap<string, SentMessage>,
): (token: string) => boolean {
  // One string, so the fetches run again only when a new token is sent.
  const said = useMemo(() => {
    const all = rows.flatMap((row) =>
      row.kind === "user" || row.kind === "pending"
        ? mentionsOf(row.text ?? (row.turnId && sent.get(row.turnId)?.text) ?? "")
        : [],
    );
    return [...new Set(all)].join(" ");
  }, [rows, sent]);
  const wantsCommands = said.split(" ").some((t) => t[0] === "/");
  const wantsPaths = said
    .split(" ")
    .filter((t) => t[0] === "@")
    .join(" ");
  // Each list with the thread it's for, so another thread's isn't used.
  const key = `${hostId}/${backend}/${runId}`;
  const [commands, setCommands] = useState<{ key: string; list: string[] }>();
  const [paths, setPaths] = useState<{ key: string; list: string[] }>();
  useEffect(() => {
    if (!wantsCommands || !hostId || !backend) return;
    let live = true;
    void listCommands(hostId, backend, undefined, runId).then(
      (list) => live && setCommands({ key, list: list.map((c) => c.text) }),
    );
    return () => {
      live = false;
    };
  }, [wantsCommands, key, hostId, backend, runId]);
  useEffect(() => {
    if (!wantsPaths || !hostId || !runId) return;
    let live = true;
    void window.parallax
      .request(hostId, "repo/files", { runId })
      .then((r) => live && setPaths({ key, list: "result" in r ? r.result.files : [] }));
    return () => {
      live = false;
    };
  }, [wantsPaths, key, hostId, runId]);
  return useMemo(() => {
    const names = new Set([
      ...(commands?.key === key ? commands.list : []),
      ...(paths?.key === key ? paths.list.map((p) => `@${p}`) : []),
    ]);
    return (token: string) => names.has(token);
  }, [commands, paths, key]);
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
  runId,
  backend,
  onEdit,
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
  /** The run whose folder the agent's file links and images read from (PLX-834). */
  runId?: string;
  /** The run's backend, whose commands a sent prompt's `/skill` chips name. */
  backend?: string;
  onResend?: (turnId: string, message: SentMessage) => void;
  /** Fetches a message's image by id, as a data URL. */
  loadImage?: (imageId: ImageId) => Promise<string | undefined>;
  /** Called while the top is within a screen of view, to load older rows (PLX-490). */
  onNearTop?: () => void;
  /** Shown after the last row, such as a waiting run's resume card. */
  end?: ReactNode;
  /** In a fork, when its history copied from the original was logged: rows up to it show muted. */
  copiedAt?: string;
  /** The row, by key, whose message the pencil edits, and what it does. */
  onEdit?: { key: string; edit: () => void };
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const links = useContext(ThreadLinksContext);
  const known = useKnownMentions(links?.hostId, backend, runId, rows, sent);
  const rowContext = useMemo(() => ({ root, loadImage, known }), [root, loadImage, known]);
  // Threads' titles, to name the thread that sent a message or stopped this one (0041).
  const titles = links?.state.titles;
  const hostId = links?.hostId;
  const fileRun = useMemo(() => (hostId && runId ? { hostId, runId } : undefined), [hostId, runId]);
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
      // In the turn going now, work after it makes it commentary, which has no Fork or Copy, so
      // no gap under it. An ended turn keeps them on its last message, whatever followed it.
      else if (row.kind === "work" && going && i > latest) byTurn.delete(turn);
    });
    return new Map([...byTurn].map(([id, i]) => [i, id]));
  }, [view, going, latest]);

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: 24,
    getItemKey: (i) => view[i]!.key,
    // An older page put in above leaves the row at the top of the view where it is. The list
    // renders the rows around that row's new place in the same pass, so it never measures rows
    // at the old offset and moves the view by their error (PLX-545).
    anchorTo: "end",
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
  // Near the top, the next older page loads.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && onNearTop && el.scrollTop < el.clientHeight) onNearTop();
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
  // What each row says, for Find: the messages, as they read rendered. Read only while it's open.
  const texts = useCallback(
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

  const transcript = (
    // Bounds the rail and Scroll to end, which stay put while the list scrolls under them.
    <RowContext value={rowContext}>
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
                    className={`mx-auto max-w-3xl px-10 ${listKinds.has(row.kind) ? "py-1" : "py-2"} ${muted ? "opacity-60" : ""}`}
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
                      reply={replies.has(v.index)}
                      replyTurn={replies.get(v.index)}
                      onEdit={onEdit?.key === row.key ? onEdit.edit : undefined}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {end && <div className="mx-auto max-w-3xl px-10 pb-6">{end}</div>}
        </div>
        {/* One prompt is no choice of where to go, so there's no rail for it. */}
        {prompts.length > 1 && <PromptRail prompts={prompts} current={reading} onJump={jump} />}
        {scrolledUp && <ScrollToEnd onClick={scrollToEnd} />}
        {findBar}
      </div>
    </RowContext>
  );
  return <FileRunContext value={fileRun}>{transcript}</FileRunContext>;
}

// Rows of the agent's work, which sit closer to one another and to the messages around them, as
// T3 Code's work log does (PLX-584, PLX-770).
const listKinds = new Set(["work", "plan", "todo", "musing", "compaction"]);

/**
 * The user's prompts among `view`'s rows, for the rail: a follow-up's text from `sent` when the
 * log lacks it, and the agent's replies before the next prompt. Parallax's own
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
    } else if (row.kind === "assistant" && last) (last.replies ??= []).push(row.text);
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
  /** For an assistant message: set on a turn's last, which offers Copy and Fork at `replyTurn`. */
  reply?: boolean;
  replyTurn?: string;
  /** For a user's message the agent hasn't started on: the pencil, which edits it. */
  onEdit?: () => void;
}

/** An html_render page (PLX-639), from the open host, with Download under it (PLX-834). */
function HtmlRenderRow({ page }: { page: Extract<Item, { kind: "htmlRender" }> }) {
  const hostId = useContext(ThreadLinksContext)?.hostId;
  if (!hostId) return null;
  return (
    <div>
      <HtmlRender hostId={hostId} page={page} />
      <DownloadButton
        name={`${page.title || "Page"}.html`}
        read={() => readAttachment(hostId, page.runId, page.attachmentId)}
      />
    </div>
  );
}

/** Files the agent presented (PLX-755), from the open host. */
function FilesRow({ row }: { row: Extract<Item, { kind: "files" }> }) {
  const hostId = useContext(ThreadLinksContext)?.hostId;
  return hostId ? <FileCards hostId={hostId} item={row.key} files={row.files} /> : null;
}

/** A browser recording the agent made (PLX-639), from the open host, with Download (PLX-834). */
function RecordingRow({ recording }: { recording: Extract<Item, { kind: "recording" }> }) {
  const hostId = useContext(ThreadLinksContext)?.hostId;
  if (!hostId) return null;
  const src = pageUrl(hostId, recording.runId, recording.attachmentId);
  return (
    <div className="flex flex-col items-start gap-1">
      <video
        controls
        src={src}
        aria-label="The agent's browser recording"
        className="max-h-96 max-w-full rounded-md border border-border bg-black"
      />
      <DownloadButton
        name="Recording.webm"
        read={() => readAttachment(hostId, recording.runId, recording.attachmentId)}
      />
    </div>
  );
}

// xterm.js loads with the first script terminal shown.
const TerminalView = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalView })));

/**
 * A setup or settle script (PLX-650): running, then done, failed, stopped with its thread, or
 * interrupted by a plxd restart. While it runs or after it failed, it opens to its plxd terminal,
 * where a failed script's shell stays for a look.
 */
function ScriptRow({
  script,
  open,
  onToggle,
}: {
  script: Extract<Item, { kind: "script" }>;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
}) {
  const links = useContext(ThreadLinksContext);
  const what = `${script.trigger === "setup" ? "Setup" : "Settle"} script ${script.name}`;
  const failed = script.status === "failed";
  const icon =
    script.status === "running" ? (
      <LoaderCircle className="animate-spin" />
    ) : script.status === "done" ? (
      <Check />
    ) : failed ? (
      <X />
    ) : (
      <Ban />
    );
  const detail =
    script.status === "running"
      ? script.blocking
        ? "The agent starts once it finishes."
        : "Running"
      : script.status === "done"
        ? "Done"
        : script.status === "cancelled"
          ? "Stopped."
          : !failed
            ? "Interrupted when plxd stopped."
            : (script.error ??
              (script.exitCode === undefined
                ? "Its terminal closed first."
                : `Exited with code ${script.exitCode}.`));
  const line = (
    <TraceLine status={script.status === "running" ? "running" : failed ? "error" : undefined}>
      <TraceIcon>{icon}</TraceIcon>
      <TraceTitle className="shrink-0">{what}</TraceTitle>
      <span className={`truncate ${failed ? "text-danger" : "text-faint-foreground"}`}>
        {detail}
      </span>
    </TraceLine>
  );
  // Only a running script, or a failed one's shell, still has a terminal to open; opening any
  // other would start an empty shell under its id.
  const live = script.status === "running" || (failed && script.exitCode !== undefined);
  if (!live || !links) return line;
  return (
    <Disclosure id={script.key} open={open} onToggle={onToggle} summary={line}>
      <div className="h-60 overflow-hidden rounded-xl border border-border bg-surface py-1.5 pl-3 text-foreground">
        <Suspense>
          <TerminalView
            id={`script:${script.runId}:${script.terminalId}`}
            target={{
              hostId: links.hostId,
              path: links.state.runs[script.runId]?.worktreePath ?? "~",
              threadId: script.runId,
              terminalId: script.terminalId,
            }}
            label={what}
            keep
          />
        </Suspense>
      </div>
    </Disclosure>
  );
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
  replyTurn,
  onEdit,
}: RowProps) {
  const { known } = useContext(RowContext);
  switch (row.kind) {
    case "work":
      if (row.subagents)
        return (
          <SubagentCalls
            work={row}
            live={live}
            open={open}
            openKeys={openKeys ?? new Set()}
            onToggle={onToggle}
          />
        );
      // A finished turn's work under one dropdown (PLX-326): how long it worked, opening to its
      // steps and the messages it folded, as T3 Code's turn fold does. A fork's `copied` work says
      // only "Worked", since its logged times are all the fork's creation (0050).
      return row.done ? (
        <Fold
          id={row.key}
          items={stepRuns(row.items)}
          live={live}
          open={open}
          openKeys={openKeys ?? new Set()}
          onToggle={onToggle}
        >
          <TraceLine>
            <TraceTitle>{copied ? "Worked" : workedFor(row.startedAt, row.endedAt)}</TraceTitle>
          </TraceLine>
        </Fold>
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
      return <Musing />;
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
        <TraceLine status="running">
          <TraceIcon>
            <LoaderCircle className="animate-spin" />
          </TraceIcon>
          <TraceTitle>Compacting context</TraceTitle>
        </TraceLine>
      );
    case "user":
    case "pending": {
      // A wake-up is Parallax's message to the coordinator, not the user's (0025), and another
      // thread's message is sent with its Parallax tools (0041).
      if (row.kind === "user" && notTheUsers(row))
        return (
          <Disclosure
            id={row.key}
            open={open}
            onToggle={onToggle}
            summary={
              <TraceLine>
                <TraceIcon>
                  <Workflow />
                </TraceIcon>
                <TraceTitle>
                  {row.wake
                    ? "From Parallax: subagents finished"
                    : `From another thread${sender ? `: ${sender}` : ""}`}
                </TraceTitle>
              </TraceLine>
            }
          >
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {row.text ?? (row.wake ? null : "Follow-up message")}
            </p>
          </Disclosure>
        );
      const text = row.text ?? sent?.text;
      // Files sent with it are listed after the user's own text (0071), and show as cards. Its
      // images are listed too (PLX-799), but show as their thumbnails.
      const { text: said, paths } = text === undefined ? { text, paths: [] } : splitFiles(text);
      const files = paths.filter((path) => !isImagePath(path));
      // Images sent from here are at hand; the log's come from plxd by id.
      const images = row.kind === "pending" ? row.images : (sent?.images ?? row.images);
      const threads = row.threads ?? sent?.threads;
      return (
        <div className="group/prompt flex flex-col items-end gap-1.5">
          {files.length > 0 && (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {files.map((path) => (
                <SentFile key={path} path={path} />
              ))}
            </div>
          )}
          {images && images.length > 0 && (
            <MessageImages className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {images.map((image, i) => (
                <MessageImage key={i} image={image} loadImage={loadImage} />
              ))}
            </MessageImages>
          )}
          {/* The threads attached as context, which open from here (PLX-378). */}
          {threads && threads.length > 0 && (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {threads.map((id) => (
                <SentThread key={id} runId={id} />
              ))}
            </div>
          )}
          {/* A message of images or files alone has no bubble. */}
          {((!images?.length && !files.length) || said?.trim() !== "") && (
            <div className="max-w-[85%] rounded-2xl bg-selected px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap">
              {/* A follow-up from an older log, which has no text for it. */}
              {said !== undefined ? (
                withMentions(said, known)
              ) : (
                <span className="text-muted-foreground italic">Follow-up message</span>
              )}
            </div>
          )}
          <PromptMeta
            at={row.kind === "user" && !copied ? row.at : undefined}
            text={text}
            fork={forkable && row.kind === "user" && <ForkButton turnId={row.turnId} />}
            onEdit={onEdit}
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
          <MarkdownText text={row.text} streaming={row.partial} />
        );
      if (!reply || row.partial) return body;
      return (
        <div className="group/prompt flex flex-col gap-1.5">
          {body}
          <TurnChanges turnId={replyTurn} />
          <PromptMeta text={row.text} fork={forkable && <ForkButton turnId={replyTurn} />} />
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
            <TraceLine>
              <TraceIcon>
                <icons.thinking />
              </TraceIcon>
              <TraceTitle>{plainText(row.text) || "Thought"}</TraceTitle>
            </TraceLine>
          }
        >
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {row.text}
          </p>
        </Disclosure>
      );
    case "tool":
      return <ToolCall item={row} live={live} open={open} onToggle={onToggle} />;
    case "htmlRender":
      return <HtmlRenderRow page={row} />;
    case "recording":
      return <RecordingRow recording={row} />;
    case "files":
      return <FilesRow row={row} />;
    case "script":
      return <ScriptRow script={row} open={open} onToggle={onToggle} />;
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
    case "secret":
      return <SecretLine secret={row} />;
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
      const label = endLabels[outcome.status] ?? "Ended";
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

/** What an end row says, by how the process ended. A status newer than this app says "Ended". */
const endLabels: Partial<Record<string, string>> = {
  completed: "Done",
  cancelled: "Stopped",
  interrupted: "Interrupted when plxd stopped. Send a message to pick up where it left off.",
};

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

/** A file sent with a message, as a card, read from the thread's host. */
function SentFile({ path }: { path: string }) {
  const hostId = useContext(ThreadLinksContext)?.hostId;
  return <FileCard file={path} hostId={hostId} />;
}

/**
 * A message's thumbnails, among `children`, laid out by `className`. Clicking one opens it large,
 * with arrows to the others that loaded and Download (PLX-834).
 */
function MessageImages({ className, children }: { className: string; children: ReactNode }) {
  const [shown, setShown] = useState<{ images: { src: string; name: string }[]; index: number }>();
  return (
    <div
      className={className}
      onClick={(e) => {
        const open = (e.target as Element).closest("[data-open-image]");
        if (!open) return;
        const buttons = [...e.currentTarget.querySelectorAll("[data-open-image]")];
        const images = buttons.map((button) => {
          // A data: URL, `data:image/png;base64,...`.
          const src = button.querySelector("img")!.getAttribute("src")!;
          return { src, name: `Image.${src.slice("data:image/".length, src.indexOf(";"))}` };
        });
        setShown({ images, index: buttons.indexOf(open) });
      }}
    >
      {children}
      {shown && (
        <Lightbox
          images={shown.images}
          index={shown.index}
          onIndex={(index) => setShown({ ...shown, index })}
          onClose={() => setShown(undefined)}
          onDownload={(index) => {
            const { src, name } = shown.images[index]!;
            download(name, fromBase64(src.slice(src.indexOf(",") + 1)));
          }}
        />
      )}
    </div>
  );
}

/**
 * One of a message's images, as a thumbnail that opens in its `MessageImages`: at hand, or fetched
 * by id. The same height either way, so the row doesn't jump when it loads.
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
      <button
        type="button"
        aria-label="Open image"
        data-open-image
        className="cursor-zoom-in rounded-xl"
      >
        <img
          src={url}
          alt="Image"
          className="h-32 max-w-60 rounded-xl border border-border object-cover"
        />
      </button>
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

/** A dropdown of steps: `children` on its line, opening to a row for each of `items`. */
function Fold({
  id,
  items,
  live,
  open,
  openKeys,
  onToggle,
  children,
}: {
  id: string;
  items: readonly (Item | Work)[];
  live: boolean;
  open: boolean;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Disclosure id={id} open={open} onToggle={onToggle} summary={children}>
      {/* Its messages in the foreground; its steps set their own color. */}
      <Trace className="text-foreground">
        {items.map((item) => (
          <RowView
            key={item.key}
            row={item}
            live={live}
            open={openKeys.has(item.key)}
            openKeys={item.kind === "work" ? openKeys : undefined}
            onToggle={onToggle}
          />
        ))}
      </Trace>
    </Disclosure>
  );
}

/**
 * Calls that started the agent's own subagents (PLX-382), as one card (PLX-843), each opening its
 * subagent. A call the transcript knows no subagent for, as one that failed, is a plain call.
 */
function SubagentCalls({
  work,
  live,
  open,
  openKeys,
  onToggle,
}: {
  work: Work;
  live: boolean;
  open: boolean;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
}) {
  const known = useContext(SubagentsContext)?.subagents ?? {};
  const calls = work.items.filter((i) => i.kind === "tool");
  const subs = calls.flatMap((c) => known[c.callId] ?? []);
  return (
    <>
      {subs.length > 0 && (
        <SubagentCard id={work.key} subs={subs} open={open} onToggle={onToggle} />
      )}
      {calls
        .filter((c) => !known[c.callId])
        .map((c) => (
          <ToolCall
            key={c.key}
            item={c}
            live={live}
            open={openKeys.has(c.key)}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

/** The kinds of rows that are steps of the agent's work, as opposed to its messages. */
const stepKinds = new Set(["reasoning", "tool", "todo", "notice"]);

/**
 * A finished turn's items, with each run of steps between its messages as one open `Work`, and its
 * subagent calls as their card's (PLX-843).
 */
function stepRuns(items: readonly Item[]): (Item | Work)[] {
  const out: (Item | Work)[] = [];
  let run: Item[] = [];
  const flush = () => {
    out.push(...subagentRuns(run));
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

/**
 * A run of steps between the agent's messages in a turn still going (PLX-584): one call or thought
 * alone as its own row, or several as one line saying what they did, such as "Ran 3 commands and
 * read 2 files", opening to a row each. While a call in it runs, the line says what the agent is
 * doing instead, with a spinner.
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
  const { root } = useContext(RowContext);
  const only = work.items.length === 1 ? work.items[0]! : undefined;
  if (only && !active)
    return <RowView row={only} live={live} open={openKeys.has(only.key)} onToggle={onToggle} />;
  const doing = active ? activity(work.items.findLast((i) => i.kind !== "notice")) : undefined;
  // Its path relative to the run's worktree, as the row reads once the call is done.
  const now = doing && { ...doing, detail: doing.detail && relative(doing.detail, root) };
  const summary = summarize(work.items);
  const { failures } = summary;
  return (
    <Fold
      id={work.key}
      items={work.items}
      live={live}
      open={open}
      openKeys={openKeys}
      onToggle={onToggle}
    >
      {now ? (
        <TraceLine status="running">
          <TraceIcon>
            <LoaderCircle className="animate-spin" />
          </TraceIcon>
          <TraceTitle className="shrink-0">{now.label}</TraceTitle>
          {now.detail && <span className="truncate">{now.detail}</span>}
        </TraceLine>
      ) : (
        <TraceLine status={failures > 0 ? "error" : undefined}>
          <TraceIcon>
            <summary.Icon />
          </TraceIcon>
          <TraceTitle>{summary.label}</TraceTitle>
          {failures > 0 && <TraceDescription>{failures} failed</TraceDescription>}
        </TraceLine>
      )}
    </Fold>
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

/** The working line before the agent does anything. */
function Musing() {
  return (
    <TraceLine status="running">
      <TraceIcon>
        <LoaderCircle className="animate-spin" />
      </TraceIcon>
      <TraceTitle>Working</TraceTitle>
    </TraceLine>
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

/** The icon for each kind of work, once it's done. */
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
  plxd: ParallaxGlyph,
  computer: MousePointerClick,
  planning: ListChecks,
  working: Hammer,
  compacting: FoldVertical,
} as const satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

type Kind = keyof typeof icons;

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
function toolKind(name: string | null): Kind {
  if (name === "computer_use" || name?.startsWith(computerTools)) return "computer";
  if (name?.startsWith(plxdTools)) return "plxd";
  if (mcpTool(name)) return "mcp";
  // The table's own names only, so "constructor" or "toString" is any other tool.
  return (name !== null && Object.hasOwn(toolKinds, name) && toolKinds[name]) || "working";
}

/** What the agent is doing: a label, and what it's doing it to. */
export interface Activity {
  label: string;
  detail?: string;
}

/** The header of the work in progress: what its latest item is doing. */
export function activity(item?: Item): Activity {
  switch (item?.kind) {
    case "reasoning":
      return { label: "Thinking" };
    case "tool": {
      const plxd = plxdCall(item, true);
      if (plxd) return plxd;
      // Including a plxd tool this app doesn't know.
      const mcp = mcpTool(item.name);
      if (mcp) return { label: `Using ${mcp.server}`, detail: mcp.tool };
      if (item.name === "Skill") return { label: "Using skill", detail: skillName(item.input) };
      return {
        label: verbs[item.name ?? ""] ?? item.name ?? "Working",
        detail: toolHint(item.input),
      };
    }
    case "todo":
      return { label: "Planning" };
    default:
      return { label: "Working" };
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
  const { root, loadImage } = useContext(RowContext);
  const kind = toolKind(item.name);
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
        <TraceLine status={look.status}>
          {/* A spinner while it runs, then its kind's icon. */}
          <TraceIcon>
            {status === "running" ? <LoaderCircle className="animate-spin" /> : <Icon />}
          </TraceIcon>
          <TraceTitle>{stepLabel(item, root, status === "running")}</TraceTitle>
          {/* How it went: shown when it failed or never finished, otherwise only heard. */}
          {look.shown ? (
            <TraceDescription>{look.said}</TraceDescription>
          ) : (
            <span className="sr-only">{look.said}</span>
          )}
        </TraceLine>
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
        {!!item.images?.length && (
          <div>
            <p className="mb-1 text-[11.5px] text-faint-foreground">Images</p>
            <MessageImages className="flex flex-wrap gap-2">
              {item.images.map((id) => (
                <MessageImage key={id} image={id} loadImage={loadImage} />
              ))}
            </MessageImages>
          </div>
        )}
        {item.output !== undefined && <Block label="Output">{item.output}</Block>}
      </div>
    </Disclosure>
  );
}

/** How a tool call went: its line's status, and in words, shown when it failed or never finished. */
interface Look {
  status?: TraceStatus;
  said: string;
  shown?: boolean;
}

// A call that never finished fades, as a step not done does.
const statuses = {
  running: { status: "running", said: "Running" },
  ok: { said: "Succeeded" },
  error: { status: "error", said: "Failed", shown: true },
  denied: { status: "error", said: "Denied", shown: true },
  none: { status: "pending", said: "No result", shown: true },
} satisfies Record<"running" | AgentToolStatus | "none", Look>;

/**
 * A step's Trace line that opens, collapsed by default, its open state kept by the transcript.
 * `summary` is the line.
 */
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
    <TraceCollapsible open={open} onOpenChange={(next) => onToggle(id, next)}>
      <TraceCollapsibleTrigger>{summary}</TraceCollapsibleTrigger>
      {/* Rendered once open, so a closed row doesn't hold its tool's output. */}
      {open && <TraceCollapsibleContent>{children}</TraceCollapsibleContent>}
    </TraceCollapsible>
  );
}

function Block({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <p className="mb-1 text-[11.5px] text-faint-foreground">{label}</p>
      <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-code px-3 py-2 font-mono leading-relaxed whitespace-pre-wrap text-foreground">
        {children}
      </pre>
    </div>
  );
}

// The input field that says what a call does, by the names common tools use.
const hintFields = ["command", "file_path", "path", "pattern", "url", "query", "description"];

function toolHint(input?: JsonValue, fields = hintFields): string {
  if (!isObject(input)) return "";
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
 * did and to what. A plxd or other MCP server's tool reads by its server and tool, and a plxd tool
 * says what it's `doing` while it runs (PLX-843).
 */
export function stepLabel(
  item: Extract<Item, { kind: "tool" }>,
  root?: string,
  doing = false,
): string {
  const plxd = plxdCall(item, doing);
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
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** How many of its calls failed or were denied. */
  failures: number;
}

/**
 * What a run of steps did, as T3 Code sums one up (PLX-584): the MCP servers it used, up to two of
 * Parallax's calls in words (PLX-843), then its two main kinds of call with counts, commands and
 * edits first, then how many others, as in "Used Linear, ran 3 commands, and changed 2 files".
 * Thoughts and notices aren't counted, unless they're all there is.
 */
export function summarize(items: readonly Item[]): StepsSummary {
  const steps = items.filter((i) => i.kind !== "notice");
  const failures = steps.filter(
    (i) => i.kind === "tool" && (i.status === "error" || i.status === "denied"),
  ).length;
  const calls = steps.filter((i) => i.kind === "tool" || i.kind === "todo");
  if (calls.length === 0) {
    const n = steps.length;
    return { label: n === 1 ? "Thought" : `Thought ${n} times`, Icon: icons.thinking, failures };
  }
  const servers: string[] = [];
  // Parallax's calls by what they did, and how many times (PLX-843).
  const plxd = new Map<string, number>();
  const kinds = new Set<Kind>();
  // By kind of call, in the order each first came: its calls, and the files of edits.
  const counts = new Map<string, { calls: number; files: Set<string> }>();
  for (const call of calls) {
    const kind = call.kind === "todo" ? "planning" : toolKind(call.name);
    kinds.add(kind);
    const done = call.kind === "tool" ? plxdLabel(call.name)?.[1] : undefined;
    if (done) {
      plxd.set(done, (plxd.get(done) ?? 0) + 1);
      continue;
    }
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
  // Up to two of Parallax's in words, as "Checked orchestration capabilities", more as using it.
  const said = [...plxd].map(([label, n]) => (n > 1 ? `${label} ${times(n)}` : label));
  if (said.length > 2 && !servers.includes("Parallax")) servers.push("Parallax");
  parts.unshift(
    ...(servers.length > 0 ? [`Used ${list.format(servers)}`] : []),
    ...(said.length > 2 ? [] : said),
  );
  const others =
    calls.length -
    calls.filter((c) => c.kind === "tool" && ["mcp", "plxd"].includes(toolKind(c.name))).length -
    ranked.reduce((n, { count }) => n + count.calls, 0);
  if (others > 0) parts.push(`performed ${others} other ${others === 1 ? "action" : "actions"}`);
  const label = list.format(
    parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))),
  );
  const [only] = kinds;
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    Icon: kinds.size === 1 ? icons[only!] : icons.working,
    failures,
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
    case "computer":
      return `Used apps ${times(calls)}`;
    case "planning":
      return "Updated the plan";
    default:
      return `Used ${plural(calls, "tool", "tools")}`;
  }
}

/** Joins English parts: "a", "a and b", or "a, b, and c". */
const list = new Intl.ListFormat("en", { type: "conjunction" });

// A thread's plxd tools (0041), by what they're doing and what they did (PLX-843), then the 0019
// coordinator tools older transcripts hold.
const plxdLabels: Partial<Record<string, readonly [doing: string, done: string]>> = {
  thread_launch: ["Starting a child thread", "Started a child thread"],
  thread_fork: ["Forking a thread", "Forked a thread"],
  thread_list: ["Listing threads", "Listed threads"],
  thread_read: ["Reading a thread", "Read a thread"],
  thread_search: ["Searching threads", "Searched threads"],
  thread_send: ["Messaging a thread", "Messaged a thread"],
  thread_wait: ["Waiting on a thread", "Waited on a thread"],
  thread_interrupt: ["Interrupting a thread", "Interrupted a thread"],
  thread_update: ["Updating a thread", "Updated a thread"],
  thread_merge_back: ["Merging a thread back", "Merged a thread back"],
  create_threads: ["Creating threads", "Created threads"],
  orchestrator_capabilities: [
    "Checking orchestration capabilities",
    "Checked orchestration capabilities",
  ],
  delegate_task: ["Delegating a task", "Delegated a task"],
  task_status: ["Checking on a task", "Checked on a task"],
  task_cancel: ["Cancelling a task", "Cancelled a task"],
  schedule_task: ["Scheduling a task", "Scheduled a task"],
  list_scheduled_tasks: ["Listing scheduled tasks", "Listed scheduled tasks"],
  update_scheduled_task: ["Updating a scheduled task", "Updated a scheduled task"],
  delete_scheduled_task: ["Deleting a scheduled task", "Deleted a scheduled task"],
  run_scheduled_task_now: ["Running a scheduled task", "Ran a scheduled task"],
  request_secret: ["Asking you for a secret", "Asked you for a secret"],
  present_files: ["Presenting files", "Presented files"],
  html_render: ["Rendering a page", "Rendered a page"],
  html_preview: ["Previewing a page", "Previewed a page"],
  pr_link: ["Linking a pull request", "Linked a pull request"],
  pr_unlink: ["Unlinking a pull request", "Unlinked a pull request"],
  link_pull_request: ["Linking a pull request", "Linked a pull request"],
  unlink_pull_request: ["Unlinking a pull request", "Unlinked a pull request"],
  list_thread_pull_requests: ["Listing pull requests", "Listed pull requests"],
  watch_pull_request: ["Watching a pull request", "Watched a pull request"],
  unwatch_pull_request: ["Unwatching a pull request", "Unwatched a pull request"],
  memory_read: ["Reading memory", "Read memory"],
  memory_propose: ["Proposing a memory", "Proposed a memory"],
  memory_write: ["Writing memory", "Wrote memory"],
  device_list: ["Listing devices", "Listed devices"],
  device_open: ["Opening a device", "Opened a device"],
  device_screenshot: ["Taking a device screenshot", "Took a device screenshot"],
  device_close: ["Closing a device", "Closed a device"],
  preview_open: ["Opening a preview", "Opened a preview"],
  preview_list: ["Listing previews", "Listed previews"],
  preview_status: ["Checking the preview", "Checked the preview"],
  preview_close: ["Closing the preview", "Closed the preview"],
  preview_navigate: ["Navigating the preview", "Navigated the preview"],
  preview_snapshot: ["Reading the page", "Read the page"],
  preview_click: ["Clicking in the preview", "Clicked in the preview"],
  preview_hover: ["Hovering in the preview", "Hovered in the preview"],
  preview_drag: ["Dragging in the preview", "Dragged in the preview"],
  preview_type: ["Typing in the preview", "Typed in the preview"],
  preview_press: ["Pressing a key", "Pressed a key"],
  preview_select: ["Choosing an option", "Chose an option"],
  preview_scroll: ["Scrolling the preview", "Scrolled the preview"],
  preview_resize: ["Resizing the preview", "Resized the preview"],
  preview_upload: ["Uploading a file", "Uploaded a file"],
  preview_dialog: ["Answering a dialog", "Answered a dialog"],
  preview_evaluate: ["Running a script in the preview", "Ran a script in the preview"],
  preview_wait_for: ["Waiting on the page", "Waited on the page"],
  preview_set_appearance: ["Setting the preview's appearance", "Set the preview's appearance"],
  preview_recording_start: ["Recording the preview", "Started a recording"],
  preview_recording_stop: ["Stopping the recording", "Stopped the recording"],
  ask: ["Asking the coordinator", "Asked the coordinator"],
  answer: ["Answering a question", "Answered a question"],
  escalate: ["Passing a question to you", "Passed a question to you"],
  land: ["Queuing a thread to land", "Queued a thread to land"],
  checks_propose: ["Proposing checks", "Proposed checks"],
  read_context: ["Reading shared context", "Read shared context"],
  write_context: ["Writing shared context", "Wrote shared context"],
  spawn_agent: ["Starting a subagent", "Started a subagent"],
  list_agents: ["Listing subagents", "Listed subagents"],
  agent_status: ["Checking on a subagent", "Checked on a subagent"],
  message_agent: ["Messaging a subagent", "Messaged a subagent"],
  cancel_agent: ["Stopping a subagent", "Stopped a subagent"],
  agent_diff: ["Reading a subagent's diff", "Read a subagent's diff"],
};

// Computer use (PLX-897), by what the agent is doing or did and in which app, such as "Clicked in
// Notes", and what it typed, pressed, or set.
const computerTools = `${plxdTools}computer_`;
const computerLabels: Partial<Record<string, readonly [doing: string, done: string]>> = {
  list_apps: ["Listing apps", "Listed apps"],
  get_app_state: ["Looking at", "Looked at"],
  click: ["Clicking in", "Clicked in"],
  perform_secondary_action: ["Using a control in", "Used a control in"],
  scroll: ["Scrolling", "Scrolled"],
  drag: ["Dragging in", "Dragged in"],
  type_text: ["Typing in", "Typed in"],
  press_key: ["Pressing a key in", "Pressed a key in"],
  set_value: ["Setting a value in", "Set a value in"],
};

function computerCall(item: Extract<Item, { kind: "tool" }>, doing: boolean) {
  const tool = item.name?.startsWith(computerTools) ? item.name.slice(computerTools.length) : "";
  const labels = computerLabels[tool];
  if (!labels) return undefined;
  const verb = labels[doing ? 0 : 1];
  const app = toolHint(item.input, ["app"]);
  return {
    label: tool === "list_apps" ? verb : `${verb} ${app || "an app"}`,
    detail: toolHint(item.input, ["text", "key", "action", "value"]),
  };
}

/** A plxd tool's words for what it's doing and what it did, when this app knows the tool. */
const plxdLabel = (name: string | null) =>
  name?.startsWith(plxdTools) ? plxdLabels[name.slice(plxdTools.length)] : undefined;

/**
 * A plxd tool call as a short line: what it did, or is `doing`, and what to (the new thread's or
 * task's title or prompt, the secret, the file, the search, or the page). Undefined for any other
 * tool.
 */
function plxdCall(item: Extract<Item, { kind: "tool" }>, doing = false) {
  const computer = computerCall(item, doing);
  if (computer) return computer;
  const labels = plxdLabel(item.name);
  return labels
    ? {
        label: labels[doing ? 0 : 1],
        detail:
          item.subagent ??
          toolHint(item.input, ["title", "prompt", "task", "label", "path", "query", "url"]),
      }
    : undefined;
}

/**
 * An MCP server's tool as Claude Code names it, `mcp__<server>__<tool>`, readably: the server's
 * name, capitalized, or Parallax for plxd's, and the tool's. Undefined for any other tool.
 */
function mcpTool(name: string | null) {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name ?? "") ?? [];
  if (!server || !tool) return undefined;
  const words = server.replace(/[_-]/g, " ");
  return {
    server: server === "plxd" ? "Parallax" : words.charAt(0).toUpperCase() + words.slice(1),
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
  const Icon = icons[toolKind(name)];
  const mcp = mcpTool(name);
  if (mcp) return { Icon, label: mcp.server, detail: mcp.tool };
  if (name === "computer_use")
    return { Icon, label: "Computer use", detail: toolHint(input, ["app"]) };
  if (name === "Skill") return { Icon, label: "Skill", detail: skillName(input) };
  return { Icon, label: name, detail: toolHint(input) };
}

// Tools whose input reads better as a permission request shows it: an edit's diff.
const previewed = new Set(["Edit", "MultiEdit", "Write"]);

/** Whether a tool's input arrived whole, not cut for size. */
const isWhole = (input?: JsonValue): input is JsonValue =>
  input !== undefined && !(isObject(input) && input["truncated"] === true);

function inputText(input: JsonValue): string {
  if (isObject(input) && input["truncated"] === true) {
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
// a new window, which main hands to the system browser, https only. In a
// transcript, a link or image naming a file is read from the thread's folder
// through agent/file instead (FileLink.tsx, PLX-834).
const markdownComponents: Components = {
  a: ({ href, children }) => {
    const path = linkedPath(href);
    if (path !== undefined) return <FileLink path={path}>{children}</FileLink>;
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
  // Never load a remote image: a link with the alt text, which opens externally like any link.
  img: ({ src, alt }) => {
    const path = linkedPath(typeof src === "string" ? src : undefined);
    if (path !== undefined) return <FileImage path={path} alt={alt || "Image"} />;
    // An unsafe source arrives as "" from urlTransform: no href at all, then.
    return (
      <a href={typeof src === "string" && src ? src : undefined} target="_blank" rel="noreferrer">
        {alt || "Image"}
      </a>
    );
  },
};

// Highlights a code block whose fence names its language, never a guess; a diff's lines are
// drawn by DiffLines instead. Built once: react-markdown runs its plugins' setup on every render,
// and rehype-highlight's registers 37 languages each time.
const highlighter = rehypeHighlight({ detect: false, plainText: ["diff", "patch"] });
// Typesets $...$ and $$...$$ (and \(...\) and \[...\], which dollarMath rewrites to them) with
// KaTeX, which needs no network. Its output is plain elements, and invalid LaTeX stays as its source.
const typeset = rehypeKatex({ strict: "ignore" });
// Typesetting runs first, so math never reaches the code block renderer.
const highlight: ComponentProps<typeof Markdown>["rehypePlugins"] = [
  () => typeset,
  () => highlighter,
];

/** A Markdown tree node's text, as a code block's, for Copy. */
type TextNode = { value?: string; children?: TextNode[] };
const textOf = (node: TextNode): string => node.value ?? node.children?.map(textOf).join("") ?? "";

/**
 * An agent message, rendered from Markdown with GitHub's extensions. `components` replace some
 * elements' renderers, such as the Context view's links; they get the same safe, HTML-free tree.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  components,
  streaming,
}: {
  text: string;
  components?: Components;
  /** Hides LaTeX that fails to typeset, since a streaming message's math may be unfinished. */
  streaming?: boolean;
}) {
  const inThread = useContext(FileRunContext) !== undefined;
  return (
    <div className={streaming ? "markdown streaming" : "markdown"}>
      <Markdown
        remarkPlugins={gfm}
        rehypePlugins={highlight}
        components={{ ...markdownComponents, ...components }}
        urlTransform={inThread ? keepFiles : undefined}
      >
        {dollarMath(text)}
      </Markdown>
    </div>
  );
});

type MathNode = {
  type: string;
  children?: MathNode[];
  position?: { start: { offset?: number } };
  data?: { hProperties?: { className?: string[] } };
};

/**
 * remark-math reads `$$...$$` within a line as inline math, which typesets small and cramped.
 * Models write display equations that way, so mark those as display math.
 */
function displayDoubleDollar() {
  return (tree: MathNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: MathNode) => {
      const props = node.data?.hProperties;
      if (
        node.type === "inlineMath" &&
        props &&
        source.startsWith("$$", node.position?.start.offset)
      ) {
        props.className = ["language-math", "math-display"];
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const gfm = [remarkGfm, remarkMath, displayDoubleDollar];

/**
 * A streaming agent message, rendered as MarkdownText renders it, but block by block: an
 * unchanged block keeps its string, so its memo skips rendering it again, and each update
 * renders only the last block (PLX-448). When the message finishes, its row switches to
 * MarkdownText, which renders it whole once and remounts its code blocks.
 */
function StreamingMarkdown({ text }: { text: string }) {
  // The last update's blocks, so the split parses only the end of the message again.
  const blocks = useRef<string[]>([]);
  blocks.current = markdownBlocks(dollarMath(text), blocks.current);
  return (
    <div className="markdown streaming">
      {blocks.current.map((block, i) => (
        <MarkdownBlock key={i} text={block} />
      ))}
    </div>
  );
}

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const inThread = useContext(FileRunContext) !== undefined;
  return (
    <Markdown
      remarkPlugins={gfm}
      rehypePlugins={highlight}
      components={markdownComponents}
      urlTransform={inThread ? keepFiles : undefined}
    >
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

/** Under a prompt, on hover or focus: when it was sent, Copy for its text, Edit, and `fork`. */
function PromptMeta({
  at,
  text,
  fork,
  onEdit,
}: {
  at?: string;
  text?: string | null;
  fork?: ReactNode;
  onEdit?: () => void;
}) {
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
      {onEdit && (
        <button
          type="button"
          aria-label="Edit message"
          title="Edit message"
          onClick={onEdit}
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          <Pencil />
        </button>
      )}
      {fork}
    </div>
  );
}

/** A sent message being edited in place: its row, text, images, threads, and why a send failed. */
interface Editing {
  row: { key: string; turnId?: string };
  text: string;
  images: PromptImage[];
  threads?: readonly string[];
  error?: string;
  /** Sent, and waiting for the run to stop. */
  ready?: boolean;
}

/**
 * A stopped message as an editor where it was: its text, and its images, which can be removed.
 * Enter sends and Shift+Enter is a new line. Esc or Cancel leaves the run stopped.
 */
function EditMessage({
  editing,
  loadImage,
  disabledReason,
  onSend,
  onCancel,
}: {
  editing: Editing;
  loadImage?: (imageId: ImageId) => Promise<string | undefined>;
  disabledReason?: string;
  onSend: (text: string, images: PromptImage[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(editing.text);
  const [images, setImages] = useState(editing.images);
  const canSend = !disabledReason && (text.trim() !== "" || images.length > 0);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend(text, images);
      }}
      className="ml-auto flex w-[85%] flex-col items-end gap-1.5 py-2"
    >
      {images.length > 0 && (
        <MessageImages className="flex flex-wrap justify-end gap-1.5">
          {images.map((image, i) => (
            <div key={i} className="relative">
              <MessageImage image={image} loadImage={loadImage} />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => setImages((all) => all.filter((_, j) => j !== i))}
                className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground [&_svg]:size-3"
              >
                <X />
              </button>
            </div>
          ))}
        </MessageImages>
      )}
      <textarea
        autoFocus
        aria-label="Edit message"
        value={text}
        rows={Math.min(12, Math.max(2, text.split("\n").length))}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        className="w-full resize-none rounded-2xl border border-border bg-selected px-3.5 py-2 text-[14px] leading-relaxed outline-none focus:border-accent"
      />
      {editing.error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {editing.error}
        </p>
      )}
      <div className="flex items-center gap-3 text-[12.5px]">
        <button type="button" onClick={onCancel} className="text-muted-foreground">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSend || editing.ready}
          title={disabledReason}
          className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background disabled:opacity-40"
        >
          {editing.ready ? "Stopping…" : "Send"}
        </button>
      </div>
    </form>
  );
}

/** "3:04 PM" today, and "Sep 25, 3:04 PM" before. */
function sentAt(at: string) {
  const date = new Date(at);
  const time = clockOptions();
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(locale(), time)
    : date.toLocaleString(locale(), { month: "short", day: "numeric", ...time });
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
 * Where a run works in the composer's tab, as icons: the host's, then the checkout's or worktree's.
 * The hover title and accessible name read `{host} · Local checkout` or `{host} · Worktree`, as
 * New Thread's `RunTargetMenu` does. A Project's composer shows it too.
 */
export function CheckoutLabel({ host, checkout }: { host?: Host; checkout: boolean }) {
  const place = checkout ? "Local checkout" : "Worktree";
  const label = host ? `${host.name} · ${place}` : place;
  return (
    <span role="img" aria-label={label} title={label} className={`${tabItem} shrink-0`}>
      {host && hostIcon(host)}
      {checkout ? <Folder aria-hidden /> : <FolderGit2 aria-hidden />}
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

/** The device a `device_open` result names: `{"device": {"id": …}}`. */
function openedDeviceId(output?: string): string | undefined {
  try {
    const id = (JSON.parse(output ?? "") as { device?: { id?: unknown } }).device?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
