// One thread, on any computer, as the desktop's transcript shows it (AgentChat.tsx), starting at its
// first message as a chat does: the user's messages in bubbles with their images and files, which a
// long press lifts into a menu (MessageMenu.tsx), the agent's answers with a Copy button under each,
// its steps as the desktop's trace lines (steps.ts words them), a finished turn folded under
// "Worked for …" with the files it changed, the files it presented, and the composer, with what
// waits on the user and the thread's tabs over it (ThreadStrips.tsx). A fold or a run of steps opens
// in the trace sheet (TraceSheet.tsx), and a lone step at its detail. Images open in the lightbox,
// and other files, as cards, in Quick Look. Until the transcript loads, a skeleton stands in.
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackHeaderItemMenuAction, NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { Check, ChevronRight, Copy, FoldVertical, Hand, KeyRound, RotateCcw, WifiOff } from "lucide-react-native";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { splitFiles, isImagePath } from "../../desktop/src/renderer/attachments";
import { attentionOf } from "../../desktop/src/renderer/attention";
import { activity, stepLabel, summarize, toolKind } from "../../desktop/src/renderer/steps";
import { asksOf, parentOf } from "../../desktop/src/renderer/threads";
import {
  failureText,
  groupWork,
  isMedia,
  isRunning,
  statusLabel,
  workedFor,
  type DocRef,
  type Item,
  type Work,
} from "../../desktop/src/renderer/transcript";
import { useAgentRun } from "../../desktop/src/renderer/useAgentRun";
import type { ThreadRun } from "../../desktop/src/protocol/generated/protocol";
import { Composer } from "./Composer";
import { TurnChanges } from "./Diff";
import { counts, editRows } from "./diffLogic";
import { FileCard, openLinked } from "./FileCard";
import { useComputer, useFleet } from "./fleet";
import { openLightbox } from "./Lightbox";
import { MessageMenu } from "./MessageMenu";
import type { Screens } from "./nav";
import { DiffStats } from "./PullRequestParts";
import { setViewing } from "./push";
import { TranscriptSkeleton } from "./Skeleton";
import { startedPrompt } from "./started";
import { ThreadStrips } from "./ThreadStrips";
import { opens, RunImage, titleOf, toolLook, TraceSheet } from "./TraceSheet";
import { unansweredOf } from "./unanswered";
import {
  AttentionBadge,
  duration,
  Icon,
  KindIcon,
  Markdown,
  T,
  useColors,
  useSeconds,
  WorkingMark,
} from "./ui";

/**
 * The thread, as the rows below need it: where it runs, which changed files are open, each turn's
 * run by the turn id of its last reply, for its changed files, what opens the trace sheet, and the
 * message Edit can take back.
 */
interface RowContextValue {
  hostId: string;
  runId: string;
  root?: string;
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
  replies: ReadonlyMap<string, ThreadRun>;
  /** Opens the trace sheet on `work` under `title`, at step `start`'s detail when given. */
  openTrace: (work: Work, title: string, start?: string) => void;
  /** The latest message while the agent hasn't answered it, by its row key, and what edits it. */
  editable?: { key: string; edit: () => void };
}
const RowContext = createContext<RowContextValue>(null!);

type TraceStatus = "running" | "error" | "pending" | undefined;

/** One trace line, as the desktop's TraceLine: an icon, a title, how it went, and a chevron when it opens. */
function TraceLine({
  icon,
  title,
  description,
  status,
  onPress,
  changed,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  status?: TraceStatus;
  onPress?: () => void;
  /** An edit's lines added and removed. */
  changed?: { added: number; removed: number };
}) {
  const c = useColors();
  const color = status === "error" ? c.danger : c.mutedForeground;
  const line = (
    <View style={[styles.line, status === "pending" && { opacity: 0.6 }]}>
      {!!icon && <View style={styles.traceIcon}>{icon}</View>}
      <T numberOfLines={1} style={{ ...styles.trace, color, flexShrink: 1 }}>
        {title}
      </T>
      {changed && <DiffStats additions={changed.added} deletions={changed.removed} compact />}
      {!!description && (
        <T style={{ ...styles.trace, color: status === "error" ? c.danger : c.faintForeground }}>
          {description}
        </T>
      )}
      {onPress && <Icon icon={ChevronRight} size={15} color={c.faintForeground} />}
    </View>
  );
  if (!onPress) return line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens its steps"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => pressed && { opacity: 0.55 }}
    >
      {line}
    </Pressable>
  );
}

