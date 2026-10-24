// Every computer's threads, as the desktop's sidebar lists a host's: pinned first, then the rest
// grouped by day or by repository, each with its attention badge (Working, Needs you, Done,
// Failed), and drawers for those working, snoozed, and archived. The filter narrows it to one
// computer or repository, the search bar to titles, repositories, and branches, and a long press
// pins, snoozes, renames, or archives a thread.
import type { LucideIcon } from "lucide-react-native";
import {
  Archive,
  ChevronRight,
  Clock,
  FolderGit2,
  ListFilter,
  Pin,
  SquarePen,
} from "lucide-react-native";
import { useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";

import * as Lucide from "lucide-react-native";

import type { AgentRun, Project, Thread } from "../../desktop/src/protocol/generated/protocol";
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
import { Choices, type Choice } from "./Choices";
import { useFleet, type Computer } from "./fleet";
import { ScreenTitle, SkyButton, TabScreen } from "./TabScreen";
import { ago, useNav } from "./nav";
import { AttentionBadge, DeviceIcon, Icon, T, useColors } from "./ui";

/** One thread as the list shows it. */
interface Entry {
  computer: Computer;
  thread: Thread;
  run?: AgentRun;
  attention: Attention;
  title: string;
  repo?: string;
  repoId: string;
}

const when = (t: Thread) => t.lastPromptAt ?? t.createdAt;

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

/** A Project's icon: its lucide glyph by name (`rocket` is Rocket), or a kanban board. */
function ProjectIcon({ project, color }: { project: Project; color: string }) {
  const name = (project.icon?.name ?? "").replace(/(^|-)(\w)/g, (_, __, ch: string) => ch.toUpperCase());
  const Glyph = (Lucide as unknown as Record<string, LucideIcon | undefined>)[name] ?? Lucide.FolderKanban;
  return <Icon icon={Glyph} size={16} color={color} />;
}

function ProjectRow({ entry, many }: { entry: ProjectEntry; many: boolean }) {
  const c = useColors();
  const nav = useNav();
  const { project, computer, attention, threads, working } = entry;
  const coordinator = project.coordinator;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={project.name}
      disabled={!coordinator}
      onPress={() => coordinator && nav.navigate("Thread", { hostId: computer.machine.id, runId: coordinator })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hover }]}
    >
      <View style={styles.line}>
        <View style={[styles.projectIcon, { backgroundColor: c.selected }]}>
          <ProjectIcon project={project} color={c.accent} />
        </View>
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

