// The sidebar, as Claude's app has one: a swipe right on the main view opens it over most of the
// screen. Its top wears the nightly sky, with the Parallax mark (a new thread where the last one
// started), the filter, and search. Below are every computer's threads, as the desktop's sidebar
// lists a host's: Projects, pinned, then the rest grouped by day or by repository, each with its
// status (Working, Monitoring, Waiting, Needs you, Done, Failed), and pinned under the list, as the
// desktop's, drawers for those working, snoozed, and archived. The filter narrows it to one
// computer or repository. A swipe left on a thread shows Archive, and a full one archives it; on an
// archived thread a swipe right does the same for Unarchive. A long press pins, snoozes, renames,
// or archives it. Its bottom has the profile picture (Settings), pull requests, and New thread.
// The drawer keeps it mounted, so the sky never flickers in.
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import {
  AlarmClock,
  Archive,
  ChevronDown,
  FolderGit2,
  GitPullRequest,
  ListFilter,
  Pin,
  Search,
  SquarePen,
} from "lucide-react-native";
import { useRef, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
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

import type { AgentRun, Project, ProjectIcon, Repo, Thread } from "../../desktop/src/protocol/generated/protocol";
import {
  attentionOf,
  projectAttention,
  snoozeChoices,
  snoozed,
  type Attention,
} from "../../desktop/src/renderer/attention";
import {
  asksOf,
  groupOf,
  noRepo,
  projectRuns,
  threadProjects,
  waitingOf,
} from "../../desktop/src/renderer/threads";
import { Avatar } from "./Account";
import { Choices, type Choice } from "./Choices";
import { useFleet, type Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { ProviderLogo } from "./logos";
import { ProjectGlyph, RepoIcon, useSharedIcons } from "./RepoIcon";
import { ago, useNav, useShow } from "./nav";
import { getPrefs } from "./prefs";
import { AttentionBadge, Button, DeviceIcon, Icon, SkyBanner, T, useColors, Wordmark } from "./ui";

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

export const when = (t: Thread) => t.lastPromptAt ?? t.createdAt;

/** A Parallax Project (0042) as the list shows it: its coordinator, computer, and attention. */
export interface ProjectEntry {
  computer: Computer;
  project: Project;
  attention: Attention;
  /** How many threads it has, but its coordinator, for Search. */
  threads: number;
  at: string;
}

/** Every computer's Projects, as the list and Search show them. */
export function projectsOf(computers: Computer[]): ProjectEntry[] {
  return computers.flatMap((computer) => {
    const { state } = computer.view;
    const inProject = threadProjects(state);
    return state.projects.map((project) => {
      const runs = projectRuns(state, project.id, inProject);
      return {
        computer,
        project,
        attention: projectAttention(runs, (id) => asksOf(state, id)),
        threads: runs.filter((r) => r.id !== project.coordinator).length,
        at: runs.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), ""),
      };
    });
  });
}

