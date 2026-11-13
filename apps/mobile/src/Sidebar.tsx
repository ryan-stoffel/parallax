// The sidebar, as Claude's app has one: a swipe right on the main view opens it over most of the
// screen. Its top wears the nightly sky, with the Parallax mark (a new thread where the last one
// started), Projects, the filter, and search. Below are every computer's threads, as the desktop's
// sidebar lists a host's: orchestrators, pinned, then the rest grouped by day or by repository, each
// with its status (Working, Monitoring, Waiting, Needs you, Done, Failed), and pinned under the
// list, as the desktop's, drawers for those working, snoozed, and archived. The filter narrows it to
// one computer or repository. A swipe left on a thread shows Archive, and a full one archives it; on
// an archived thread a swipe right does the same for Unarchive. A long press pins, snoozes, renames,
// changes the Project of, or archives it. Its bottom has the profile picture (Settings), pull
// requests, and New thread. The drawer keeps it mounted, so the sky never flickers in.
import * as Haptics from "expo-haptics";
import { t } from "i18next";
import type { LucideIcon } from "lucide-react-native";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Folder,
  FolderGit2,
  GitPullRequest,
  ListFilter,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
} from "lucide-react-native";
import { useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Lucide from "lucide-react-native";

import { msg } from "../../desktop/src/i18n";
import type { AgentRun, Orchestrator, ChosenIcon, Repo, Thread } from "../../desktop/src/protocol/generated/protocol";
import {
  attentionOf,
  orchestratorAttention,
  snoozeChoices,
  snoozed,
  type Attention,
} from "../../desktop/src/renderer/attention";
import {
  asksOf,
  groupOf,
  noRepo,
  orchestratorRuns,
  threadOrchestrators,
  waitingOf,
} from "../../desktop/src/renderer/threads";
import { uuidv7 } from "../../desktop/src/renderer/uuidv7";
import { Avatar } from "./Account";
import { Choices, type Choice } from "./Choices";
import { showAlert, showMenu, showPrompt } from "./dialogStore";
import { useFleet, type Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { ProviderLogo } from "./logos";
import { setStarted } from "./started";
import { OrchestratorGlyph, RepoIcon, useSharedIcons } from "./RepoIcon";
import { ago, useNav, useShow } from "./nav";
import {
  agentsLine,
  canOrchestrate,
  orchestratorChildren,
  startOrchestrator,
  type OrchestratorChild,
} from "./orchestratorLogic";
import { getPrefs } from "./prefs";
import { threadProject } from "./Projects";
import { AttentionBadge, Button, DeviceIcon, Empty, Icon, SkyBanner, T, useColors, Wordmark } from "./ui";

/** How much of the screen's width the sidebar takes. */
export const sidebarWidth = (screen: number) => Math.round(screen * 0.78);

/** `path` with the home folder as `~`. */
export const homeless = (path: string) =>
  path
    .replace(/^\\\\\?\\/, "")
    .replace(/^(\/Users|\/home)\/[^/]+/, "~")
    .replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");

/** One thread as the list shows it. */
export interface Entry {
  computer: Computer;
  thread: Thread;
  run?: AgentRun;
  attention: Attention;
  title: string;
  repo?: string;
  /** Its repository, for the icon. */
  source?: Repo;
  repoId: string;
}

export const when = (thread: Thread) => thread.lastPromptAt ?? thread.createdAt;

/** A Parallax orchestrator (0042) as the list shows it: its orchestrator, computer, and attention. */
export interface ProjectEntry {
  computer: Computer;
  orchestrator: Orchestrator;
  attention: Attention;
  /** Its child threads, most urgent first. */
  children: OrchestratorChild[];
  at: string;
}

/** Every computer's orchestrators, as the list and Search show them. */
export function orchestratorsOf(computers: Computer[]): ProjectEntry[] {
  return computers.flatMap((computer) => {
    const { state } = computer.view;
    const inOrchestrator = threadOrchestrators(state);
    return state.orchestrators.map((orchestrator) => {
      const runs = orchestratorRuns(state, orchestrator.id, inOrchestrator);
      return {
        computer,
        orchestrator,
        attention: orchestratorAttention(runs, (id) => asksOf(state, id)),
        children: orchestratorChildren(state, orchestrator, inOrchestrator),
        at: runs.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), ""),
      };
    });
  });
}