/** A lone call's line: its icon, what it did, how it went, and an edit's lines changed. */
function ToolLine({ item, live, onPress }: { item: Extract<Item, { kind: "tool" }>; live: boolean; onPress?: () => void }) {
  const c = useColors();
  const { root } = useContext(RowContext);
  const look = toolLook(item, live);
  const diff = useMemo(() => editRows(item.name, item.input), [item.name, item.input]);
  return (
    <TraceLine
      icon={look.tone === "running" ? <WorkingMark size={14} /> : <KindIcon kind={toolKind(item.name)} color={look.tone === "error" ? c.danger : c.mutedForeground} />}
      title={stepLabel(item, root, look.tone === "running")}
      description={look.said}
      status={look.tone}
      onPress={onPress}
      changed={diff && counts(diff)}
    />
  );
}

/** A lone step's line: a call, a thought, a checklist, or a notice. */
function StepLine({ item, live, onPress }: { item: Item; live: boolean; onPress?: () => void }) {
  const c = useColors();
  switch (item.kind) {
    case "tool":
      return <ToolLine item={item} live={live} onPress={onPress} />;
    case "reasoning":
      return <TraceLine icon={<KindIcon kind="thinking" color={c.mutedForeground} />} title="Thought" onPress={onPress} />;
    case "todo":
      return <TraceLine icon={<KindIcon kind="planning" color={c.mutedForeground} />} title="Updated the plan" onPress={onPress} />;
    default:
      return <RowView row={item} live={live} />;
  }
}

/** The kinds of row a fold's steps are, for its sheet's title. */
const stepKinds = ["reasoning", "tool", "todo"];

/** A run of steps: one alone as its line, several as their summary, or what's under way now. */
function Steps({ work, live }: { work: Work; live: boolean }) {
  const c = useColors();
  const { root, openTrace } = useContext(RowContext);
  const only = work.items.length === 1 ? work.items[0]! : undefined;
  const last = work.items.findLast((i) => i.kind !== "notice");
  const active = live && last?.kind === "tool" && last.status === undefined;
  const summary = summarize(work.items);
  const open = (start?: string) => () => openTrace(work, summary.label, start);
  if (only && !active) return <StepLine item={only} live={live} onPress={opens(only) ? open(only.key) : undefined} />;
  const now = active ? activity(last) : undefined;
  if (now)
    return (
      <TraceLine
        icon={<WorkingMark size={14} />}
        title={now.detail ? `${now.label} ${now.detail.replace(`${root}/`, "")}` : now.label}
        status="running"
        onPress={open()}
      />
    );
  return (
    <TraceLine
      icon={<KindIcon kind={summary.kind} color={summary.failures ? c.danger : c.mutedForeground} />}
      title={summary.label}
      description={summary.failures ? `${summary.failures} failed` : undefined}
      status={summary.failures ? "error" : undefined}
      onPress={open()}
    />
  );
}

/** The quiet buttons under an answer, as Claude's app has them: Copy, its Markdown, with a check a moment after. */
function ReplyActions({ text }: { text: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View style={styles.actions}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? "Copied" : "Copy"}
        hitSlop={6}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void Clipboard.setStringAsync(text);
          setCopied(true);
        }}
        style={({ pressed }) => [styles.action, pressed && { backgroundColor: c.selected }]}
      >
        <Icon icon={copied ? Check : Copy} size={16} color={c.faintForeground} />
      </Pressable>
    </View>
  );
}

