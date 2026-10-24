// The sidebar, as Claude's app has one: a swipe right on the main view opens it over most of the
// screen. Its top wears the nightly sky, with the Parallax mark (a new thread where the last one
// started) and search. Below are every computer's threads, as the desktop's sidebar lists a
// host's: Projects, pinned, then the rest grouped by day or by repository, each with its attention
// badge (Working, Needs you, Done, Failed), and drawers for those working, snoozed, and archived.
// The filter narrows it to one computer or repository. A swipe left archives a thread, and a long
// press pins, snoozes, renames, or archives it. Its bottom has the profile picture (Settings),
// pull requests, and New thread. The drawer keeps it mounted, so the sky never flickers in.
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
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
} from "../../desktop/src/renderer/threads";
import { Avatar } from "./Account";
import { Choices, type Choice } from "./Choices";
import { useFleet, type Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { ProjectGlyph, RepoIcon, useSharedIcons } from "./RepoIcon";
import { ago, useNav, useShow } from "./nav";
import { getPrefs } from "./prefs";
import { AttentionBadge, Icon, SkyBanner, T, useColors, Wordmark } from "./ui";

/** How much of the screen's width the sidebar takes. */
export const sidebarWidth = (screen: number) => Math.round(screen * 0.78);

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

/** A Parallax Project (0042) as the list shows it: its coordinator, threads, and attention. */
interface ProjectEntry {
  computer: Computer;
  project: Project;
  attention: Attention;
  threads: number;
  working: number;
  at: string;
}

function projectsOf(computers: Computer[]): ProjectEntry[] {
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
        working: runs.filter((r) => r.status === "running" || r.status === "starting").length,
        at: runs.reduce((latest, r) => (r.updatedAt > latest ? r.updatedAt : latest), ""),
      };
    });
  });
}

function ProjectRow({ entry, many }: { entry: ProjectEntry; many: boolean }) {
  const c = useColors();
  const show = useShow();
  const { project, computer, attention, threads, working } = entry;
  const coordinator = project.coordinator;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={project.name}
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
          <T muted numberOfLines={1} style={styles.small}>
            {[
              many && computer.machine.name,
              `${threads} thread${threads === 1 ? "" : "s"}`,
              working > 0 && `${working} working`,
              !coordinator && "Not started",
            ]
              .filter(Boolean)
              .join(" · ")}
          </T>
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
          attention: attentionOf(thread, run, asksOf(state, thread.id)),
          title: state.titles[thread.id] ?? "New thread",
          repo: source?.name,
          source,
          repoId: `${computer.machine.id}/${group}`,
        };
      });
  });
}

/** "Today", "Yesterday", "Earlier this week", or "Older", as the sidebar groups by day. */
function dayOf(at: string, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - day.getTime()) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Earlier this week" : "Older";
}

const SWIPE = 88;

/** A row a swipe left slides open on an action, as iOS Mail's are. */
function Swipe({
  label,
  icon,
  color,
  onPress,
  children,
}: {
  label: string;
  icon: LucideIcon;
  color: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const width = sidebarWidth(useWindowDimensions().width);
  const view = useRef<ScrollView>(null);
  return (
    <ScrollView
      ref={view}
      horizontal
      bounces={false}
      directionalLockEnabled
      showsHorizontalScrollIndicator={false}
      snapToOffsets={[0, SWIPE + 8]}
      decelerationRate="fast"
    >
      <View style={{ width }}>{children}</View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => {
          view.current?.scrollTo({ x: 0, animated: false });
          onPress();
        }}
        style={[styles.swipe, { backgroundColor: color }]}
      >
        <Icon icon={icon} size={20} color="#ffffff" />
        <T medium style={{ color: "#ffffff", fontSize: 13 }}>
          {label}
        </T>
      </Pressable>
    </ScrollView>
  );
}

function ThreadRow({
  entry,
  many,
  shared,
}: {
  entry: Entry;
  many: boolean;
  shared: ReadonlyMap<string, ProjectIcon>;
}) {
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

  return (
    <Swipe
      label={thread.archived ? "Unarchive" : "Archive"}
      icon={thread.archived ? Lucide.ArchiveRestore : Archive}
      color={c.projectViolet}
      onPress={() => void view.archive(thread.id, !thread.archived)}
    >
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
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
        {attention === "settled" ? (
          <T faint style={styles.small}>
            {ago(when(thread))}
          </T>
        ) : (
          <AttentionBadge attention={attention} since={attention === "working" ? thread.lastPromptAt : undefined} />
        )}
      </View>
      <View style={styles.line}>
        <RepoIcon repo={entry.source} shared={shared} size={14} />
        <T muted numberOfLines={1} style={{ ...styles.small, flex: 1 }}>
          {[many && computer.machine.name, repo ?? "No repo", run?.branch].filter(Boolean).join(" · ")}
        </T>
        {!!diff?.files && (
          <T style={styles.small}>
            <T style={{ ...styles.small, color: c.added }}>+{diff.insertions}</T>{" "}
            <T style={{ ...styles.small, color: c.danger }}>−{diff.deletions}</T>
          </T>
        )}
      </View>
    </Pressable>
    </Swipe>
  );
}

