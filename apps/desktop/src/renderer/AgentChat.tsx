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
  Globe,
  Hammer,
  ImageOff,
  Info,
  ListChecks,
  LoaderCircle,
  MousePointerClick,
  Pencil,
  Plug,
  RotateCcw,
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
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";

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
import { CiteSelection, type Citation } from "./Cite";
import { Composer, listCommands, tabItem, type ComposerProps, type Unanswered } from "./Composer";
import { offlineReason, useConnection } from "./ConnectionStatus";
import { isEmpty, threadDrafts, type ComposerContents } from "./drafts";
import { dismiss as dismissNotice, notify } from "./notifications";
import { ForkButton, ForkContext, type ForkTarget } from "./Fork";
import type { Host } from "./hosts";
import { download, readAttachment } from "./documents";
import { DownloadButton, FileCards } from "./FileCards";
import { FileImage, FileRunContext, linkedPath, useOpenFile } from "./FileLink";
import { filePath, fileReference, unloadedImages } from "./markdownLinks";
import { HtmlRender, pageUrl } from "./HtmlRender";
import { imageCaps, imageUrl, loadImage } from "./images";
import { FileCard } from "./FileCard";
import { Lightbox } from "./Lightbox";
import { fromBase64 } from "./ooxml";
import { encodedImage, isImagePath, splitFiles, withFiles, withoutImages } from "./attachments";
import { uploadBytes, uploadFiles } from "./uploads";
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
import { ClaudeLogo, GitHubLogo, ParallaxGlyph } from "./logos";
import { codeRuns, markdownBlocks, SPLIT_FROM } from "./markdownBlocks";
import { mentionsOf, withMentions } from "./Mention";
import { onGithub, prNumber } from "./github";
import { dollarMath } from "./math";
import { useCatalog, type Provider, type RunOptions } from "./models";
import { kinds } from "./providers";
import { PlanStrip, PlanLine, ProposedPlan } from "./Plan";
import { latestPlan, withPlans, type PlanRow, type ProposedPlanRow } from "./plans";
import { searchText, useFind } from "./Find";
import { plainText, PromptRail, ScrollToEnd, type Prompt } from "./PromptRail";
import { attachThreads, SentThread, ThreadLinksContext, type ThreadLinks } from "./threadContext";
import { GoalStrip } from "./Goal";
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
import type { ForkChoice } from "./threads";
import {
  backgroundCalls,
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
  pursuedGoal,
  type Approval,
  type Item,
  type Subagent,
  type SubagentState,
  type Work,
} from "./transcript";
import { TurnChanges, TurnChangesContext, type TurnChangesTarget } from "./TurnChanges";
import {
  activity,
  inputText,
  mcpTool,
  relative,
  skillName,
  stepLabel,
  summarize,
  toolHint,
  toolKind,
  type Kind,
} from "./steps";
import { useAgentRun, type SentMessage } from "./useAgentRun";
import { presentWaiting } from "./waiting";
import { WaitingBar } from "./WaitingBar";
import { clockOptions } from "./prefs";
import { askSiteIcon, linkSite, siteIcons } from "./siteIcons";

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
  runId,
  prompt,
  going,
  listed,
  space,
  tab,
  strip,
  others,
  projectMode,
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
  /**
   * The run's first prompt, shown while the transcript holds no rows: before it loads only while
   * `going`, so a new thread opens on it.
   */
  prompt?: string;
  /**
   * Whether the run is known to be starting or running, as one this window just started is. Until
   * the transcript loads, `prompt` then shows as on its way to it, with the loader under it.
   */
  going?: boolean;
  /** The run as the thread list has it, which the composer shows until the transcript loads. */
  listed?: AgentRun;
  /** A chat in a Space: no Access picker. */
  space?: boolean;
  /**
   * The tab tucked under the composer, such as a coordinator's repository. A thread's own has
   * none: where it runs and its branch show in Thread details, as a new thread's picker did.
   */
  tab?: ReactNode;
  /** The back tab over the composer, behind the plan's, such as a Project's agents. */
  strip?: ComposerTab;
  /**
   * Permission requests other runs wait on, pinned here with this run's own, as a Project's other
   * runs' are in each of its chats (PLX-196).
   */
  others?: readonly Asked[];
  /** The Project's permission mode, shown in place of Access, for a run in a Project (0042). */
  projectMode?: ComposerProps["projectMode"];
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
  // A failed Send again, edit, or composed send, in a notification.
  const sendFailed = useCallback(
    (body?: string) => body && notify({ tone: "error", title: "Couldn't send the message", body }),
    [],
  );
  // Dropped follow-ups already sent again, so their Send again goes away (back on failure).
  const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
  const resend = useCallback(
    (turnId: string, message: SentMessage) => {
      setResent((prev) => new Set(prev).add(turnId));
      void send(message.text, undefined, message.images, message.threads).then((failed) => {
        sendFailed(failed?.message);
        if (failed)
          setResent((prev) => {
            const next = new Set(prev);
            next.delete(turnId);
            return next;
          });
      });
    },
    [send, sendFailed],
  );
  useEffect(() => {
    if (!compose) return;
    if (compose.send) void send(compose.text).then((failed) => sendFailed(failed?.message));
    onComposed?.();
  }, [compose, send, sendFailed, onComposed]);
  // Queued messages the user cancelled from here, whose followUpDropped notice is left out.
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set());
  // The sent message being edited in place, with its row, which it hides.
  const [editing, setEditing] = useState<Editing>();
  // The agent text last cited from the transcript, which the composer adds as a chip.
  const [cite, setCite] = useState<Citation>();
  // Taken once: the composer's effect, a child's, has added it by now, and a composer that mounts
  // again, as after a subagent's view, mustn't add it again.
  useEffect(() => {
    if (cite) setCite(undefined);
  }, [cite]);
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

  const sendText = async (
    text: string,
    options: RunOptions,
    images: PromptImage[],
    threads: string[],
    delivery?: AgentDelivery,
  ) => (await send(text, options, images, threads, delivery))?.message;

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
    // Before the transcript loads, only a run just started shows its prompt: an older one's
    // alone would show as all it holds.
    const listed: Row[] =
      all.length > 0 || !prompt || !(going || run)
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
  }, [items, sent, prompt, going, run, queue, cancelled, editing]);
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
    if (failed) return notify({ tone: "error", title: "Couldn't stop the thread", body: failed });
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
      if (typeof images === "string") {
        notify({ tone: "error", title: "Couldn't upload the images", body: images });
        return setEditing({ ...was, ready: false });
      }
      const text = withFiles(was.text, images);
      const failed = await sendText(text, {}, was.images, [...(was.threads ?? [])]);
      if (failed === undefined) return;
      sendFailed(failed);
      setEditing({ ...was, ready: false });
    })();
  }, [editing, stopped]);

  // A loaded transcript that stopped updating says why in a notification, gone once it updates
  // again or the thread closes. One that couldn't load says so in its place.
  const stoppedUpdating = rows.length > 0 ? error : undefined;
  useEffect(() => {
    if (!stoppedUpdating) return;
    const key = `chat/${hostId}/${runId}`;
    notify({ key, tone: "error", title: "This chat isn't updating", body: stoppedUpdating });
    return () => dismissNotice(key);
  }, [stoppedUpdating, hostId, runId]);
  // One that couldn't load, stopped updating, or lost plxd shows nothing in progress.
  const stalled = error !== undefined || (connection !== undefined && !connected);
  const live = isRunning(run?.status) && !stalled;
  // The subagents still running in the background, which outlast their parent's turn (PLX-929).
  const backgroundSubagents = useMemo(
    () => backgroundCalls(stalled ? [] : background),
    [background, stalled],
  );
  const native = useMemo(
    () => JSON.stringify(nativeSubagents(transcript.subagents, live, backgroundSubagents)),
    [transcript.subagents, live, backgroundSubagents],
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
        background: backgroundSubagents,
        open: (callId: string) => onOpenSubagent(runId, callId),
      },
    [transcript.subagents, live, backgroundSubagents, onOpenSubagent, runId],
  );
  const shown = subagent ? transcript.subagents?.[subagent] : undefined;

  // The run as the composer shows it: the transcript's, or until that loads, the thread list's, so
  // the box opens as it will look.
  const box = run ?? listed;
  let disabledReason = offlineReason(connection);
  if (connected && !run && (error || !box))
    disabledReason = error ? "This chat couldn't load" : "Loading…";
  let optionsDisabled: string | undefined;
  // `sendModel` is `sendOptions`' successor, which also takes the model (PLX-163). With
  // `sendAccount`, a message that changes them while the run works waits for it to finish.
  const moves = connected && "sendAccount" in connection.capabilities;
  if (connected && !("sendModel" in connection.capabilities))
    optionsDisabled = "This host's plxd can't change a thread's model, effort, or access";
  else if (isRunning(box?.status) && !moves)
    optionsDisabled = "The model, effort, and access can change once it finishes";
  // The instances the run can't move to, by why: any but its own on a plxd that can't move runs,
  // and for a coordinator, those that can't run one.
  const unavailable: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (i.id === box?.backend) continue;
    else if (!moves)
      unavailable[i.id] =
        `${i.name} is unavailable in this thread. Start a new thread to switch providers.`;
    else if (box?.policy === "noWrite" && !i.coordinator)
      unavailable[i.id] = `${i.name} can't run a Project's coordinator yet.`;
  // Manual's requests come here only from a run that asked for them, on a plxd that sends them.
  let manualDenied: "host" | "run" | undefined;
  if (connected && !("approvals" in connection.capabilities)) manualDenied = "host";
  else if (box && !box.approvals) manualDenied = "run";

  // Each turn's run, for its changes card: by its prompt row's turn id, and the first prompt's,
  // whose row has none, by `undefined`. A fork's first run is its copied prompt's, which has no
  // checkpoint, so its copied first reply shows no changes.
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Whether the transcript is scrolled up from its end, where the composer steps back.
  const [away, setAway] = useState(false);
  // Whether the composer stepped back for it, which shrinks its tabs too.
  const [back, setBack] = useState(false);
  // The height of the composer's column, which the transcript leaves free past its end.
  const [docked, setDocked] = useState(0);
  const dockRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const observer = new ResizeObserver(() => setDocked(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
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
            background={backgroundSubagents}
            stalled={stalled}
            onBack={() => onOpenSubagent?.(runId)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-body text-faint-foreground">
            {error ?? (run ? "This subagent isn't in the transcript" : "Loading…")}
          </div>
        )}
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5">{pinned}</div>
      </SubagentsContext>
    );

  // The tabs over the composer, in order along their line: the first shows in full.
  const running = isRunning(run?.status);
  const tabs: ComposerTab[] = [];
  if (strip) tabs.push(strip);
  const subagentTabRows = nativeRows(transcript.subagents, live, backgroundSubagents);
  const subagentsShown = !!subagents && subagentTabRows.some(isGoing);
  if (subagentsShown) {
    const bar = (compact: boolean) => (
      <AgentsBar
        rows={subagentTabRows}
        label="Subagents"
        onOpen={subagents.open}
        compact={compact}
      />
    );
    tabs.push({ key: "subagents", node: bar(false), compact: bar(true) });
  }
  // Once its turn settles, as T3 Code's strip: a turn's own work shows in the transcript.
  if (!running && presentWaiting(background, watching)) {
    const bar = (compact: boolean) => (
      <WaitingBar
        hostId={hostId}
        runId={runId}
        background={background}
        watching={watching}
        agentsShown={subagentsShown}
        compact={compact}
      />
    );
    tabs.push({ key: "waiting", node: bar(false), compact: bar(true) });
  }
  if (goal && running && !stalled)
    tabs.push({
      key: "goal",
      node: <GoalStrip objective={goal} />,
      compact: <GoalStrip objective={goal} compact />,
    });
  // The latest turn's plan, while the run works on it.
  if (plan && running && !stalled) {
    const strip = (compact: boolean) => (
      <PlanStrip
        items={plan.items}
        active={plan.active}
        returnFocus={focusComposer}
        compact={compact}
      />
    );
    tabs.push({ key: "plan", node: strip(false), compact: strip(true) });
  }
  if (queueEnabled && queue.length > 0) {
    const strip = (compact: boolean) => (
      <QueueStrip
        hostId={hostId}
        runId={runId}
        messages={queue}
        held={held}
        running={running}
        disabledReason={disabledReason}
        onCancelled={(id) => setCancelled((prev) => new Set(prev).add(id))}
        compact={compact}
      />
    );
    tabs.push({ key: "queue", node: strip(false), compact: strip(true) });
  }

  const dock = (
    // A column the window bounds, so a pinned card's preview gives way to a grown composer. Only
    // what's in it takes the pointer, so the transcript under its margins still scrolls.
    <div className="pointer-events-none mx-auto flex min-h-0 w-full max-w-3xl flex-col px-6 pb-5 *:pointer-events-auto">
      {/* Requests waiting on the user, pinned so they can't scroll away. */}
      {pinned}
      {/* Narrows with a composer that steps back, its tabs with it. */}
      <div
        className={`transition-[margin] duration-200 ease-out motion-reduce:transition-none ${back ? "mx-10" : ""}`}
      >
        <ComposerTabs tabs={tabs} short={back} />
        <Composer
          // One sent before the transcript loads stays in the box.
          onSend={(text, options, images, threads) =>
            run
              ? sendText(text, options, images, threads, queueEnabled ? "queue" : undefined)
              : Promise.resolve("")
          }
          onSteer={
            queueEnabled && running
              ? (text, options, images, threads) =>
                  sendText(text, options, images, threads, "steer")
              : undefined
          }
          history={history}
          onStop={isRunning(box?.status) ? stop : undefined}
          unanswered={stopBack}
          disabledReason={disabledReason}
          tab={tab}
          backend={box?.backend}
          started={box}
          accountId={box?.accountId}
          requestUsage={transcript.requestUsage}
          threadUsage={transcript.threadUsage}
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
          cite={cite}
          menus={
            connected && "composerMenus" in connection.capabilities ? { hostId, runId } : undefined
          }
          attach={attachThreads(connection, threadLinks, runId)}
          // What the box last held, where a subagent's view took it away, else the saved draft.
          initial={contents.current ?? draft}
          contents={contents}
          away={away}
          onBack={setBack}
        />
      </div>
    </div>
  );

  // With a transcript, the composer floats over its bottom, which scrolls under it.
  const hasRows = rows.length > 0 || !!editing;
  return (
    <SubagentsContext value={subagents}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {hasRows ? (
          <ThreadLinksContext value={threadLinks}>
            <ForkContext value={forkTarget}>
              <TurnChangesContext value={turnChanges}>
                <TranscriptView
                  rows={rows}
                  sent={unsent}
                  live={running}
                  stalled={stalled}
                  turnDone={transcript.turnDone}
                  root={run?.worktreePath}
                  runId={runId}
                  backend={run?.backend}
                  // plxd logs a fork's copied history with its agent.started, at its creation (0050).
                  copiedAt={forked ? run?.createdAt : undefined}
                  onResend={resend}
                  loadImage={showImage}
                  onCite={setCite}
                  onNearTop={older ? loadOlder : undefined}
                  onScrolledUp={setAway}
                  docked={docked}
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
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center text-body text-faint-foreground">
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
        {/* In one place either way, so the composer keeps its focus and choices as rows arrive. */}
        <div
          ref={dockRef}
          className={`flex min-h-0 flex-col ${hasRows ? "pointer-events-none absolute inset-x-0 bottom-0 max-h-full" : ""}`}
        >
          {dock}
        </div>
      </div>
    </SubagentsContext>
  );
}

const noneSent: ReadonlyMap<string, SentMessage> = new Map();

const subagentAttention: Record<SubagentState, AgentRow["attention"]> = {
  running: "working",
  completed: "done",
  failed: "failed",
  stopped: "settled",
};

/** A thread's own subagents as the Subagents tab lists them, oldest first, nested ones left out. */
function nativeRows(
  subagents: Readonly<Record<string, Subagent>> | undefined,
  live: boolean,
  background: ReadonlySet<string>,
) {
  return nativeSubagents(subagents, live, background)
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
  background,
  stalled,
  onBack,
}: {
  sub: Subagent;
  live: boolean;
  background: ReadonlySet<string>;
  stalled: boolean;
  /** Opens its thread. */
  onBack: () => void;
}) {
  const rows = useMemo(() => subagentRows(sub), [sub]);
  const state = subagentState(sub, live, background);
  const keys = useShortcutLabel("parentThread");
  return (
    <>
      <TranscriptView rows={rows} sent={noneSent} live={state === "running"} stalled={stalled} />
      <div className="mx-auto w-full max-w-3xl px-6 pt-1">
        <div
          role="status"
          aria-label="Subagent"
          className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-surface py-2.5 pr-2.5 pl-4 text-body text-muted-foreground"
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
            {keys && <kbd className="font-sans text-caption text-faint-foreground">{keys}</kbd>}
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
  onCite,
  onScrolledUp,
  docked = 0,
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
  /** Offers Cite over agent text the user selects, which hands it here with their comment. */
  onCite?: (citation: Citation) => void;
  /**
   * Told whether it's scrolled well up from the end, and `false` as it unmounts. It turns on past
   * `awayGap` and off at the end, so a composer that shrinks for it can't flip it back.
   */
  onScrolledUp?: (up: boolean) => void;
  /** The height of what floats over the list's bottom, such as the composer, left free past its end. */
  docked?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const links = useContext(ThreadLinksContext);
  const known = useKnownMentions(links?.hostId, backend, runId, rows, sent);
  const rowContext = useMemo(() => ({ root, loadImage, known }), [root, loadImage, known]);
  // Threads' titles, to name the thread that sent a message or stopped this one (0041).
  const titles = links?.state.titles;
  const hostId = links?.hostId;
  const fileRun = useMemo(() => (hostId && runId ? { hostId, runId } : undefined), [hostId, runId]);
  // Whether the list follows new output, which `follows` decides as it scrolls.
  const atBottom = useRef(true);
  // The way the user last scrolled by wheel or key (PLX-1031).
  const way = useRef<"up" | "down">(undefined);
  // The user scrolls the list up or down. Up stops following at once, before the scroll lands, so
  // an update in between can't pull the list back down.
  const scrolled = (up: boolean) => {
    way.current = up ? "up" : "down";
    if (up) atBottom.current = false;
  };
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
  const [away, setAway] = useState(false);
  useEffect(() => {
    onScrolledUp?.(away);
    return () => onScrolledUp?.(false);
  }, [away, onScrolledUp]);
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
  }, [total, view.length, follow, !!end, docked]);
  // Near the top, the next older page loads.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && onNearTop && el.scrollTop < el.clientHeight) onNearTop();
  });
  // As the window shrinks the list from below, keep the latest output in view.
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
    scrolled(false);
    setScrolledUp(false);
    setAway(false);
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
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            atBottom.current = follows(gap, way.current);
            if (atBottom.current) ending.current = false;
            // Scroll to end's smooth scroll passes through the middle, where it stays hidden.
            if (!ending.current) {
              setScrolledUp(!atBottom.current);
              if (atBottom.current || gap > awayGap) setAway(!atBottom.current);
            }
            if (onNearTop && el.scrollTop < el.clientHeight) onNearTop();
            follow();
          }}
          // Scrolling by hand cuts Scroll to end's scroll short. Only a scroll that moves the list
          // itself sets the way it was scrolled: not one a box in it takes, a sideways swipe, keys
          // typed in a field such as the message editor, or a scroll up with nowhere to go.
          onWheel={(e) => {
            ending.current = false;
            const el = e.currentTarget;
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || takenInside(e.target, el, e.deltaY))
              return;
            if (e.deltaY > 0 || el.scrollTop > 0) scrolled(e.deltaY < 0);
          }}
          onPointerDown={() => (ending.current = false)}
          onKeyDown={(e) => {
            ending.current = false;
            if (editable(e.target)) return;
            // Space pages down, and up with Shift.
            const key = e.key === " " ? (e.shiftKey ? "PageUp" : "PageDown") : e.key;
            if (upKeys.has(key) && e.currentTarget.scrollTop > 0) scrolled(true);
            else if (downKeys.has(key)) scrolled(false);
          }}
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
          <div aria-hidden style={{ height: docked }} />
        </div>
        {/* One prompt is no choice of where to go, so there's no rail for it. */}
        {prompts.length > 1 && <PromptRail prompts={prompts} current={reading} onJump={jump} />}
        {scrolledUp && <ScrollToEnd onClick={scrollToEnd} bottom={docked} />}
        {findBar}
        {onCite && <CiteSelection log={scrollRef} onCite={onCite} />}
      </div>
    </RowContext>
  );
  return <FileRunContext value={fileRun}>{transcript}</FileRunContext>;
}

