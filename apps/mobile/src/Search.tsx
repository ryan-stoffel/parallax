// Search every thread and Project on every computer, as a sheet up to just below the notch: a glass
// field at the top, focused once the sheet is up, then the recent threads; with a query, the
// Projects, threads, and archived threads whose name, repository, branch, or computer has every
// word, each match highlighted. A result becomes the main view, which closes the sheet and the
// sidebar.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { History, MessagesSquare, Search as SearchIcon, X, type LucideIcon } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";

import { useFleet } from "./fleet";
import { Glass } from "./Glass";
import { ago, useShow, type Screens } from "./nav";
import { ProjectGlyph, RepoIcon, useSharedIcons } from "./RepoIcon";
import { marks, matchesAll, wordsOf } from "./searchText";
import { entriesOf, projectsOf, when, type Entry, type ProjectEntry } from "./Sidebar";
import { AttentionBadge, Icon, T, useColors } from "./ui";

const RECENT = 8;

type Result = { kind: "thread"; entry: Entry } | { kind: "project"; entry: ProjectEntry };

/** What a thread matches on, and its line under the title. */
const placeOf = (e: Entry, many: boolean) =>
  [e.repo ?? "No repo", e.run?.branch, many && e.computer.machine.name].filter(Boolean).join(" · ");

export function SearchScreen({ navigation }: NativeStackScreenProps<Screens, "Search">) {
  const c = useColors();
  const show = useShow();
  const { computers } = useFleet();
  const shared = useSharedIcons();
  const input = useRef<TextInput>(null);
  const [query, setQuery] = useState("");
  const words = wordsOf(query);
  const many = computers.length > 1;

  // Focused once the sheet is up: focusing while it rises can leave the keyboard down.
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (e) => {
        if (!e.data.closing) input.current?.focus();
      }),
    [navigation],
  );

  const threads = entriesOf(computers).sort((a, b) => when(b.thread).localeCompare(when(a.thread)));
  const found = (e: Entry) => matchesAll(`${e.title} ${placeOf(e, true)}`, words);
  const asThreads = (list: Entry[]): Result[] => list.map((entry) => ({ kind: "thread", entry }));
  const sections = (
    words.length
      ? [
          {
            title: "Projects",
            data: projectsOf(computers)
              .filter((p) => matchesAll(`${p.project.name} ${p.computer.machine.name}`, words))
              .map((entry): Result => ({ kind: "project", entry })),
          },
          { title: "Threads", data: asThreads(threads.filter((e) => !e.thread.archived && found(e))) },
          { title: "Archived", data: asThreads(threads.filter((e) => e.thread.archived && found(e))) },
        ]
      : [{ title: "Recent", data: asThreads(threads.filter((e) => !e.thread.archived).slice(0, RECENT)) }]
  ).filter((s) => s.data.length);

  const open = (hostId: string, runId: string) => {
    Keyboard.dismiss();
    show({ name: "Thread", params: { hostId, runId } });
  };

  // A form sheet sizes only a scroll view that follows one header view, so these two are the
  // screen's only children.
  return (
    <>
      <View collapsable={false} style={styles.top}>
        <Glass style={styles.field}>
          <Icon icon={SearchIcon} size={18} color={c.mutedForeground} />
          <TextInput
            ref={input}
            accessibilityLabel="Search threads"
            value={query}
            onChangeText={setQuery}
            placeholder="Search threads and Projects"
            placeholderTextColor={c.faintForeground}
            selectionColor={c.accent}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
            style={[styles.input, { color: c.foreground }]}
          />
          {!!query && (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} onPress={() => setQuery("")}>
              <View style={[styles.clear, { backgroundColor: c.faintForeground }]}>
                <Icon icon={X} size={11} strokeWidth={3} color={c.background} />
              </View>
            </Pressable>
          )}
        </Glass>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(r) =>
          `${r.kind}:${r.entry.computer.machine.id}:${r.kind === "thread" ? r.entry.thread.id : r.entry.project.id}`
        }
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 16 }}
        renderSectionHeader={({ section }) => (
          <View style={styles.heading}>
            {section.title === "Recent" && <Icon icon={History} size={13} color={c.mutedForeground} />}
            <T muted medium style={{ fontSize: 13 }}>
              {section.title}
            </T>
          </View>
        )}
        renderItem={({ item }) => {
          if (item.kind === "project") {
            const { project, computer, threads: count } = item.entry;
            const coordinator = project.coordinator;
            return (
              <ResultRow
                label={project.name}
                icon={<ProjectGlyph icon={project.icon} size={project.icon?.image ? 36 : 18} />}
                title={project.name}
                detail={[`${count} thread${count === 1 ? "" : "s"}`, computer.machine.name, !coordinator && "Not started"]
                  .filter(Boolean)
                  .join(" · ")}
                words={words}
                right={<AttentionBadge attention={item.entry.attention} />}
                onPress={coordinator ? () => open(computer.machine.id, coordinator) : undefined}
              />
            );
          }
          const e = item.entry;
          return (
            <ResultRow
              label={e.title}
              icon={<RepoIcon repo={e.source} shared={shared} size={18} />}
              title={e.title}
              detail={placeOf(e, many || words.length > 0)}
              words={words}
              right={
                e.attention === "settled" ? (
                  <T faint style={styles.small}>
                    {ago(when(e.thread))}
                  </T>
                ) : (
                  <AttentionBadge attention={e.attention} />
                )
              }
              onPress={() => open(e.computer.machine.id, e.thread.id)}
            />
          );
        }}
        ListEmptyComponent={
          words.length ? (
            <Empty icon={SearchIcon} title={`No results for “${query.trim()}”`}>
              Search by a thread's title, repository, branch, or computer.
            </Empty>
          ) : (
            <Empty icon={MessagesSquare} title="No threads yet">
              Threads you start show up here.
            </Empty>
          )
        }
      />
    </>
  );
}