type Scope = "all" | `computer:${string}` | `repo:${string}`;
type GroupBy = "day" | "repo";
type DrawerName = "Projects" | "Working" | "Snoozed" | "Archived";

/** The sky's bar below the status bar, and its fade into the list. */
const BAR = 56;
const FADE = 28;

/**
 * The sidebar's sky across the whole screen, behind the sidebar and the main view, so the main
 * view's rounded corners show sky where they meet it, not the page.
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

  const archived = shown.filter((e) => e.thread.archived);
  const live = shown.filter((e) => !e.thread.archived);
  const isSnoozed = (e: Entry) => snoozed(e.thread, e.attention, now);
  const working = live.filter((e) => e.attention === "working");
  const snoozedList = live.filter((e) => e.attention !== "working" && isSnoozed(e));
  const rest = live.filter((e) => e.attention !== "working" && !isSnoozed(e));
  const pinned = rest.filter((e) => e.thread.pinned);
  const listed = rest.filter((e) => !e.thread.pinned);

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
  const drawer = (name: DrawerName, data: Entry[]) => ({ title: name, data: threadRows(data), drawer: true });
  type Row = { kind: "thread"; entry: Entry } | { kind: "project"; entry: ProjectEntry };
  const threadRows = (list: Entry[]): Row[] => list.map((entry) => ({ kind: "thread", entry }));
  const sections = [
    ...(projects.length && !scope.startsWith("repo:")
      ? [{ title: "Projects", data: projects.map((entry): Row => ({ kind: "project", entry })), drawer: true }]
      : []),
    ...(pinned.length ? [{ title: "Pinned", data: threadRows(pinned), drawer: false }] : []),
    ...[...groups].map(([title, data]) => ({ title, data: threadRows(data), drawer: false, repo: groupRepos.get(title) })),
    ...(working.length ? [drawer("Working", working)] : []),
    ...(snoozedList.length ? [drawer("Snoozed", snoozedList)] : []),
    ...(archived.length ? [drawer("Archived", archived)] : []),
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
  const drawerIcons: Record<string, LucideIcon> = {
    Projects: Lucide.FolderKanban,
    Snoozed: Clock,
    Archived: Archive,
  };
  // The mark starts a new thread where the last one started, as Claude's starts a new chat.
  const fresh = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    show({ name: "StartThread", params: getPrefs().lastStart });
  };
  const bar = insets.top + BAR;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ height: bar + FADE }}>
        <SkyBanner bar={bar} solid={bar} fade={FADE} />
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
          <GlassButton label="Search threads" size={40} dark onPress={() => nav.navigate("Search")}>
            <Icon icon={Search} size={18} color="#ffffff" />
          </GlassButton>
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
          <View style={styles.header}>
            <View style={styles.line}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Filter, showing ${scopeLabel}`}
                hitSlop={8}
                onPress={() => setFilter(true)}
                style={({ pressed }) => [styles.scope, pressed && { opacity: 0.6 }]}
              >
                <T medium numberOfLines={1} style={{ fontSize: 15, flexShrink: 1 }}>
                  {scopeLabel}
                </T>
                <Icon icon={ChevronDown} size={15} color={c.mutedForeground} />
              </Pressable>
              {scope !== "all" && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show all threads"
                  hitSlop={10}
                  onPress={() => setScope("all")}
                >
                  <Icon icon={Lucide.CircleX} size={15} color={c.faintForeground} />
                </Pressable>
              )}
            </View>
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
        }
        renderSectionHeader={({ section }) =>
          section.drawer ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !folded.has(section.title) }}
              onPress={() => toggle(section.title)}
              style={[styles.drawer, { borderTopColor: c.border }]}
            >
              {section.title === "Working" ? (
                <AttentionBadge attention="working" />
              ) : (
                <Icon icon={drawerIcons[section.title]!} size={14} color={c.mutedForeground} />
              )}
              {section.title !== "Working" && (
                <T muted medium style={{ fontSize: 13 }}>
                  {section.title}
                </T>
              )}
              <T faint style={{ fontSize: 13 }}>
                {section.count}
              </T>
              <View style={{ flex: 1 }} />
              <View style={{ transform: [{ rotate: folded.has(section.title) ? "0deg" : "90deg" }] }}>
                <Icon icon={ChevronRight} size={14} color={c.faintForeground} />
              </View>
            </Pressable>
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
            <ProjectRow entry={item.entry} many={many} />
          ) : (
            <ThreadRow entry={item.entry} many={many} shared={shared} />
          )
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {loading || offline.length === computers.length ? (
              <ActivityIndicator color={c.accent} />
            ) : (
              <T muted style={{ textAlign: "center" }}>
                No threads yet. Start one with New thread.
              </T>
            )}
          </View>
        }
        contentContainerStyle={{ paddingBottom: 16 }}
      />
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
  header: { gap: 8, paddingHorizontal: 20, paddingBottom: 2 },
  scope: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  section: { fontSize: 13, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 },
  drawer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 14,
    marginHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  projectIcon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: 4 },
  swipe: {
    width: SWIPE,
    marginRight: 8,
    marginVertical: 2,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
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