// How far up from the end, in pixels, the transcript tells `onScrolledUp`: past what a composer
// that shrinks for it gives back, so the shrink can't bring the end into reach.
const awayGap = 160;

// Rows of the agent's work, which sit closer to one another and to the messages around them, as
// T3 Code's work log does (PLX-584, PLX-770).
const listKinds = new Set(["work", "plan", "todo", "musing", "compaction", "epoch"]);

// The keys that scroll the transcript up, and down.
const upKeys = new Set(["ArrowUp", "PageUp", "Home"]);
const downKeys = new Set(["ArrowDown", "PageDown", "End"]);

/**
 * Whether the transcript follows new output, from its distance to the end (`gap`) and the way the
 * user last scrolled by wheel or key (PLX-1031). Once they scroll up it doesn't, however near the
 * end, until they scroll back down near it or reach the end itself. Scrolls the user didn't make,
 * such as the list keeping rows in place as they're measured, don't change their way.
 */
function follows(gap: number, way: "up" | "down" | undefined) {
  return gap < 1 || (gap < 48 && way !== "up");
}

/** Whether a box between `target` and `list`, such as a tool's output, scrolls by `deltaY` instead. */
function takenInside(target: EventTarget, list: HTMLElement, deltaY: number) {
  for (let el = target as Element | null; el && el !== list; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const { overflowY } = getComputedStyle(el);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)
      return true;
  }
  return false;
}