/**
 * Starting an orchestrator with no run: `ask` asks for its first message, which plxd needs, starts
 * it, and makes its chat the main view. `starting` is the orchestrator on its way.
 */
export function useStartOrchestrator() {
  const show = useShow();
  const [starting, setStarting] = useState<string>();
  const ask = ({ computer, orchestrator }: ProjectEntry) =>
    showPrompt(t("Start {{name}}", { name: orchestrator.name }), t("What should it work on?"), (text) => {
      const prompt = text.trim();
      if (!prompt) return;
      const runId = uuidv7();
      setStarting(orchestrator.id);
      void startOrchestrator(computer.view, orchestrator.id, runId, prompt).then((failed) => {
        setStarting(undefined);
        if (failed) return showAlert(t("Couldn't start {{name}}", { name: orchestrator.name }), failed);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Keyboard.dismiss();
        setStarted(runId, prompt);
        show({ name: "Thread", params: { hostId: computer.machine.id, runId } });
      });
    });
  return { ask, starting };
}

/**
 * An orchestrator's row: its icon and name, its status, and its computer with its children's count,
 * or its folder with none. It opens its chat, or with no run starts it where its computer can. Its
 * chevron unfolds its children, each with its status, opening its own chat.
 */
function OrchestratorRow({ entry }: { entry: ProjectEntry }) {
  const c = useColors();
  const show = useShow();
  const { ask, starting } = useStartOrchestrator();
  const [open, setOpen] = useState(false);
  const { orchestrator, computer, attention, children } = entry;
  const hostId = computer.machine.id;
  const orchestratorRun = orchestrator.run;
  const startable = !orchestratorRun && canOrchestrate(computer) && !starting;
  const unstarted = !orchestratorRun && (starting ? t("Starting…") : t("Not started"));
  return (
    <View>
      <View style={styles.orchestrator}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            startable
              ? t("Start {{name}}, on {{computer}}", { name: orchestrator.name, computer: computer.machine.name })
              : t("{{name}}, on {{computer}}", { name: orchestrator.name, computer: computer.machine.name })
          }
          disabled={!orchestratorRun && !startable}
          onPress={() =>
            orchestratorRun ? show({ name: "Thread", params: { hostId, runId: orchestratorRun } }) : ask(entry)
          }
          style={({ pressed }) => [styles.row, { flex: 1 }, pressed && { backgroundColor: c.hover }]}
        >
          <View style={styles.line}>
            {orchestrator.icon?.image ? (
              <View style={styles.orchestratorIcon}>
                <OrchestratorGlyph icon={orchestrator.icon} size={30} />
              </View>
            ) : (
              <View style={[styles.orchestratorIcon, { backgroundColor: c.selected }]}>
                <OrchestratorGlyph icon={orchestrator.icon} size={16} />
              </View>
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.line}>
                <T numberOfLines={1} style={{ flex: 1, fontWeight: attention === "needsYou" ? "600" : "500" }}>
                  {orchestrator.name}
                </T>
                {attention === "settled" ? (
                  !!entry.at && (
                    <T faint style={styles.small}>
                      {ago(entry.at)}
                    </T>
                  )
                ) : (
                  <AttentionBadge attention={attention} />
                )}
              </View>
              <View style={styles.line}>
                <DeviceIcon name={computer.machine.name} size={13} color={c.faintForeground} />
                <T faint numberOfLines={1} ellipsizeMode="head" style={{ ...styles.small, flex: 1 }}>
                  {[unstarted, agentsLine(children)].filter(Boolean).join(" · ") || orchestrator.repoPath.split(/[\\/]/).pop()}
                </T>
              </View>
            </View>
          </View>
        </Pressable>
        {children.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("{{name}}'s threads, {{count}}", { name: orchestrator.name, count: children.length })}
            accessibilityState={{ expanded: open }}
            hitSlop={6}
            onPress={() => setOpen(!open)}
            style={({ pressed }) => [styles.fold, pressed && { opacity: 0.6 }]}
          >
            <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
              <Icon icon={ChevronDown} size={16} color={c.faintForeground} />
            </View>
          </Pressable>
        )}
      </View>
      {open &&
        children.map(({ run, title, attention: status }) => (
          <Pressable
            key={run.id}
            accessibilityRole="button"
            onPress={() => show({ name: "Thread", params: { hostId, runId: run.id } })}
            style={({ pressed }) => [styles.child, pressed && { backgroundColor: c.hover }]}
          >
            <T numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>
              {title}
            </T>
            <AttentionBadge attention={status} />
          </Pressable>
        ))}
    </View>
  );
}