/** A Project's row: its icon and name, its status, and its computer with its folder there. */
function ProjectRow({ entry }: { entry: ProjectEntry }) {
  const c = useColors();
  const show = useShow();
  const { project, computer, attention } = entry;
  const coordinator = project.coordinator;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${project.name}, on ${computer.machine.name}`}
      disabled={!coordinator}
      onPress={() => coordinator && show({ name: "Thread", params: { hostId: computer.machine.id, runId: coordinator } })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hover }]}
    >
      <View style={styles.line}>
        {project.icon?.image ? (
          <View style={styles.projectIcon}>
            <ProjectGlyph icon={project.icon} size={30} />
          </View>
        ) : (
          <View style={[styles.projectIcon, { backgroundColor: c.selected }]}>
            <ProjectGlyph icon={project.icon} size={16} />
          </View>
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.line}>
            <T numberOfLines={1} style={{ flex: 1, fontWeight: attention === "needsYou" ? "600" : "500" }}>
              {project.name}
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
              {homeless(project.repoPath)}
            </T>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/** Every computer's threads, but those in a Project or forked from another. */
export function entriesOf(computers: Computer[]): Entry[] {
  return computers.flatMap((computer) => {
    const { state } = computer.view;
    const inProject = threadProjects(state);
    return state.threads
      .filter((t) => !inProject.has(t.id) && !t.parent)
      .map((thread) => {
        const run = state.runs[thread.id];
        const group = groupOf(state, thread);
        const source = group === noRepo ? undefined : state.repos.find((r) => r.id === group);
        return {
          computer,
          thread,
          run,
          attention: attentionOf(thread, run, asksOf(state, thread.id), waitingOf(state, thread.id)),
          title: state.titles[thread.id] ?? "New thread",
          repo: source?.name,
          source,
          repoId: `${computer.machine.id}/${group}`,
        };
      });
  });
}

/** Whether a thread's agent still works for it, as the desktop's Working drawer holds them. */
const busy = (a: Attention) => a === "working" || a === "monitoring" || a === "waiting";

/** "Today", "Yesterday", "Earlier this week", or "Older", as the sidebar groups by day. */
function dayOf(at: string, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - day.getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Earlier this week" : "Older";
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
function ThreadRow({ entry, shared }: { entry: Entry; shared: ReadonlyMap<string, ProjectIcon> }) {
  const c = useColors();
  const show = useShow();
  const { thread, run, computer, title, repo, attention } = entry;
  const diff = run?.diff;
  const view = computer.view;
  const unseen = attention === "done" || attention === "failed";

  function actions() {
    const list: [string, () => void][] = [
      [thread.pinned ? "Unpin" : "Pin", () => void view.update(thread.id, { pinned: !thread.pinned })],
      ...snoozeChoices().map(
        ({ label, until }): [string, () => void] => [
          `Snooze ${label.toLowerCase()}`,
          () => void view.update(thread.id, { snoozedUntil: until.toISOString() }),
        ],
      ),
      ...(unseen ? [["Mark as read", () => void view.update(thread.id, { seen: true })] as [string, () => void]] : []),
      [
        "Rename",
        () =>
          Alert.prompt("Rename thread", undefined, (next) => void view.update(thread.id, { title: next.trim() }), "plain-text", title),
      ],
      [thread.archived ? "Unarchive" : "Archive", () => void view.archive(thread.id, !thread.archived)],
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...list.map(([l]) => l), "Cancel"], cancelButtonIndex: list.length },
      (i) => list[i]?.[1](),
    );
  }

  // A run waiting out a usage limit (0049) says when it resumes, as the desktop's row does.
  const status =
    run?.status === "waiting" && attention === "settled" && !thread.archived ? (
      <View style={[styles.line, { gap: 4 }]}>
        <Icon icon={AlarmClock} size={13} color={c.warning} />
        <T medium style={{ ...styles.small, color: c.warning }}>
          {run.resumeAt ? `Resumes ${resumeTime(run.resumeAt)}` : "Waiting"}
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
      label={thread.archived ? "Unarchive" : "Archive"}
      icon={thread.archived ? Lucide.ArchiveRestore : Archive}
      color={c.projectViolet}
      start={thread.archived}
      onPress={() => void view.archive(thread.id, !thread.archived)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, on ${computer.machine.name}`}
        accessibilityActions={[{ name: "archive", label: thread.archived ? "Unarchive" : "Archive" }]}
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
            {[repo ?? "No repo", run?.branch].filter(Boolean).join(" · ")}
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
  shared: ReadonlyMap<string, ProjectIcon>;
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

  const projects = projectsOf(computers.filter((m) => scope === "all" || scope === `computer:${m.machine.id}`)).sort(
    (a, b) => b.at.localeCompare(a.at),
  );

  const groups = new Map<string, Entry[]>();
  const groupRepos = new Map<string, Repo | undefined>();
  for (const e of listed) {
    const key =
      groupBy === "repo"
        ? `${e.repo ?? "No repo"}${many ? ` · ${e.computer.machine.name}` : ""}`
        : dayOf(when(e.thread), now);
    groups.set(key, [...(groups.get(key) ?? []), e]);
    if (groupBy === "repo") groupRepos.set(key, e.source);
  }
  type Row = { kind: "thread"; entry: Entry } | { kind: "project"; entry: ProjectEntry };
  const threadRows = (list: Entry[]): Row[] => list.map((entry) => ({ kind: "thread", entry }));
  const sections = [
    ...(projects.length && !scope.startsWith("repo:")
      ? [{ title: "Projects", data: projects.map((entry): Row => ({ kind: "project", entry })), drawer: true }]
      : []),
    ...(pinned.length ? [{ title: "Pinned", data: threadRows(pinned), drawer: false }] : []),
    ...[...groups].map(([title, data]) => ({ title, data: threadRows(data), drawer: false, repo: groupRepos.get(title) })),
  ].map((s) => ({ ...s, count: s.data.length, data: folded.has(s.title) ? [] : s.data }));

  // The filter's choices: everything, a computer, or a repository, each with who needs you there.
  const needs = (list: Entry[]) => list.filter((e) => e.attention === "needsYou" && !e.thread.archived).length;
  const repos = new Map<string, { label: string; entries: Entry[] }>();
  for (const e of all.filter((x) => x.repo))
    repos.set(e.repoId, {
      label: `${e.repo}${many ? ` · ${e.computer.machine.name}` : ""}`,
      entries: [...(repos.get(e.repoId)?.entries ?? []), e],
    });
  const counted = (n: number) => (n ? `${n} need${n === 1 ? "s" : ""} you` : undefined);
  const scopes: Choice<Scope>[] = [
    { value: "all", label: "All threads", icon: ListFilter, right: counted(needs(all)) },
    ...(many
      ? computers.map(
          (m): Choice<Scope> => ({
            value: `computer:${m.machine.id}`,
            label: m.machine.name,
            section: m === computers[0] ? "Computers" : undefined,
            right: counted(needs(all.filter((e) => e.computer === m))),
          }),
        )
      : []),
    ...[...repos].map(
      ([id, r], i): Choice<Scope> => ({
        value: `repo:${id}`,
        label: r.label,
        icon: FolderGit2,
        section: i === 0 ? "Repositories" : undefined,
        right: counted(needs(r.entries)),
      }),
    ),
  ];
  const scopeLabel = scopes.find((s) => s.value === scope)?.label;

  const offline = computers.filter((m) => !m.connected);
  const loading = computers.some((m) => m.connected && m.view.loading);
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
            accessibilityLabel="New thread where you last started one"
            hitSlop={8}
            onPress={fresh}
            style={({ pressed }) => pressed && { opacity: 0.6 }}
          >
            <Wordmark size={19} color="#ffffff" />
          </Pressable>
          <View style={[styles.line, { gap: 10 }]}>
            <View>
              <GlassButton
                label={scope === "all" ? "Filter threads" : `Filter threads, showing ${scopeLabel}`}
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
            <GlassButton label="Search threads" size={40} dark onPress={() => nav.navigate("Search")}>
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
          `${r.entry.computer.machine.id}:${r.kind === "thread" ? r.entry.thread.id : r.entry.project.id}`
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
          scope !== "all" || offline.length > 0 ? (
            <View style={styles.header}>
              {scope !== "all" && (
                <View style={styles.line}>
                  <T muted numberOfLines={1} style={{ fontSize: 13, flexShrink: 1 }}>
                    Showing {scopeLabel}
                  </T>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Show all threads"
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
                    {offline.map((m) => m.machine.name).join(", ")}{" "}
                    {offline.every((m) => m.state.status === "connecting") ? "connecting…" : "offline"}
                  </T>
                </View>
              )}
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) =>
          section.drawer ? (
            <View style={{ paddingTop: 10 }}>
              <DrawerHeader
                title={section.title}
                count={section.count}
                open={!folded.has(section.title)}
                onPress={() => toggle(section.title)}
              />
            </View>
          ) : groupBy === "repo" && section.title !== "Pinned" ? (
            <View style={[styles.line, styles.section]}>
              <RepoIcon repo={"repo" in section ? section.repo : undefined} shared={shared} size={16} />
              <T muted medium style={{ fontSize: 13 }}>
                {section.title}
              </T>
            </View>
          ) : (
            <T muted medium style={styles.section}>
              {section.title}
            </T>
          )
        }
        renderItem={({ item }) =>
          item.kind === "project" ? (
            <ProjectRow entry={item.entry} />
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
                    No computers yet. Add one that runs Parallax to see its threads here.
                  </T>
                  <Button
                    label="Add computer"
                    icon={Lucide.Plus}
                    onPress={() => nav.navigate("Settings", { screen: "AddComputer", initial: false })}
                  />
                </>
              ) : loading || offline.length === computers.length ? (
                <ActivityIndicator color={c.accent} />
              ) : (
                <T muted style={{ textAlign: "center" }}>
                  No threads yet. Start one with New thread.
                </T>
              )}
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: 16 }}
      />
      {(
        [
          ["Working", working],
          ["Snoozed", snoozedList],
          ["Archived", archived],
        ] as const
      ).map(([title, entries]) => (
        <Drawer
          key={title}
          title={title}
          entries={entries}
          open={!folded.has(title)}
          onToggle={() => toggle(title)}
          shared={shared}
        />
      ))}
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          hitSlop={6}
          onPress={() => {
            void Haptics.selectionAsync();
            nav.navigate("Settings");
          }}
          style={({ pressed }) => pressed && { opacity: 0.7, transform: [{ scale: 0.94 }] }}
        >
          <Avatar size={40} />
        </Pressable>
        <GlassButton label="Pull requests" size={40} onPress={() => nav.navigate("PullRequests")}>
          <Icon icon={GitPullRequest} size={18} color={c.foreground} />
        </GlassButton>
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New thread"
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
          <T style={{ color: "#ffffff", fontSize: 16, fontWeight: "600" }}>New thread</T>
        </Pressable>
      </View>
      <Choices
        title="Filter threads"
        open={filter}
        value={[scope, `group:${groupBy}`]}
        options={[
          ...scopes,
          {
            value: "group:day",
            label: "By day",
            description: "Today, yesterday, this week, and older.",
            section: "Group",
          },
          { value: "group:repo", label: "By repository", description: "Under each repository, newest first." },
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
  projectIcon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: 4 },
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
