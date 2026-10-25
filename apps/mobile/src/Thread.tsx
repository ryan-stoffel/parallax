// One thread, on any computer, as the desktop's transcript shows it (AgentChat.tsx): the user's
// messages in bubbles with their images and files, the agent's answers, its steps as the desktop's
// trace lines (steps.ts words them; each opens to its input, images, and output, an edit to its
// diff), a finished turn folded under "Worked for …" with the files it changed, the files it
// presented, and the composer, with what waits on the user and the thread's tabs over it
// (ThreadStrips.tsx). Images open in the lightbox, and other files, as cards, in Quick Look.
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackHeaderItemMenuAction, NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import type { LucideIcon } from "lucide-react-native";
import { ChevronRight, FoldVertical, Hand, KeyRound, RotateCcw, WifiOff } from "lucide-react-native";
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
import { loadImage } from "../../desktop/src/renderer/images";
import {
  activity,
  inputText,
  stepLabel,
  summarize,
  toolKind,
} from "../../desktop/src/renderer/steps";
import { asksOf, parentOf } from "../../desktop/src/renderer/threads";
import {
  failureText,
  groupWork,
  isMedia,
  isRunning,
  statusLabel,
  subagentRuns,
  workedFor,
  type DocRef,
  type Item,
  type Work,
} from "../../desktop/src/renderer/transcript";
import { useAgentRun } from "../../desktop/src/renderer/useAgentRun";
import type { ThreadRun } from "../../desktop/src/protocol/generated/protocol";
import { Composer } from "./Composer";
import { DiffView, TurnChanges } from "./Diff";
import { counts, editRows } from "./diffLogic";
import { FileCard, openLinked } from "./FileCard";
import { useComputer, useFleet } from "./fleet";
import { openLightbox } from "./Lightbox";
import type { Screens } from "./nav";
import { DiffStats } from "./PullRequestParts";
import { setViewing } from "./push";
import { startedPrompt } from "./started";
import { font } from "./theme";
import { ThreadStrips } from "./ThreadStrips";
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
 * The thread, as the rows below need it: where it runs, which rows are open, and each turn's run
 * by the turn id of its last reply, for its changed files.
 */
interface RowContextValue {
  hostId: string;
  runId: string;
  root?: string;
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
  replies: ReadonlyMap<string, ThreadRun>;
}
const RowContext = createContext<RowContextValue>(null!);

type TraceStatus = "running" | "error" | "pending" | undefined;

/** One trace line, as the desktop's TraceLine: an icon, a title, and how it went. */
function TraceLine({
  icon,
  title,
  description,
  status,
  openKey,
  changed,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  status?: TraceStatus;
  /** The key that opens it, when it opens. */
  openKey?: string;
  /** An edit's lines added and removed. */
  changed?: { added: number; removed: number };
}) {
  const c = useColors();
  const { open, toggle } = useContext(RowContext);
  const color = status === "error" ? c.danger : c.mutedForeground;
  const line = (
    <View style={[styles.line, status === "pending" && { opacity: 0.6 }]}>
      <View style={styles.traceIcon}>{icon}</View>
      <T numberOfLines={1} style={{ ...styles.trace, color, flexShrink: 1 }}>
        {title}
      </T>
      {changed && <DiffStats additions={changed.added} deletions={changed.removed} compact />}
      {!!description && (
        <T style={{ ...styles.trace, color: status === "error" ? c.danger : c.faintForeground }}>
          {description}
        </T>
      )}
      {openKey && (
        <View style={{ transform: [{ rotate: open.has(openKey) ? "90deg" : "0deg" }] }}>
          <Icon icon={ChevronRight} size={14} color={c.faintForeground} />
        </View>
      )}
    </View>
  );
  if (!openKey) return line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open.has(openKey) }}
      onPress={() => toggle(openKey)}
      hitSlop={4}
    >
      {line}
    </Pressable>
  );
}

/** What an open line shows, indented under it behind a rule. */
function Opened({ openKey, children }: { openKey: string; children: React.ReactNode }) {
  const c = useColors();
  const { open } = useContext(RowContext);
  if (!open.has(openKey)) return null;
  return <View style={[styles.opened, { borderLeftColor: c.border }]}>{children}</View>;
}