/** Every computer's threads, but those in an orchestrator or forked from another. */
export function entriesOf(computers: Computer[]): Entry[] {
  return computers.flatMap((computer) => {
    const { state } = computer.view;
    const inOrchestrator = threadOrchestrators(state);
    return state.threads
      .filter((t) => !inOrchestrator.has(t.id) && !t.parent)
      .map((thread) => {
        const run = state.runs[thread.id];
        const group = groupOf(state, thread);
        const source = group === noRepo ? undefined : state.repos.find((r) => r.id === group);
        return {
          computer,
          thread,
          run,
          attention: attentionOf(thread, run, asksOf(state, thread.id), waitingOf(state, thread.id)),
          title: state.titles[thread.id] ?? t("New thread"),
          repo: source?.name,
          source,
          repoId: `${computer.machine.id}/${group}`,
        };
      });
  });
}

/** Whether a thread's agent still works for it, as the desktop's Working drawer holds them. */
const busy = (a: Attention) => a === "working" || a === "monitoring" || a === "waiting";

/** "Today", "Yesterday", "Earlier this week", or "Older", as the sidebar groups by day. Shown with `t`. */
function dayOf(at: string, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - day.getTime()) / 864e5);
  return days <= 0 ? msg("Today") : days === 1 ? msg("Yesterday") : days < 7 ? msg("Earlier this week") : msg("Older");
}

/** When a run waiting out a usage limit resumes: a time today, or a day and time after. */
function resumeTime(iso: string) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

const SWIPE = 88;
/** How much of the row a full swipe uncovers before letting go acts. */
const FULL = 0.55;
/** Mirrors a view, so a swipe right reads as a swipe left. */
const mirrored = { transform: [{ scaleX: -1 }] };

/**
 * A row a swipe slides open on an action, as iOS Mail's are: a short swipe shows the action to
 * tap, and a full one, past a haptic tick, does it when let go. The action is at the row's end,
 * for a swipe left, or with `start`, at its start, for a swipe right. The sidebar open, the
 * drawer's own swipe only takes the main view's strip (App.tsx), so the two never compete.
 *
 * Both rest at offset 0: a swipe right's scroll view is mirrored, and its contents mirrored back,
 * as a horizontal FlatList's `inverted` is. A resting offset past 0, set with `contentOffset`,
 * only holds until iOS lays the scroll view out again, which showed the action on reopening.
 */