/** Whether keys pressed in `target` edit text rather than scroll. */
function editable(target: EventTarget) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, select"))
  );
}

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
    case "epoch":
      // A coordinator's new session (0079): the conversation before it is no longer the agent's.
      return (
        <Divider>
          <RotateCcw aria-hidden className="size-3.5" />
          <span>New session, picked up from the Project's state</span>
        </Divider>
      );
    case "compaction":
      // Under way, it's the live row; done, a divider where the earlier conversation became a summary.
      return row.done ? (
        <Divider>
          <FoldVertical aria-hidden className="size-3.5" />
          <span>Context compacted</span>
        </Divider>
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
            <p className="text-body leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
            <div className="max-w-[85%] rounded-xl bg-selected px-3.5 py-2 text-reading leading-relaxed wrap-break-word whitespace-pre-wrap">
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
          <PromptMeta
            at={copied ? undefined : row.at}
            text={row.text}
            fork={forkable && <ForkButton turnId={replyTurn} />}
          />
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
          <p className="text-body leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
        <p className="flex items-start gap-2 text-body text-muted-foreground">
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
        <Divider>
          <ArrowLeftRight aria-hidden className="size-3.5" />
          <span>Switched model</span>
          <ModelLabel model={row.from} />
          <ArrowRight aria-hidden className="size-3.5" />
          <ModelLabel model={row.to} />
        </Divider>
      );
    case "end": {
      const { outcome } = row;
      if (outcome.status === "failed") {
        // A coordinator's no-write stop lists what it changed after its first line, one
        // `git status` line each (0024).
        const [first, ...changed] = outcome.message.split("\n");
        return (
          <div role="alert" className="rounded-lg border border-danger/30 px-3.5 py-2.5 text-body">
            <p className="font-medium text-danger">Failed: {failureText(outcome.failure)}</p>
            <p className="mt-0.5 text-muted-foreground">{first}</p>
            {changed.length > 0 && (
              <pre className="mt-2 max-h-60 overflow-auto rounded-xl border border-border bg-code px-3 py-2 font-mono text-meta">
                {changed.join("\n")}
              </pre>
            )}
          </div>
        );
      }
      const label = endLabels[outcome.status] ?? "Ended";
      return (
        <div className="flex items-center gap-3 text-meta text-faint-foreground">
          <span className="h-px flex-1 bg-border" />
          {label}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }
  }
});