/** A labeled block of a call's input or output, as the desktop's `Block`. */
function Block({ label, text }: { label: string; text: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 4 }}>
      <T faint style={{ fontSize: 12 }}>
        {label}
      </T>
      <View style={[styles.block, { backgroundColor: c.code, borderColor: c.border }]}>
        <T selectable style={{ fontFamily: font.mono, fontSize: 11.5, lineHeight: 17 }} numberOfLines={60}>
          {text}
        </T>
      </View>
    </View>
  );
}

/** One of a run's images (`agent/image`), as a thumbnail that opens the lightbox with its set. */
function RunImage({ id, ids, size = 120 }: { id: string; ids: string[]; size?: number }) {
  const c = useColors();
  const { hostId, runId } = useContext(RowContext);
  const [uri, setUri] = useState<string>();
  useEffect(() => void loadImage(hostId, runId, id).then(setUri), [hostId, runId, id]);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Image"
      onPress={() =>
        void Promise.all(ids.map((i) => loadImage(hostId, runId, i))).then((uris) =>
          openLightbox(
            uris.flatMap((u) => (u ? [{ uri: u }] : [])),
            Math.max(0, ids.indexOf(id)),
          ),
        )
      }
    >
      <Image
        source={uri ? { uri } : undefined}
        style={{ width: size, height: size, borderRadius: 10, backgroundColor: c.code }}
        resizeMode="cover"
      />
    </Pressable>
  );
}

/** How a call went: its line's status, and in words when it failed or never finished. */
const statuses: Record<string, { status?: TraceStatus; said?: string }> = {
  running: { status: "running" },
  ok: {},
  error: { status: "error", said: "Failed" },
  denied: { status: "error", said: "Denied" },
  none: { status: "pending", said: "No result" },
};

function ToolCall({ item, live }: { item: Extract<Item, { kind: "tool" }>; live: boolean }) {
  const c = useColors();
  const { root } = useContext(RowContext);
  const status = item.status ?? (live ? "running" : "none");
  // A status newer than this app reads as no result.
  const look = statuses[status] ?? statuses["none"]!;
  // An edit opens to its diff, as the desktop's does, in place of its input.
  const diff = useMemo(() => editRows(item.name, item.input), [item.name, item.input]);
  return (
    <View>
      <TraceLine
        icon={status === "running" ? <WorkingMark size={14} /> : <KindIcon kind={toolKind(item.name)} color={look.status === "error" ? c.danger : c.mutedForeground} />}
        title={stepLabel(item, root, status === "running")}
        description={look.said}
        status={look.status}
        openKey={item.key}
        changed={diff && counts(diff)}
      />
      <Opened openKey={item.key}>
        {diff ? <DiffView rows={diff} /> : item.input !== undefined && <Block label="Input" text={inputText(item.input)} />}
        {!!item.images?.length && (
          <View style={{ gap: 4 }}>
            <T faint style={{ fontSize: 12 }}>
              Images
            </T>
            <View style={styles.images}>
              {item.images.map((id) => (
                <RunImage key={id} id={id} ids={item.images!} />
              ))}
            </View>
          </View>
        )}
        {item.output !== undefined && <Block label="Output" text={item.output} />}
      </Opened>
    </View>
  );
}

/** A step that isn't a call: a thought, a checklist, or a notice. */
function StepRow({ item, live }: { item: Item; live: boolean }) {
  const c = useColors();
  switch (item.kind) {
    case "tool":
      return <ToolCall item={item} live={live} />;
    case "reasoning":
      return (
        <View>
          <TraceLine icon={<KindIcon kind="thinking" color={c.mutedForeground} />} title="Thought" openKey={item.key} />
          <Opened openKey={item.key}>
            <T muted style={{ fontSize: 13.5, lineHeight: 20 }}>
              {item.text.trim()}
            </T>
          </Opened>
        </View>
      );
    case "todo":
      return (
        <View>
          <TraceLine icon={<KindIcon kind="planning" color={c.mutedForeground} />} title="Updated the plan" openKey={item.key} />
          <Opened openKey={item.key}>
            {item.items.map((todo, i) => (
              <T
                key={i}
                muted
                style={{
                  fontSize: 13.5,
                  textDecorationLine: todo.status === "completed" ? "line-through" : "none",
                }}
              >
                {todo.status === "completed" ? "✓" : todo.status === "inProgress" ? "›" : "○"} {todo.text}
              </T>
            ))}
          </Opened>
        </View>
      );
    default:
      return <RowView row={item} live={live} />;
  }
}