function entriesOf(computers: Computer[]): Entry[] {
  return computers.flatMap((computer) => {
    const { state } = computer.view;
    const inProject = threadProjects(state);
    return state.threads
      .filter((t) => !inProject.has(t.id) && !t.parent)
      .map((thread) => {
        const run = state.runs[thread.id];
        const group = groupOf(state, thread);
        return {
          computer,
          thread,
          run,
          attention: attentionOf(thread, run, asksOf(state, thread.id)),
          title: state.titles[thread.id] ?? "New thread",
          repo: group === noRepo ? undefined : state.repos.find((r) => r.id === group)?.name,
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

function ThreadRow({ entry, many }: { entry: Entry; many: boolean }) {
  const c = useColors();
  const nav = useNav();
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => nav.navigate("Thread", { hostId: computer.machine.id, runId: thread.id })}
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
        {many && <DeviceIcon name={computer.machine.name} size={12} color={c.faintForeground} />}
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
  );
}

type Scope = "all" | `computer:${string}` | `repo:${string}`;
type GroupBy = "day" | "repo";
type DrawerName = "Projects" | "Working" | "Snoozed" | "Archived";

export function ThreadList() {
  const c = useColors();
  const nav = useNav();
  const { computers } = useFleet();
  const [scope, setScope] = useState<Scope>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"scope">();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set(["Snoozed", "Archived"]));
  const [refreshing, setRefreshing] = useState(false);
  const many = computers.length > 1;

  const all = entriesOf(computers);
  const now = Date.now();
  const inScope = (e: Entry) =>
    scope === "all" ||
    scope === `computer:${e.computer.machine.id}` ||
    scope === `repo:${e.repoId}`;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (e: Entry) =>
    words.every((w) =>
      `${e.title} ${e.repo ?? ""} ${e.run?.branch ?? ""} ${e.computer.machine.name}`.toLowerCase().includes(w),
    );
  const shown = all.filter((e) => inScope(e) && matches(e)).sort((a, b) => when(b.thread).localeCompare(when(a.thread)));

  const archived = shown.filter((e) => e.thread.archived);
  const live = shown.filter((e) => !e.thread.archived);
  const isSnoozed = (e: Entry) => snoozed(e.thread, e.attention, now);
  const working = live.filter((e) => e.attention === "working");
  const snoozedList = live.filter((e) => e.attention !== "working" && isSnoozed(e));
  const rest = live.filter((e) => e.attention !== "working" && !isSnoozed(e));
  const pinned = rest.filter((e) => e.thread.pinned);
  const listed = rest.filter((e) => !e.thread.pinned);

  const projects = projectsOf(computers.filter((m) => scope === "all" || scope === `computer:${m.machine.id}`))
    .filter((p) => words.every((w) => `${p.project.name} ${p.computer.machine.name}`.toLowerCase().includes(w)))
    .sort((a, b) => b.at.localeCompare(a.at));

  const groups = new Map<string, Entry[]>();
  for (const e of listed) {
    const key =
      groupBy === "repo"
        ? `${e.repo ?? "No repo"}${many ? ` · ${e.computer.machine.name}` : ""}`
        : dayOf(when(e.thread), now);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const drawer = (name: DrawerName, data: Entry[]) => ({ title: name, data: threadRows(data), drawer: true });
  type Row = { kind: "thread"; entry: Entry } | { kind: "project"; entry: ProjectEntry };
  const threadRows = (list: Entry[]): Row[] => list.map((entry) => ({ kind: "thread", entry }));
  const sections = [
    ...(projects.length && !scope.startsWith("repo:")
      ? [{ title: "Projects", data: projects.map((entry): Row => ({ kind: "project", entry })), drawer: true }]
      : []),
    ...(pinned.length ? [{ title: "Pinned", data: threadRows(pinned), drawer: false }] : []),
    ...[...groups].map(([title, data]) => ({ title, data: threadRows(data), drawer: false })),
    ...(working.length ? [drawer("Working", working)] : []),
    ...(snoozedList.length ? [drawer("Snoozed", snoozedList)] : []),
    ...(archived.length ? [drawer("Archived", archived)] : []),
  ].map((s) => ({ ...s, count: s.data.length, data: folded.has(s.title) && !words.length ? [] : s.data }));

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

  return (
    <TabScreen
      search={{ value: query, onChange: setQuery, placeholder: "Search threads" }}
      actions={
        <>
          <SkyButton
            icon={ListFilter}
            label={`Filter, showing ${scopeLabel}`}
            marked={scope !== "all"}
            onPress={() => setFilter("scope")}
          />
          <SkyButton icon={SquarePen} label="New thread" onPress={() => nav.navigate("NewThread")} />
        </>
      }
    >
      <SectionList
        style={{ backgroundColor: "transparent" }}
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
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
          <>
            <ScreenTitle>Threads</ScreenTitle>
            {(scope !== "all" || offline.length > 0) && (
            <View style={styles.header}>
              {scope !== "all" && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Showing ${scopeLabel}. Show all threads`}
                  onPress={() => setScope("all")}
                  style={[styles.chip, { backgroundColor: c.selected }]}
                >
                  <Icon icon={ListFilter} size={13} color={c.foreground} />
                  <T medium numberOfLines={1} style={{ fontSize: 13, flexShrink: 1 }}>
                    {scopeLabel}
                  </T>
                  <Icon icon={Lucide.X} size={13} color={c.mutedForeground} />
                </Pressable>
              )}
              {offline.length > 0 && (
                <View style={styles.offline}>
                  <Icon icon={Lucide.WifiOff} size={13} color={c.faintForeground} />
                  <T faint numberOfLines={1} style={{ fontSize: 13 }}>
                    {offline.map((m) => m.machine.name).join(", ")}{" "}
                    {offline.every((m) => m.state.status === "connecting") ? "connecting…" : "offline"}
                  </T>
                </View>
              )}
            </View>
            )}
          </>
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
            <ThreadRow entry={item.entry} many={many} />
          )
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {loading || offline.length === computers.length ? (
              <ActivityIndicator color={c.accent} />
            ) : (
              <T muted style={{ textAlign: "center" }}>
                {query ? "Nothing matches." : "No threads yet. Start one with the compose button."}
              </T>
            )}
          </View>
        }
        contentContainerStyle={{ paddingBottom: 120 }}
      />
      <Choices
        title="Filter threads"
        open={filter === "scope"}
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
        onClose={() => setFilter(undefined)}
      />
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  header: { gap: 8, paddingHorizontal: 20, paddingTop: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: "100%",
  },
  offline: { flexDirection: "row", alignItems: "center", gap: 6 },
  filterDot: { position: "absolute", top: -2, right: -3, width: 7, height: 7, borderRadius: 4 },
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
  row: { marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, gap: 3 },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  small: { fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", gap: 12, paddingTop: 80, paddingHorizontal: 40 },
});