/** A rule across the transcript with `children` in its middle, where the conversation turns. */
function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-meta text-faint-foreground">
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

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
  const SummaryIcon = icons[summary.kind];
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
            <SummaryIcon />
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
    <p className="border-b border-border/60 pb-2 text-body text-muted-foreground tabular-nums">
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
} as const satisfies Record<Kind, ComponentType<SVGProps<SVGSVGElement>>>;

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
      <div className="space-y-2 text-meta">
        {item.name && previewed.has(item.name) && isWhole(item.input) ? (
          <div>
            <p className="mb-1 text-meta text-faint-foreground">Input</p>
            <RequestPreview request={{ toolName: item.name, input: item.input }} />
          </div>
        ) : (
          item.input !== undefined && <Block label="Input">{inputText(item.input)}</Block>
        )}
        {!!item.images?.length && (
          <div>
            <p className="mb-1 text-meta text-faint-foreground">Images</p>
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
      <p className="mb-1 text-meta text-faint-foreground">{label}</p>
      <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-code px-3 py-2 font-mono leading-relaxed whitespace-pre-wrap text-foreground">
        {children}
      </pre>
    </div>
  );
}

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

// Agent output is untrusted. Enriched Markdown draws raw HTML as its text, never as elements, and
// every link goes through `follow`: a file in the thread's folder opens in the side panel
// (FileLink.tsx, PLX-834), and a web page opens in a new window, which main hands to the system
// browser, https only. No remote image or video loads: each stays a link with its alt text.