/** A finished turn's items with each run of steps between its messages as one `Work`. */
function stepRuns(items: readonly Item[]): (Item | Work)[] {
  const out: (Item | Work)[] = [];
  let run: Item[] = [];
  const flush = () => {
    out.push(...subagentRuns(run));
    run = [];
  };
  for (const item of items)
    if (["reasoning", "tool", "todo", "notice"].includes(item.kind)) run.push(item);
    else {
      flush();
      out.push(item);
    }
  flush();
  return out;
}

/** A run of steps: one alone as its row, several as their summary, or what's under way now. */
function Steps({ work, live }: { work: Work; live: boolean }) {
  const c = useColors();
  const { root } = useContext(RowContext);
  const only = work.items.length === 1 ? work.items[0]! : undefined;
  const last = work.items.findLast((i) => i.kind !== "notice");
  const active = live && last?.kind === "tool" && last.status === undefined;
  if (only && !active) return <StepRow item={only} live={live} />;
  const now = active ? activity(last) : undefined;
  const summary = summarize(work.items);
  return (
    <View>
      {now ? (
        <TraceLine
          icon={<WorkingMark size={14} />}
          title={now.detail ? `${now.label} ${now.detail.replace(`${root}/`, "")}` : now.label}
          status="running"
          openKey={work.key}
        />
      ) : (
        <TraceLine
          icon={<KindIcon kind={summary.kind} color={summary.failures ? c.danger : c.mutedForeground} />}
          title={summary.label}
          description={summary.failures ? `${summary.failures} failed` : undefined}
          status={summary.failures ? "error" : undefined}
          openKey={work.key}
        />
      )}
      <Opened openKey={work.key}>
        {work.items.map((item) => (
          <StepRow key={item.key} item={item} live={live} />
        ))}
      </Opened>
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
    const file = answer.result as { exists: boolean; content?: string; size?: number };
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
  const { request, resolved } = item;
  const said = !resolved
    ? "Waiting for you:"
    : resolved.decision === "allowed"
      ? "Allowed"
      : resolved.decision === "denied"
        ? "Denied"
        : "Ended";
  return (
    <TraceLine
      icon={<Icon icon={Hand} size={15} color={resolved ? c.mutedForeground : c.warning} />}
      title={`${said} ${request.toolName}`}
    />
  );
}

/** The user's message: its images, its attached files as cards, and its text in a bubble. */
function UserRow({ item }: { item: Extract<Item, { kind: "user" }> }) {
  const c = useColors();
  const { hostId } = useContext(RowContext);
  const { text, paths } = splitFiles(item.text ?? "");
  const files = paths.filter((p) => !isImagePath(p));
  return (
    <View style={{ alignItems: "flex-end", gap: 6 }}>
      {!!item.images?.length && (
        <View style={[styles.images, { justifyContent: "flex-end" }]}>
          {item.images.map((id) => (
            <RunImage key={id} id={id} ids={item.images!} size={96} />
          ))}
        </View>
      )}
      {files.map((p) => (
        <View key={p} style={{ width: "85%" }}>
          <FileCard source={{ hostId, path: p, name: p.split(/[/\\]/).pop() ?? p }} />
        </View>
      ))}
      {!!text.trim() && (
        <View style={[styles.bubble, { backgroundColor: c.selected }]}>
          <T selectable style={{ fontSize: 15, lineHeight: 22 }}>
            {item.text === null ? "A message" : text}
          </T>
        </View>
      )}
    </View>
  );
}

function Divider({ icon, label }: { icon: LucideIcon; label: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      <Icon icon={icon} size={13} color={c.faintForeground} />
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
  const { hostId, runId, open, toggle, replies } = useContext(RowContext);
  switch (row.kind) {
    case "work":
      if (row.done)
        return (
          <View>
            <TraceLine
              icon={null}
              title={workedFor(row.startedAt, row.endedAt)}
              openKey={row.key}
            />
            <Opened openKey={row.key}>
              {stepRuns(row.items).map((r) =>
                r.kind === "work" ? <Steps key={r.key} work={r} live={false} /> : <RowView key={r.key} row={r} live={false} />,
              )}
            </Opened>
          </View>
        );
      return <Steps work={row} live={live} />;
    case "user":
      return <UserRow item={row} />;
    case "assistant": {
      const turn = replies.get(row.key);
      return (
        <View>
          <Markdown text={row.text} onFile={(path) => void openLinked(hostId, runId, path)} />
          {turn && <TurnChanges hostId={hostId} threadId={runId} run={turn} open={open} toggle={toggle} />}
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
        <View style={styles.line}>
          <View style={[styles.rule, { backgroundColor: c.border }]} />
          <T faint style={{ fontSize: 12 }}>
            {row.outcome.status === "failed"
              ? `Failed: ${failureText(row.outcome.failure)}`
              : statusLabel(row.outcome.status)}
          </T>
          <View style={[styles.rule, { backgroundColor: c.border }]} />
        </View>
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
  const { drafts, computers } = useFleet();
  const connected = !!computer?.connected;
  const { transcript, error, queue, cancel, held, background, watching, runs } = useAgentRun(hostId, runId, connected);
  const [draft, setDraft] = useState(drafts.get(runId) ?? "");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
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
  const symbol = (name: SFSymbol): MenuIcon => ({ type: "sfSymbol" as const, name });

  useLayoutEffect(() => {
    navigation.setOptions({
      // Only the glass buttons, over the transcript: its title is at the transcript's top.
      headerTitle: "",
      headerTransparent: true,
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
  const subtitle = [computers.length > 1 && computer?.machine.name, run?.branch].filter(Boolean).join(" · ");
  // When the current turn's prompt went, for "Working for".
  const since = transcript.items.findLast((i) => i.kind === "user")?.at;

  const edit = (next: string) => {
    setDraft(next);
    drafts.set(runId, next);
  };
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
  };

  return (
    <RowContext value={context}>
      {/* The header is transparent, so the screen starts at its top. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.background }}>
        {!connected && (
          <View style={[styles.banner, { top: headerHeight, backgroundColor: c.surface, borderColor: c.border }]}>
            <Icon icon={WifiOff} size={14} color={c.mutedForeground} />
            <T muted style={{ fontSize: 13 }}>
              {computer ? `Reconnecting to ${computer.machine.name}…` : "This computer was removed."}
            </T>
          </View>
        )}
        <FlatList
          inverted
          data={[...rows].reverse()}
          keyExtractor={(i) => i.key}
          contentContainerStyle={styles.transcript}
          keyboardDismissMode="interactive"
          accessibilityLabel="Transcript"
          // At the transcript's top, under the header's glass buttons: the thread's title, quietly.
          ListFooterComponent={
            <View style={{ paddingTop: headerHeight + 4, paddingBottom: 6, gap: 2 }}>
              <T medium numberOfLines={2} style={{ fontSize: 17, lineHeight: 23, fontWeight: "600" }}>
                {title}
              </T>
              {!!subtitle && (
                <T faint numberOfLines={1} style={{ fontSize: 13, lineHeight: 18 }}>
                  {subtitle}
                </T>
              )}
            </View>
          }
          ListHeaderComponent={
            <View style={{ gap: 14, marginTop: 14 }}>
              {first && (
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <View style={[styles.bubble, { backgroundColor: c.selected }]}>
                    <T selectable style={{ fontSize: 15, lineHeight: 22 }}>
                      {splitFiles(first).text}
                    </T>
                  </View>
                  <T faint style={{ fontSize: 12 }}>
                    Sending…
                  </T>
                </View>
              )}
              {[
                ...pending.map((m) => ({
                  id: m.id,
                  text: m.text,
                  note: `${connected ? "Sending…" : "Waiting for connection"}${m.steer ? " · steer" : ""}`,
                })),
              ].map((m) => (
                <View key={m.id} style={{ alignItems: "flex-end", gap: 4 }}>
                  <View style={[styles.bubble, { backgroundColor: c.selected, opacity: 0.6 }]}>
                    <T>{splitFiles(m.text).text}</T>
                  </View>
                  <T faint style={{ fontSize: 12 }}>
                    {m.note}
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
          stalled={error !== undefined || !connected}
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
          onDraft={edit}
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
  transcript: { paddingHorizontal: 18, paddingVertical: 12 },
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 },
  traceIcon: { width: 16, alignItems: "center" },
  trace: { fontSize: 14, lineHeight: 20 },
  opened: { marginTop: 6, marginBottom: 4, marginLeft: 7, borderLeftWidth: 1, paddingLeft: 14, gap: 8 },
  block: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bubble: { maxWidth: "85%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
});