/** One result: its icon, its title and line under it with the query's words highlighted, and its state. */
function ResultRow({
  label,
  icon,
  title,
  detail,
  words,
  right,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  title: string;
  detail: string;
  words: string[];
  right: ReactNode;
  onPress?: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hover }]}
    >
      <View style={[styles.icon, { backgroundColor: c.selected }]}>{icon}</View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.line}>
          <Marked text={title} words={words} style={{ flex: 1, fontWeight: "500" }} />
          {right}
        </View>
        <Marked muted text={detail} words={words} style={styles.small} />
      </View>
    </Pressable>
  );
}

/** One line of text with the query's words in the accent color. */
function Marked({ text, words, muted, style }: { text: string; words: string[]; muted?: boolean; style?: object }) {
  const c = useColors();
  return (
    <T muted={muted} numberOfLines={1} style={style}>
      {marks(text, words).map((m, i) =>
        m.hit ? (
          <Text key={i} style={{ color: c.accent, fontWeight: "600" }}>
            {m.text}
          </Text>
        ) : (
          m.text
        ),
      )}
    </T>
  );
}

/** What the list shows with nothing in it. */
function Empty({ icon, title, children }: { icon: LucideIcon; title: string; children: string }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: c.selected }]}>
        <Icon icon={icon} size={22} color={c.mutedForeground} />
      </View>
      <T medium style={{ fontSize: 16, textAlign: "center" }}>
        {title}
      </T>
      <T muted style={{ fontSize: 14, textAlign: "center" }}>
        {children}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  // Padding, not margins: the sheet sizes the list by this view's frame.
  top: { paddingTop: 22, paddingBottom: 6, paddingHorizontal: 16 },
  field: { height: 46, borderRadius: 23, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14 },
  input: { flex: 1, fontSize: 17, paddingVertical: 0, height: "100%" },
  clear: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  heading: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  icon: { width: 36, height: 36, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  small: { fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", gap: 8, paddingTop: 72, paddingHorizontal: 40 },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", marginBottom: 4 },
});