/** The files a turn presented: images as pictures that open the lightbox, others as cards. */
function FilesRow({ files }: { files: DocRef[] }) {
  const c = useColors();
  const { hostId } = useContext(RowContext);
  const pictures = files.filter((f) => isMedia(f.kind) && !/\.(mp4|webm|mov)$/i.test(f.name));
  const [uris, setUris] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const f of pictures)
      void readPicture(hostId, f).then((uri) => uri && setUris((u) => ({ ...u, [f.path]: uri })));
  }, [hostId, files.map((f) => f.path).join()]);
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.images}>
        {pictures.map((f, i) => (
          <Pressable
            key={f.path}
            accessibilityRole="imagebutton"
            accessibilityLabel={f.name}
            onPress={() =>
              openLightbox(
                pictures.flatMap((p) => (uris[p.path] ? [{ uri: uris[p.path]!, name: p.name }] : [])),
                i,
              )
            }
          >
            <Image
              source={uris[f.path] ? { uri: uris[f.path] } : undefined}
              style={{ width: 150, height: 150, borderRadius: 12, backgroundColor: c.code }}
              resizeMode="cover"
            />
          </Pressable>
        ))}
      </View>
      {files
        .filter((f) => !pictures.includes(f))
        .map((f) => (
          <FileCard key={f.path} source={{ hostId, runId: f.runId, path: f.path, name: f.name }} />
        ))}
    </View>
  );
}

const mediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** A presented picture, read from the run's folder with `agent/file`, as a data URL. */
async function readPicture(hostId: string, f: DocRef): Promise<string | undefined> {
  const type = mediaTypes[f.name.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png";
  // Whole 3-byte groups a slice, so the slices' base64 joins into the whole's, and no more than
  // the desktop's 256 KiB `pieceBytes`, so a slice arrives within the heartbeat's 10 s on a slow link.
  const slice = 262_143;
  let data = "";
  for (let offset = 0; ; offset += slice) {
    const answer = await window.parallax.request(hostId, "agent/file", {
      runId: f.runId,
      path: f.path,
      side: "working",
      offset,
      length: slice,
    });
    if ("error" in answer) return undefined;
    const file = answer.result;
    if (!file.exists || file.content == null) return undefined;
    data += file.content;
    if (offset + slice >= (file.size ?? 0)) break;
  }
  return `data:${type};base64,${data}`;
}

/**
 * A permission request's line: waiting, its card pinned over the composer (ThreadStrips.tsx), then
 * how it was answered.
 */
function ApprovalLine({ item }: { item: Extract<Item, { kind: "approval" }> }) {
  const c = useColors();
  return (
    <TraceLine
      icon={<Icon icon={Hand} size={15} color={item.resolved ? c.mutedForeground : c.warning} />}
      title={titleOf(item, undefined, false)}
    />
  );
}

/**
 * The user's message: its images, its attached files as cards, and its text, as the Markdown the
 * composer writes, in a bubble, which a long press lifts into its menu.
 */
function UserRow({ item }: { item: Extract<Item, { kind: "user" }> }) {
  const c = useColors();
  const { hostId, runId, root, editable } = useContext(RowContext);
  const { text, paths } = splitFiles(item.text ?? "");
  const files = paths.filter((p) => !isImagePath(p));
  const said = item.text === null ? "A message" : text;
  return (
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      {!!item.images?.length && (
        <View style={[styles.images, { justifyContent: "flex-end" }]}>
          {item.images.map((id) => (
            <RunImage key={id} scope={{ hostId, runId, root }} id={id} ids={item.images!} size={96} />
          ))}
        </View>
      )}
      {files.map((p) => (
        <View key={p} style={{ width: "85%" }}>
          <FileCard source={{ hostId, path: p, name: p.split(/[/\\]/).pop() ?? p }} />
        </View>
      ))}
      {!!text.trim() && (
        <MessageMenu text={said} onEdit={editable?.key === item.key ? editable.edit : undefined}>
          <View style={[styles.bubble, { backgroundColor: c.selected }]}>
            <Markdown text={said} selectable={false} />
          </View>
        </MessageMenu>
      )}
    </View>
  );
}

function Divider({ icon, label }: { icon?: LucideIcon; label: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      {icon && <Icon icon={icon} size={13} color={c.faintForeground} />}
      <T faint style={{ fontSize: 12 }}>
        {label}
      </T>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
    </View>
  );
}

type Row = Item | Work;

/** How a secret request ended, by its status, as the desktop's SecretLine says it. */
const secretOutcomes: Record<string, string> = { saved: "Saved", declined: "Declined", cancelled: "Closed" };

/**
 * Each turn's run by its last reply's row key, for its changed files: the turns by their prompt's
 * turn id, and the first prompt's, whose row has none, by `undefined`, as the desktop's.
 */
function turnReplies(rows: readonly Row[], runs: readonly ThreadRun[]): Map<string, ThreadRun> {
  const turns = new Map<string | undefined, ThreadRun>();
  for (const r of runs) {
    if (r.status === "rolledBack") continue;
    turns.set(r.id, r);
    if (r.ordinal === 1 && !r.text) turns.set(undefined, r);
  }
  const last = new Map<string | undefined, string>();
  let turn: string | undefined;
  for (const row of rows)
    if (row.kind === "user") turn = row.turnId;
    else if (row.kind === "assistant") last.set(turn, row.key);
  const out = new Map<string, ThreadRun>();
  for (const [id, key] of last) {
    const run = turns.get(id);
    if (run) out.set(key, run);
  }
  return out;
}

function RowView({ row, live }: { row: Row; live: boolean }) {
  const c = useColors();
  const { hostId, runId, open, toggle, replies, openTrace } = useContext(RowContext);
  switch (row.kind) {
    case "work": {
      if (!row.done) return <Steps work={row} live={live} />;
      // The sheet sums up its steps, or says how long it took when it holds only messages.
      const steps = row.items.filter((i) => stepKinds.includes(i.kind));
      const took = workedFor(row.startedAt, row.endedAt);
      return <TraceLine title={took} onPress={() => openTrace(row, steps.length ? summarize(steps).label : took)} />;
    }
    case "user":
      return <UserRow item={row} />;
    case "assistant": {
      const turn = replies.get(row.key);
      return (
        <View>
          <Markdown text={row.text} onFile={(path) => void openLinked(hostId, runId, path)} />
          {turn && <TurnChanges hostId={hostId} threadId={runId} run={turn} open={open} toggle={toggle} />}
          {!row.partial && <ReplyActions text={row.text} />}
        </View>
      );
    }
    case "approval":
      return <ApprovalLine item={row} />;
    case "secret":
      // Its card is pinned over the composer while it waits.
      return (
        <TraceLine
          icon={<Icon icon={KeyRound} size={15} color={row.status ? c.mutedForeground : c.warning} />}
          title={`${row.status ? (secretOutcomes[row.status] ?? "Ended") : "Waiting for you:"} ${row.request.label}`}
        />
      );
    case "files":
      return <FilesRow files={row.files} />;
    case "notice":
      return (
        <T muted style={{ fontSize: 13.5 }}>
          {row.text}
        </T>
      );
    case "compaction":
      return <Divider icon={FoldVertical} label={row.done ? "Compacted the conversation" : "Compacting…"} />;
    case "epoch":
      return <Divider icon={RotateCcw} label="New session" />;
    case "end":
      return (
        <Divider
          label={
            row.outcome.status === "failed"
              ? `Failed: ${failureText(row.outcome.failure)}`
              : statusLabel(row.outcome.status)
          }
        />
      );
    default:
      return null;
  }
}

/** No computer's outbox: one array, since a new one each render would never settle. */
const noMessages: never[] = [];

/** The line while a turn goes: how long it has worked, ticking. */
function WorkingFor({ since }: { since?: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <WorkingMark />
      <T style={{ ...styles.trace, color: c.accent }}>Working for {duration(useSeconds(since))}</T>
    </View>
  );
}

type MenuIcon = Extract<NativeStackHeaderItemMenuAction["icon"], { type: "sfSymbol" }>;
type SFSymbol = MenuIcon["name"];

export function ThreadScreen({ route, navigation }: NativeStackScreenProps<Screens, "Thread">) {
  const { hostId, runId } = route.params;
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const computer = useComputer(hostId);
  const { drafts } = useFleet();
  const connected = !!computer?.connected;
  const { transcript, error, sent, queue, cancel, held, background, watching, runs, older, loadOlder } = useAgentRun(hostId, runId, connected);
  const [draft, setDraft] = useState(drafts.get(runId) ?? "");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // What the trace sheet last opened on, as it was then, and a count that makes each opening fresh.
  const [trace, setTrace] = useState<{ key: string; title: string; items: Item[]; start?: string; n: number }>();
  const [traceOpen, setTraceOpen] = useState(false);
  const state = computer?.view.state;
  const thread = state?.threads.find((t) => t.id === runId);
  const run = state?.runs[runId];
  const title = state?.titles[runId] ?? "Thread";
  const prs = run?.pullRequests ?? [];
  const attention = thread && state ? attentionOf(thread, run, asksOf(state, runId)) : "settled";

  // Its own notifications don't show while it's open, and it counts as seen.
  useEffect(() => {
    setViewing(runId);
    return () => setViewing(undefined);
  }, [runId]);
  const updatedAt = run?.updatedAt;
  useEffect(() => {
    if (connected && thread && updatedAt) void computer.view.update(runId, { seen: true });
  }, [connected, updatedAt, runId, !!thread]);

  const working = isRunning(transcript.run?.status) && !transcript.turnDone;

  const rename = () =>
    Alert.prompt("Rename thread", undefined, (next) => void computer?.view.update(runId, { title: next.trim() }), "plain-text", title);
  const archive = () => {
    void computer?.view.archive(runId, !thread?.archived);
    // The main view has no back stack, so an archived thread gives way to a new one.
    if (!thread?.archived) navigation.reset({ index: 0, routes: [{ name: "StartThread" }] });
  };
  const symbol = (name: SFSymbol): MenuIcon => ({ type: "sfSymbol", name });

  useLayoutEffect(() => {
    navigation.setOptions({
      // Only the glass buttons, on a bar the page's own color, as Claude's app has no title over a
      // chat. Not transparent: iOS 26 veils an inverted list under a transparent bar.
      headerTitle: "",
      headerShadowVisible: false,
      // A native menu, in sections as iOS's own apps group theirs.
      unstable_headerRightItems: () => [
        {
          type: "menu",
          label: "Thread actions",
          icon: symbol("ellipsis"),
          menu: {
            title,
            items: [
              {
                type: "submenu",
                label: "Thread",
                inline: true,
                items: [
                  {
                    type: "action",
                    label: "Thread details",
                    icon: symbol("info.circle"),
                    onPress: () => navigation.navigate("ThreadDetails", { hostId, runId }),
                  },
                  ...prs.map((url) => ({
                    type: "action" as const,
                    label: `Pull request #${url.split("/").pop()}`,
                    icon: symbol("arrow.triangle.pull"),
                    onPress: () => navigation.navigate("PullRequest", { hostId, runId, url }),
                  })),
                ],
              },
              {
                type: "submenu",
                label: "Edit",
                inline: true,
                items: [
                  { type: "action", label: "Rename", icon: symbol("pencil"), onPress: rename },
                  {
                    type: "action",
                    label: thread?.pinned ? "Unpin" : "Pin",
                    icon: symbol(thread?.pinned ? "pin.slash" : "pin"),
                    onPress: () => void computer?.view.update(runId, { pinned: !thread?.pinned }),
                  },
                  ...(run?.branch
                    ? [
                        {
                          type: "action" as const,
                          label: "Copy branch name",
                          description: run.branch,
                          icon: symbol("doc.on.doc"),
                          onPress: () => void Clipboard.setStringAsync(run.branch!),
                        },
                      ]
                    : []),
                ],
              },
              {
                type: "submenu",
                label: "End",
                inline: true,
                items: [
                  ...(working
                    ? [
                        {
                          type: "action" as const,
                          label: "Stop",
                          icon: symbol("stop.circle"),
                          destructive: true,
                          onPress: () => void cancel(),
                        },
                      ]
                    : []),
                  {
                    type: "action",
                    label: thread?.archived ? "Unarchive" : "Archive",
                    icon: symbol(thread?.archived ? "tray.and.arrow.up" : "archivebox"),
                    destructive: !thread?.archived,
                    onPress: archive,
                  },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  const outbox = computer?.outbox;
  const waiting = useSyncExternalStore(
    (listener) => outbox?.subscribe(listener) ?? (() => {}),
    () => outbox?.messages ?? noMessages,
  );
  const logged = new Set(transcript.items.map((i) => (i.kind === "user" ? i.turnId : undefined)));
  const pending = waiting.filter((m) => m.threadId === runId && !logged.has(m.id));
  const rows = groupWork(transcript.items.filter((i) => i.kind !== "session" && i.kind !== "modelSwitch"));
  const replies = useMemo(() => turnReplies(rows, runs), [transcript.items, runs]);
  // A thread started on this phone shows its prompt until the transcript has it, which plxd logs
  // with no turn id, so it's matched by there being none.
  const first = transcript.items.some((i) => i.kind === "user") ? undefined : startedPrompt(runId);
  const parent = thread && state ? parentOf(state, thread) : undefined;
  // When the current turn's prompt went, for "Working for".
  const since = transcript.items.findLast((i) => i.kind === "user")?.at;
  // Nothing in yet: no rows, no prompt from here, and no error to say instead.
  const loading =
    !!computer && rows.length === 0 && !first && pending.length === 0 && error === undefined && (transcript.seq === 0 || computer.view.loading);

  const changeDraft = (next: string) => {
    setDraft(next);
    drafts.set(runId, next);
  };

  // The latest message while the agent hasn't answered it, which Edit takes back as the desktop's
  // pencil does (AgentChat.tsx): the run is stopped and the message dropped, and its text goes back
  // in the composer.
  const stalled = error !== undefined || !connected;
  const unanswered = useMemo(
    () =>
      // Not while messages are queued: plxd's cancel drops them too, and they'd be lost.
      isRunning(transcript.run?.status) && !stalled && pending.length === 0 && queue.length === 0
        ? unansweredOf(transcript.items, sent)
        : undefined,
    [transcript, stalled, pending.length, queue.length, sent],
  );

  // The trace sheet follows its work as it grows, and keeps what it had once the work is gone.
  const traced = trace && rows.find((r) => r.key === trace.key);
  const traceItems = traced?.kind === "work" ? traced.items : (trace?.items ?? []);

  const context: RowContextValue = {
    hostId,
    runId,
    root: run?.worktreePath,
    open,
    toggle: (key) =>
      setOpen((o) => {
        const next = new Set(o);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    replies,
    openTrace: (work, title, start) => {
      void Haptics.selectionAsync();
      setTrace((t) => ({ key: work.key, title, items: work.items, start, n: (t?.n ?? 0) + 1 }));
      setTraceOpen(true);
    },
    editable: unanswered && {
      key: unanswered.key,
      edit: () =>
        void cancel(true).then((failed) =>
          failed ? Alert.alert("Couldn't stop the thread", failed) : changeDraft(unanswered.text),
        ),
    },
  };

  return (
    <RowContext value={context}>
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
        style={{ flex: 1, backgroundColor: c.background }}
      >
        {!connected && (
          <View style={[styles.banner, { top: 6, backgroundColor: c.surface, borderColor: c.border }]}>
            <Icon icon={WifiOff} size={14} color={c.mutedForeground} />
            <T muted style={{ fontSize: 13 }}>
              {computer ? `Reconnecting to ${computer.machine.name}…` : "This computer was removed."}
            </T>
          </View>
        )}
        {loading ? (
          <TranscriptSkeleton />
        ) : (
          <FlatList
            inverted
            data={[...rows].reverse()}
            keyExtractor={(i) => i.key}
            // A short transcript starts at the top, as a chat does: inverted, the end is the top.
            contentContainerStyle={styles.transcript}
            keyboardDismissMode="interactive"
            accessibilityLabel="Transcript"
            // Inverted, the end is the top: scrolling up to it loads the older page (PLX-1001).
            onEndReached={older ? loadOlder : undefined}
            onEndReachedThreshold={1}
            ListHeaderComponent={
              <View style={{ gap: 14, marginTop: 14 }}>
                {first && (
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <View style={[styles.bubble, styles.sent, { backgroundColor: c.selected }]}>
                      <Markdown text={splitFiles(first).text} selectable={false} />
                    </View>
                    <T faint style={{ fontSize: 12 }}>
                      Sending…
                    </T>
                  </View>
                )}
                {pending.map((m) => (
                  <View key={m.id} style={{ alignItems: "flex-end", gap: 4 }}>
                    <View style={[styles.bubble, styles.sent, { backgroundColor: c.selected, opacity: 0.6 }]}>
                      <Markdown text={splitFiles(m.text).text} selectable={false} />
                    </View>
                    <T faint style={{ fontSize: 12 }}>
                      {`${connected ? "Sending…" : "Waiting for connection"}${m.steer ? " · steer" : ""}`}
                    </T>
                  </View>
                ))}
                {working && <WorkingFor since={since} />}
                {!working && attention !== "settled" && attention !== "working" && (
                  <AttentionBadge attention={attention} />
                )}
                {error && (
                  <T alert style={{ fontSize: 13, color: c.danger }}>
                    {error}
                  </T>
                )}
              </View>
            }
            renderItem={({ item, index }) => (
              <View style={{ marginTop: item.kind === "user" ? 22 : 12 }}>
                <RowView row={item} live={working && index < 3} />
              </View>
            )}
          />
        )}
        {trace && (
          <TraceSheet
            key={trace.n}
            open={traceOpen}
            onClose={() => setTraceOpen(false)}
            title={trace.title}
            items={traceItems}
            start={trace.start}
            live={working && traced?.kind === "work" && !traced.done}
            scope={{ hostId, runId, root: run?.worktreePath }}
          />
        )}
        <ThreadStrips
          hostId={hostId}
          runId={runId}
          items={transcript.items}
          subagents={transcript.subagents}
          background={background}
          watching={watching}
          queue={queue}
          held={held}
          running={isRunning(transcript.run?.status)}
          stalled={stalled}
          connected={connected}
          parent={
            parent && {
              name: state?.titles[parent.id] ?? "Thread",
              open: () => navigation.reset({ index: 0, routes: [{ name: "Thread", params: { hostId, runId: parent.id } }] }),
            }
          }
        />
        <Composer
          computer={computer}
          runId={runId}
          run={run}
          working={working}
          draft={draft}
          onDraft={changeDraft}
          onStop={() => void cancel()}
          bottom={Math.max(insets.bottom, 8)}
        />
      </KeyboardAvoidingView>
    </RowContext>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    zIndex: 1,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  transcript: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 18, paddingVertical: 12 },
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
  traceIcon: { width: 16, alignItems: "center" },
  trace: { fontSize: 14, lineHeight: 20 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  // A sent message's bubble is as wide as MessageMenu lets it be; one still sending sets its own.
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  sent: { maxWidth: "85%" },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  // Under an answer, its buttons line up with its text.
  actions: { flexDirection: "row", marginTop: 4, marginLeft: -7 },
  action: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