/** Which remote images Markdown loads: a pull request's GitHub-hosted ones, or none. */
type Images = "github" | "none";

/**
 * The desktop's `.markdown` look in Enriched Markdown's terms, from the theme's variables, so it
 * follows the appearance with no style of its own: the transcript's 14px text, headings in weight,
 * code in the mono font on the code fill, tables as rounded cards, and GitHub's alerts in the
 * theme's colors.
 */
const markdownStyle: MarkdownStyle = (() => {
  const body = {
    fontSize: 14,
    lineHeight: 23,
    fontFamily: "var(--font-sans)",
    color: "var(--foreground)",
    marginTop: 0,
    marginBottom: 10,
  };
  const heading = (fontSize: number) => ({
    ...body,
    fontSize,
    lineHeight: Math.round(fontSize * 1.3),
    fontWeight: "600",
    marginTop: Math.round(fontSize * 1.1),
    marginBottom: 8,
  });
  return {
    paragraph: body,
    h1: heading(19),
    h2: heading(16),
    h3: heading(14),
    h4: heading(14),
    h5: heading(14),
    h6: heading(14),
    strong: { fontWeight: "bold" },
    link: { color: "var(--accent)", underline: false },
    code: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      // The text's color, so code that's a link's text is the link's.
      color: "inherit",
      backgroundColor: "var(--code)",
      borderColor: "var(--border)",
    },
    codeBlock: {
      ...body,
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      lineHeight: 20,
      backgroundColor: "var(--code)",
      borderColor: "var(--border)",
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
    },
    blockquote: {
      ...body,
      color: "var(--muted-foreground)",
      borderColor: "color-mix(in oklab, var(--foreground) 18%, transparent)",
      borderWidth: 3,
      gapWidth: 12,
      backgroundColor: "transparent",
      admonitions: {
        note: { color: "var(--accent)" },
        tip: { color: "var(--added)" },
        important: { color: "var(--project-violet)" },
        warning: { color: "var(--warning)" },
        caution: { color: "var(--danger)" },
      },
    },
    list: {
      ...body,
      bulletColor: "var(--faint-foreground)",
      markerColor: "var(--faint-foreground)",
      itemSpacing: 4,
    },
    taskList: {
      checkedColor: "var(--accent)",
      borderColor: "var(--faint-foreground)",
      checkedTextColor: "var(--foreground)",
      checkedStrikethrough: false,
    },
    table: {
      ...body,
      fontSize: 13,
      lineHeight: 20,
      headerBackgroundColor: "var(--hover)",
      headerTextColor: "var(--foreground)",
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      borderColor: "var(--border)",
      borderWidth: 1,
      borderRadius: 8,
      cellPaddingHorizontal: 11,
      cellPaddingVertical: 6,
      // On the web, any alignment makes a table as wide as its content, up to its container's.
      align: "left",
    },
    thematicBreak: { color: "var(--border)", height: 1, marginTop: 16, marginBottom: 16 },
    math: {
      color: "var(--foreground)",
      backgroundColor: "transparent",
      marginTop: 0,
      marginBottom: 10,
    },
    inlineMath: { color: "var(--foreground)" },
    image: { borderRadius: 8, marginTop: 0, marginBottom: 10 },
  };
})();