function Swipe({
  label,
  icon,
  color,
  start,
  onPress,
  children,
}: {
  label: string;
  icon: LucideIcon;
  color: string;
  start?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const width = sidebarWidth(useWindowDimensions().width);
  const view = useRef<ScrollView>(null);
  const dragging = useRef(false);
  const armed = useRef(false);
  const flip = start ? mirrored : undefined;
  const act = () => {
    view.current?.scrollTo({ x: 0, animated: false });
    onPress();
  };
  return (
    <ScrollView
      ref={view}
      horizontal
      style={flip}
      bounces={false}
      directionalLockEnabled
      showsHorizontalScrollIndicator={false}
      snapToOffsets={[0, SWIPE + 8]}
      snapToStart={false}
      snapToEnd={false}
      decelerationRate="fast"
      scrollEventThrottle={16}
      onScrollBeginDrag={() => {
        dragging.current = true;
      }}
      onScroll={(e) => {
        if (!dragging.current) return;
        const past = e.nativeEvent.contentOffset.x > width * FULL;
        if (past === armed.current) return;
        armed.current = past;
        void Haptics.impactAsync(past ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
      }}
      onScrollEndDrag={() => {
        dragging.current = false;
        if (!armed.current) return;
        armed.current = false;
        act();
      }}
    >
      <View style={[{ width }, flip]}>{children}</View>
      <View
        style={[styles.swipe, { width, backgroundColor: color, alignItems: start ? "flex-end" : "flex-start" }, flip]}
      >
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={act} style={styles.swipeButton}>
          <Icon icon={icon} size={20} color="#ffffff" />
          <T medium style={{ color: "#ffffff", fontSize: 13 }}>
            {label}
          </T>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * A thread's row, as the desktop's: its title and status, then quietly its repository and branch,
 * its lines changed, its computer's icon, and its provider's mark.
 */
function ThreadRow({ entry, shared }: { entry: Entry; shared: ReadonlyMap<string, ChosenIcon> }) {
  const c = useColors();
  const show = useShow();
  const { computers } = useFleet();
  const { thread, run, computer, title, repo, attention } = entry;
  const diff = run?.diff;
  const view = computer.view;
  const unseen = attention === "done" || attention === "failed";
  const asleep = !thread.archived && snoozed(thread, attention);

  function actions() {
    const project = threadProject(thread, view, computers);
    showMenu(
      [
        { label: thread.pinned ? t("Unpin") : t("Pin"), icon: thread.pinned ? PinOff : Pin, onPress: () => void view.update(thread.id, { pinned: !thread.pinned }) },
        ...snoozeChoices().map(({ snooze, until }) => ({
          label: snooze,
          icon: AlarmClock,
          onPress: () => void view.update(thread.id, { snoozedUntil: until.toISOString() }),
        })),
        // Waking now ends the snooze, as the desktop's undo does.
        ...(asleep
          ? [{ label: t("Unsnooze"), icon: AlarmClockOff, onPress: () => void view.update(thread.id, { snoozedUntil: new Date().toISOString() }) }]
          : []),
        ...(unseen ? [{ label: t("Mark as read"), icon: Check, onPress: () => void view.update(thread.id, { seen: true }) }] : []),
        {
          label: t("Rename"),
          icon: Pencil,
          onPress: () =>
            showPrompt(t("Rename thread"), undefined, (next) => void view.update(thread.id, { title: next.trim() }), "plain-text", title),
        },
        ...(project ? [{ label: project.label, icon: Folder, onPress: project.choose ?? (() => {}) }] : []),
        { label: thread.archived ? t("Unarchive") : t("Archive"), icon: thread.archived ? ArchiveRestore : Archive, onPress: () => void view.archive(thread.id, !thread.archived) },
      ],
      title,
    );
  }

  // A snoozed thread says when it wakes, and a run waiting out a usage limit (0049) when it resumes,
  // as the desktop's row does.
  const status = asleep ? (
    <View style={[styles.line, { gap: 4 }]}>
      <Icon icon={AlarmClock} size={13} color={c.warning} />
      <T medium style={{ ...styles.small, color: c.warning }}>
        {t("Wakes {{time}}", { time: resumeTime(thread.snoozedUntil!) })}
      </T>
    </View>
  ) : run?.status === "waiting" && attention === "settled" && !thread.archived ? (
    <View style={[styles.line, { gap: 4 }]}>
      <Icon icon={AlarmClock} size={13} color={c.warning} />
      <T medium style={{ ...styles.small, color: c.warning }}>
        {run.resumeAt ? t("Resumes {{time}}", { time: resumeTime(run.resumeAt) }) : t("Waiting")}
      </T>
    </View>
  ) : attention === "settled" ? (
    <T faint style={styles.small}>
      {ago(when(thread))}
    </T>
  ) : (
    <AttentionBadge attention={attention} since={attention === "working" ? (thread.lastUserPromptAt ?? thread.lastPromptAt) : undefined} />
  );

  return (
    <Swipe
      label={thread.archived ? t("Unarchive") : t("Archive")}
      icon={thread.archived ? Lucide.ArchiveRestore : Archive}
      color={c.projectViolet}
      start={thread.archived}
      onPress={() => void view.archive(thread.id, !thread.archived)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("{{title}}, on {{computer}}", { title, computer: computer.machine.name })}
        accessibilityActions={[{ name: "archive", label: thread.archived ? t("Unarchive") : t("Archive") }]}
        onAccessibilityAction={() => void view.archive(thread.id, !thread.archived)}
        onPress={() => show({ name: "Thread", params: { hostId: computer.machine.id, runId: thread.id } })}
        onLongPress={actions}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hover }]}
      >
        <View style={styles.line}>
          {thread.pinned && <Icon icon={Pin} size={12} color={c.faintForeground} />}
          <T numberOfLines={1} style={{ flex: 1, fontWeight: unseen || attention === "needsYou" ? "600" : "400" }}>
            {title}
          </T>
          {status}
        </View>
        <View style={styles.line}>
          <RepoIcon repo={entry.source} shared={shared} size={14} />
          <T faint numberOfLines={1} style={{ ...styles.small, flex: 1 }}>
            {[repo ?? t("No repo"), run?.branch].filter(Boolean).join(" · ")}
          </T>
          {!!diff?.files && (
            <T style={styles.small}>
              <T style={{ ...styles.small, color: c.added }}>+{diff.insertions}</T>{" "}
              <T style={{ ...styles.small, color: c.danger }}>−{diff.deletions}</T>
            </T>
          )}
          <DeviceIcon name={computer.machine.name} size={13} color={c.faintForeground} />
          {/* ponytail: the run's instance id picks the mark, which is its kind for the built-in
              instances; an added instance shows the bot until `providers/list` is read here. */}
          {run && <ProviderLogo kind={run.backend} size={13} color={c.faintForeground} />}
        </View>
      </Pressable>
    </Swipe>
  );
}

/** A drawer's heading, as the desktop's: its name and count, a rule, and a chevron. */
function DrawerHeader({ title, count, open, onPress }: { title: string; count: number; open: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${count}`}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={({ pressed }) => [styles.drawer, pressed && { opacity: 0.6 }]}
    >
      <T muted medium style={{ fontSize: 13 }}>
        {title} <T faint style={{ fontSize: 13 }}>({count})</T>
      </T>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
        <Icon icon={ChevronDown} size={14} color={c.faintForeground} />
      </View>
    </Pressable>
  );
}

/**
 * A drawer pinned under the list, as the desktop's Working, Snoozed, and Archived are, shown while
 * it holds any threads. Open, its rows scroll under a cap, so the list above keeps its room.
 */
function Drawer({
  title,
  entries,
  open,
  onToggle,
  shared,
}: {
  title: string;
  entries: Entry[];
  open: boolean;
  onToggle: () => void;
  shared: ReadonlyMap<string, ChosenIcon>;
}) {
  const { height } = useWindowDimensions();
  if (!entries.length) return null;
  return (
    <View>
      <DrawerHeader title={title} count={entries.length} open={open} onPress={onToggle} />
      {open && (
        <FlatList
          style={{ maxHeight: Math.round(height * 0.28) }}
          data={entries}
          keyExtractor={(e) => `${e.computer.machine.id}:${e.thread.id}`}
          renderItem={({ item }) => <ThreadRow entry={item} shared={shared} />}
        />
      )}
    </View>
  );
}

type Scope = "all" | `computer:${string}` | `repo:${string}`;
type GroupBy = "day" | "repo";

/** The sky's bar below the status bar, and its fade into the list. */
const BAR = 56;
const FADE = 28;

/**
 * The sidebar's sky and page, across the whole screen behind the sidebar and the main view: one
 * sky, so the main view's rounded corners show its sky where they meet it, not an edge.
 */
export function SidebarSky() {
  const insets = useSafeAreaInsets();
  const bar = insets.top + BAR;
  return <SkyBanner bar={bar} solid={bar} fade={FADE} />;
}

export function Sidebar() {
  const c = useColors();
  const nav = useNav();
  const show = useShow();
  const insets = useSafeAreaInsets();
  const { computers } = useFleet();
  const [scope, setScope] = useState<Scope>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [filter, setFilter] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set(["Snoozed", "Archived"]));
  const [refreshing, setRefreshing] = useState(false);
  const many = computers.length > 1;
  const shared = useSharedIcons();

  const all = entriesOf(computers);
  const now = Date.now();
  const inScope = (e: Entry) =>
    scope === "all" ||
    scope === `computer:${e.computer.machine.id}` ||
    scope === `repo:${e.repoId}`;
  const shown = all.filter(inScope).sort((a, b) => when(b.thread).localeCompare(when(a.thread)));

  // As the desktop's: pinned threads stay put, and the rest sit in Working while their agent works.
  const archived = shown.filter((e) => e.thread.archived);
  const live = shown.filter((e) => !e.thread.archived);
  const snoozedList = live.filter((e) => snoozed(e.thread, e.attention, now));
  const pool = live.filter((e) => !snoozedList.includes(e));
  const pinned = pool.filter((e) => e.thread.pinned);
  const working = pool.filter((e) => !e.thread.pinned && busy(e.attention));
  const listed = pool.filter((e) => !e.thread.pinned && !busy(e.attention));

  const orchestrators = orchestratorsOf(computers.filter((m) => scope === "all" || scope === `computer:${m.machine.id}`)).sort(
    (a, b) => b.at.localeCompare(a.at),
  );

  const groups = new Map<string, Entry[]>();
  const groupRepos = new Map<string, Repo | undefined>();
  for (const e of listed) {
    const key =
      groupBy === "repo"
        ? `${e.repo ?? t("No repo")}${many ? ` · ${e.computer.machine.name}` : ""}`
        : dayOf(when(e.thread), now);
    groups.set(key, [...(groups.get(key) ?? []), e]);
    if (groupBy === "repo") groupRepos.set(key, e.source);
  }
  type Row = { kind: "thread"; entry: Entry } | { kind: "orchestrator"; entry: ProjectEntry };
  const threadRows = (list: Entry[]): Row[] => list.map((entry) => ({ kind: "thread", entry }));
  // `title` keys a section, and `label` shows it: a day's title is its English name (`dayOf`).
  const sections = [
    ...(orchestrators.length && !scope.startsWith("repo:")
      ? [
          {
            title: "Orchestrators",
            label: t("Orchestrators"),
            data: orchestrators.map((entry): Row => ({ kind: "orchestrator", entry })),
            drawer: true,
          },
        ]
      : []),
    ...(pinned.length ? [{ title: "Pinned", label: t("Pinned"), data: threadRows(pinned), drawer: false }] : []),
    ...[...groups].map(([title, data]) => ({
      title,
      label: groupBy === "repo" ? title : t(title),
      data: threadRows(data),
      drawer: false,
      repo: groupRepos.get(title),
    })),
  ].map((s) => ({ ...s, count: s.data.length, data: folded.has(s.title) ? [] : s.data }));

  // The filter's choices: everything, a computer, or a repository, each with who needs you there.
  const needs = (list: Entry[]) => list.filter((e) => e.attention === "needsYou" && !e.thread.archived).length;
  const repos = new Map<string, { label: string; entries: Entry[] }>();
  for (const e of all.filter((x) => x.repo))
    repos.set(e.repoId, {
      label: `${e.repo}${many ? ` · ${e.computer.machine.name}` : ""}`,
      entries: [...(repos.get(e.repoId)?.entries ?? []), e],
    });
  const counted = (n: number) =>
    n ? t("{{count}} need you", { count: n, defaultValue_one: "{{count}} needs you" }) : undefined;
  const scopes: Choice<Scope>[] = [
    { value: "all", label: t("All threads"), icon: ListFilter, right: counted(needs(all)) },
    ...(many
      ? computers.map(
          (m): Choice<Scope> => ({
            value: `computer:${m.machine.id}`,
            label: m.machine.name,
            section: m === computers[0] ? t("Computers") : undefined,
            right: counted(needs(all.filter((e) => e.computer === m))),
          }),
        )
      : []),
    ...[...repos].map(
      ([id, r], i): Choice<Scope> => ({
        value: `repo:${id}`,
        label: r.label,
        icon: FolderGit2,
        section: i === 0 ? t("Repositories") : undefined,
        right: counted(needs(r.entries)),
      }),
    ),
  ];
  const scopeLabel = scopes.find((s) => s.value === scope)?.label;

  const offline = computers.filter((m) => !m.shownConnected);
  const capped = computers.flatMap((m) => m.cap ?? []);
  const loading = computers.some((m) => m.shownConnected && m.view.loading);
  const toggle = (title: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(title)) next.add(title);
      return next;
    });
  // The mark starts a new thread where the last one started, as Claude's starts a new chat.
  const fresh = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    show({ name: "StartThread", params: getPrefs().lastStart });
  };
  const bar = insets.top + BAR;

  return (
    // Clear, over `SidebarSky`: one sky across the screen, with no seam where the main view meets it.
    <View style={{ flex: 1 }}>
      <View style={{ height: bar + FADE }}>
        <View style={[styles.top, { marginTop: insets.top }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("New thread where you last started one")}
            hitSlop={8}
            onPress={fresh}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Wordmark size={19} color="#ffffff" />
          </Pressable>
          <View style={[styles.line, { gap: 10 }]}>
            <GlassButton label={t("Projects")} size={40} dark onPress={() => nav.navigate("Projects")}>
              <Icon icon={Lucide.LayoutGrid} size={18} color="#ffffff" />
            </GlassButton>
            <View>
              <GlassButton
                label={scope === "all" ? t("Filter threads") : t("Filter threads, showing {{scope}}", { scope: scopeLabel })}
                size={40}
                dark
                onPress={() => setFilter(true)}
              >
                <Icon icon={ListFilter} size={18} color="#ffffff" />
              </GlassButton>
              {scope !== "all" && (
                <View pointerEvents="none" style={[styles.filterDot, { backgroundColor: c.accent }]} />
              )}
            </View>
            <GlassButton label={t("Search threads")} size={40} dark onPress={() => nav.navigate("Search")}>
              <Icon icon={Search} size={18} color="#ffffff" />
            </GlassButton>
          </View>
        </View>
      </View>
      <SectionList
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="never"
        sections={sections}
        keyExtractor={(r) =>
          `${r.entry.computer.machine.id}:${r.kind === "thread" ? r.entry.thread.id : r.entry.orchestrator.id}`
        }
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              for (const m of computers) void window.parallax.retry(m.machine.id);
              setTimeout(() => setRefreshing(false), 800);
            }}
          />
        }
        ListHeaderComponent={
          scope !== "all" || offline.length > 0 || capped.length > 0 ? (
            <View style={styles.header}>
              {scope !== "all" && (
                <View style={styles.line}>
                  <T muted numberOfLines={1} style={{ fontSize: 13, flexShrink: 1 }}>
                    {t("Showing {{scope}}", { scope: scopeLabel })}
                  </T>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("Show all threads")}
                    hitSlop={10}
                    onPress={() => setScope("all")}
                  >
                    <Icon icon={Lucide.CircleX} size={15} color={c.faintForeground} />
                  </Pressable>
                </View>
              )}
              {offline.length > 0 && (
                <View style={styles.line}>
                  <Icon icon={Lucide.WifiOff} size={13} color={c.faintForeground} />
                  <T faint numberOfLines={1} style={{ fontSize: 13, flexShrink: 1 }}>
                    {offline.every((m) => m.state.updating)
                      ? t("{{names}} updating…", { names: offline.map((m) => m.machine.name).join(", ") })
                      : offline.every((m) => m.state.status === "connecting")
                        ? t("{{names}} connecting…", { names: offline.map((m) => m.machine.name).join(", ") })
                        : t("{{names}} offline", { names: offline.map((m) => m.machine.name).join(", ") })}
                  </T>
                </View>
              )}
              {capped.map((cap) => (
                <View key={cap.title} accessibilityRole="alert">
                  <View style={styles.line}>
                    <Icon icon={Lucide.Gauge} size={13} color={cap.reached ? c.danger : c.warning} />
                    <T numberOfLines={1} style={{ fontSize: 13, flexShrink: 1 }}>
                      {cap.title}
                    </T>
                  </View>
                  <T faint style={styles.small}>
                    {cap.body}
                  </T>
                </View>
              ))}
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) =>
          section.drawer ? (
            <View style={{ paddingTop: 10 }}>
              <DrawerHeader
                title={section.label}
                count={section.count}
                open={!folded.has(section.title)}
                onPress={() => toggle(section.title)}
              />
            </View>
          ) : groupBy === "repo" && section.title !== "Pinned" ? (
            <View style={[styles.line, styles.section]}>
              <RepoIcon repo={"repo" in section ? section.repo : undefined} shared={shared} size={16} />
              <T muted medium style={{ fontSize: 13 }}>
                {section.label}
              </T>
            </View>
          ) : (
            <T muted medium style={styles.section}>
              {section.label}
            </T>
          )
        }
        renderItem={({ item }) =>
          item.kind === "orchestrator" ? (
            <OrchestratorRow entry={item.entry} />
          ) : (
            <ThreadRow entry={item.entry} shared={shared} />
          )
        }
        ListEmptyComponent={
          // Every thread in a drawer below leaves the list empty, but not the sidebar.
          shown.length ? null : (
            <View style={styles.empty}>
              {computers.length === 0 ? (
                <>
                  <T muted style={{ textAlign: "center" }}>
                    {t("No computers yet. Add one that runs Parallax to see its threads here.")}
                  </T>
                  <Button
                    label={t("Add computer")}
                    icon={Lucide.Plus}
                    onPress={() => nav.navigate("Settings", { screen: "AddComputer", initial: false })}
                  />
                </>
              ) : loading || offline.length === computers.length ? (
                <ActivityIndicator color={c.accent} />
              ) : (
                <Empty icon={Lucide.MessagesSquare} title={t("No threads yet")} note={t("Start one with New thread.")} />
              )}
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: 16 }}
      />
      {(
        [
          [msg("Working"), working],
          [msg("Snoozed"), snoozedList],
          [msg("Archived"), archived],
        ] as const
      ).map(([title, entries]) => (
        <Drawer
          key={title}
          title={t(title)}
          entries={entries}
          open={!folded.has(title)}
          onToggle={() => toggle(title)}
          shared={shared}
        />
      ))}
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Settings")}
          hitSlop={6}
          onPress={() => {
            void Haptics.selectionAsync();
            nav.navigate("Settings");
          }}
          style={({ pressed }) => pressed && { opacity: 0.7, transform: [{ scale: 0.94 }] }}
        >
          <Avatar size={40} />
        </Pressable>
        <GlassButton label={t("Pull requests")} size={40} onPress={() => nav.navigate("PullRequests")}>
          <Icon icon={GitPullRequest} size={18} color={c.foreground} />
        </GlassButton>
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("New thread")}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            nav.navigate("NewThread");
          }}
          style={({ pressed }) => [
            styles.newThread,
            { backgroundColor: c.accent, shadowColor: c.accent },
            pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
          ]}
        >
          <Icon icon={SquarePen} size={17} color="#ffffff" />
          <T style={{ color: "#ffffff", fontSize: 16, fontWeight: "600" }}>{t("New thread")}</T>
        </Pressable>
      </View>
      <Choices
        title={t("Filter threads")}
        open={filter}
        value={[scope, `group:${groupBy}`]}
        options={[
          ...scopes,
          {
            value: "group:day",
            label: t("By day"),
            description: t("Today, yesterday, this week, and older."),
            section: t("Group"),
          },
          { value: "group:repo", label: t("By repository"), description: t("Under each repository, newest first.") },
        ]}
        onChoose={(v) => (v.startsWith("group:") ? setGroupBy(v.slice(6) as GroupBy) : setScope(v as Scope))}
        onClose={() => setFilter(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    height: BAR,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 14,
    paddingRight: 12,
  },
  filterDot: {
    position: "absolute",
    top: 1,
    right: 1,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#ffffff",
  },
  header: { gap: 8, paddingHorizontal: 20, paddingBottom: 2 },
  section: { fontSize: 13, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 },
  drawer: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 20, paddingVertical: 8 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  orchestratorIcon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: 4 },
  orchestrator: { flexDirection: "row", alignItems: "center" },
  fold: { width: 32, height: 44, marginRight: 8, alignItems: "center", justifyContent: "center" },
  // Its title lines up under the orchestrator's name.
  child: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 52, marginRight: 8, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 10 },
  swipe: { marginVertical: 2, borderRadius: 12, borderCurve: "continuous", justifyContent: "center" },
  swipeButton: { width: SWIPE + 8, flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  row: { marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, gap: 3 },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  small: { fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", gap: 12, paddingTop: 80, paddingHorizontal: 32 },
  bottom: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 10 },
  newThread: {
    height: 44,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
});