// In a transcript, inline code that names a file, such as `src/App.tsx`, is a link to it.
const recognition = { inlineCode: filePath };

/**
 * Follows a Markdown link: a file to `openFile`, an https page to a new window, which main hands
 * to the system's browser, and any other scheme, `javascript:` among them, nowhere, as main would
 * open none of them.
 */
function follow(url: string, openFile?: (path: string) => void) {
  const path = linkedPath(fileReference(url));
  if (path !== undefined) openFile?.(path);
  else if (/^https:/i.test(url)) window.open(url, "_blank", "noreferrer");
}

const linkIcon = "mr-1 inline size-3.5 rounded-[3px] align-[-0.15em]";

/**
 * What a transcript's link draws: a GitHub pull request as GitHub's mark and its number, any
 * other https page with its site's icon before its text, and a file's link, or another scheme's,
 * as its text alone.
 */
function linkContent({ url, children }: { url: string; children: ReactNode }) {
  const number = prNumber(url);
  if (number)
    return (
      <span className="whitespace-nowrap">
        <GitHubLogo className={`${linkIcon} text-foreground`} />#{number}
      </span>
    );
  const site = linkSite(url);
  if (!site) return children;
  return (
    <>
      <SiteIcon site={site} />
      {children}
    </>
  );
}

/**
 * A site's icon, before a link's text: GitHub's mark in the text's color, which GitHub's own dark
 * favicon isn't on a dark theme, or the site's favicon once main has fetched it, a globe until
 * then or when it has none or it doesn't load.
 */
function SiteIcon({ site }: { site: string }) {
  const github = site === "https://github.com";
  const icon = siteIcons.use()[site];
  // An icon sent as an image that doesn't decode.
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!github) askSiteIcon(site);
  }, [site, github]);
  if (github) return <GitHubLogo className={`${linkIcon} text-foreground`} />;
  return icon && !broken ? (
    <img src={icon} alt="" onError={() => setBroken(true)} className={linkIcon} />
  ) : (
    <Globe aria-hidden className={`${linkIcon} text-foreground`} />
  );
}

/** Markdown between code blocks, drawn by Enriched Markdown's web renderer. */
const EnrichedRun = memo(function EnrichedRun({ text, images }: { text: string; images: Images }) {
  const openFile = useOpenFile();
  const remote = (url: string) => images === "github" && onGithub(url);
  // A thread's own file shows, as FileImage reads it, where it's a paragraph of its own, which
  // the renderer hands to `renderers.image`; any other image is a link.
  const markdown = useMemo(
    () =>
      unloadedImages(
        text,
        (url, alone) => remote(url) || (alone && !!openFile && linkedPath(url) !== undefined),
      ),
    [text, images, !!openFile],
  );
  return (
    <EnrichedMarkdownText
      markdown={markdown}
      markdownStyle={markdownStyle}
      md4cFlags={{ latexMath: true }}
      linkRecognition={openFile ? recognition : undefined}
      enableTaskListItemToggle={false}
      onLinkPress={({ url }) => follow(url, openFile)}
      renderLinkContent={linkContent}
      // An empty source keeps an image unrequested: a URL an agent writes can carry what it read.
      resolveImageSource={({ url }) => (remote(url) ? undefined : { uri: "" })}
      renderers={{
        image: ({ url, altText }) => {
          const path = linkedPath(url);
          return path !== undefined && openFile ? (
            <FileImage path={path} alt={altText || "Image"} />
          ) : undefined;
        },
        video: ({ url }) => (
          <a
            href={url}
            onClick={(e) => {
              e.preventDefault();
              follow(url, openFile);
            }}
          >
            Video
          </a>
        ),
      }}
    />
  );
});

// Highlights a code block whose fence names its language, never a guess; a diff's lines are
// drawn by DiffLines instead. Built once: react-markdown runs its plugins' setup on every render,
// and rehype-highlight's registers 37 languages each time.
const highlighter = rehypeHighlight({ detect: false, plainText: ["diff", "patch"] });
export const highlight: ComponentProps<typeof Markdown>["rehypePlugins"] = [() => highlighter];

/** A Markdown tree node's text, as a code block's, for Copy. */
type TextNode = { value?: string; children?: TextNode[] };
const textOf = (node: TextNode): string => node.value ?? node.children?.map(textOf).join("") ?? "";

/** react-markdown's code blocks as CodeBlock, for Markdown it still draws (ContextPanel.tsx). */
export const codeComponents: Components = {
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
};

/**
 * A code block, as CodeBlock draws it: its language, Copy, and highlighting, or a diff's lines,
 * which Enriched Markdown's web renderer has none of.
 */
const FencedCode = memo(function FencedCode({ text }: { text: string }) {
  return (
    <Markdown rehypePlugins={highlight} components={codeComponents}>
      {text}
    </Markdown>
  );
});

/** Markdown in runs (codeRuns): its code blocks as FencedCode, the rest with Enriched Markdown. */
function Runs({ text, images = "none" }: { text: string; images?: Images }) {
  const runs = useMemo(() => codeRuns(text), [text]);
  return runs.map((run, i) =>
    run.code ? (
      <FencedCode key={i} text={run.text} />
    ) : (
      <EnrichedRun key={i} text={run.text} images={images} />
    ),
  );
}

/**
 * Markdown as GitHub writes it, drawn by Enriched Markdown as the phone draws it (apps/mobile
 * ui.tsx): headings, lists and task lists, tables, quotes and GitHub's alerts, KaTeX math, and
 * links, with code blocks as CodeBlock. With `images` "github", GitHub-hosted images load, as a
 * pull request's do.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  images,
  streaming,
}: {
  text: string;
  images?: Images;
  /** Hides LaTeX that fails to typeset, since a streaming message's math may be unfinished. */
  streaming?: boolean;
}) {
  return (
    <div className={streaming ? "enriched streaming" : "enriched"}>
      <Runs text={dollarMath(text)} images={images} />
    </div>
  );
});

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
    <div className="enriched streaming">
      {blocks.current.map((block, i) => (
        <MarkdownBlock key={i} text={block} />
      ))}
    </div>
  );
}

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return <Runs text={text} />;
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

/**
 * Under a prompt or a turn's reply, on hover or focus: when it was sent, Copy for its text, Edit,
 * and `fork`.
 */
function PromptMeta({
  at,
  text,
  fork,
  onEdit,
}: {
  at?: string;
  text?: string;
  fork?: ReactNode;
  onEdit?: () => void;
}) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex h-6 items-center gap-1 text-meta text-faint-foreground opacity-0 group-focus-within/prompt:opacity-100 group-hover/prompt:opacity-100">
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
        className="w-full resize-none rounded-xl border border-border bg-selected px-3.5 py-2 text-reading leading-relaxed outline-none focus:border-accent"
      />
      <div className="flex items-center gap-3 text-body">
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
      <div className="flex h-8 items-center justify-between border-b border-border pr-1 pl-3 text-meta text-faint-foreground">
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
        <pre className="code-lines overflow-x-auto px-3.5 py-3 font-mono text-body leading-relaxed">
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
    <div className="code-scroll overflow-x-auto py-1.5 font-mono text-meta leading-relaxed">
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
 * Where a Project's coordinator works, in its composer's tab, as icons: the host's, then the
 * checkout's or worktree's. The hover title and accessible name read `{host} · Local checkout` or
 * `{host} · Worktree`, as New Thread's `RunTargetMenu` does.
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

/** The device a `device_open` result names: `{"device": {"id": …}}`. */
function openedDeviceId(output?: string): string | undefined {
  try {
    const id = (JSON.parse(output ?? "") as { device?: { id?: unknown } }).device?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
