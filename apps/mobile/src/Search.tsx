// Search every thread and orchestrator on every computer, as a sheet up to just below the notch: a
// glass field at the top, focused once the sheet is up, then the recent threads; with a query, the
// Orchestrators, threads, and archived threads whose name, repository, branch, or computer has
// every word, each match highlighted. A result becomes the main view, which closes the sheet and
// the sidebar. An orchestrator with no run asks for its first message and starts first.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { t } from "i18next";
import { History, MessagesSquare, Search as SearchIcon, X, type LucideIcon } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";

import { useFleet } from "./fleet";
import { Glass } from "./Glass";
import { ago, useShow, type Screens } from "./nav";
import { OrchestratorGlyph, RepoIcon, useSharedIcons } from "./RepoIcon";
import { agentsLine, canOrchestrate } from "./orchestratorLogic";
import { marks, matchesAll, wordsOf } from "./searchText";
import { entriesOf, orchestratorsOf, useStartOrchestrator, when, type Entry, type ProjectEntry } from "./Sidebar";
import { AttentionBadge, Empty, Icon, T, useColors } from "./ui";

const RECENT = 8;

type Result = { kind: "thread"; entry: Entry } | { kind: "orchestrator"; entry: ProjectEntry };

/** What a thread matches on, and its line under the title. */
const placeOf = (e: Entry, many: boolean) =>
  [e.repo ?? t("No repo"), e.run?.branch, many && e.computer.machine.name].filter(Boolean).join(" · ");

export function SearchScreen({ navigation }: NativeStackScreenProps<Screens, "Search">) {
  const c = useColors();
  const show = useShow();
  const { computers } = useFleet();
  const shared = useSharedIcons();
  const { ask, starting } = useStartOrchestrator();
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
            title: t("Orchestrators"),
            data: orchestratorsOf(computers)
              .filter((p) => matchesAll(`${p.orchestrator.name} ${p.computer.machine.name}`, words))
              .map((entry): Result => ({ kind: "orchestrator", entry })),
          },
          { title: t("Threads"), data: asThreads(threads.filter((e) => !e.thread.archived && found(e))) },
          { title: t("Archived"), data: asThreads(threads.filter((e) => e.thread.archived && found(e))) },
        ]
      : [{ title: t("Recent"), data: asThreads(threads.filter((e) => !e.thread.archived).slice(0, RECENT)) }]
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
            accessibilityLabel={t("Search threads")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("Search threads and orchestrators")}
            placeholderTextColor={c.faintForeground}
            selectionColor={c.accent}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
            style={[styles.input, { color: c.foreground }]}
          />
          {!!query && (
            <Pressable accessibilityRole="button" accessibilityLabel={t("Clear search")} hitSlop={10} onPress={() => setQuery("")}>
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
          `${r.kind}:${r.entry.computer.machine.id}:${r.kind === "thread" ? r.entry.thread.id : r.entry.orchestrator.id}`
        }
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: 16 }}
        renderSectionHeader={({ section }) => (
          <View style={styles.heading}>
            {!words.length && <Icon icon={History} size={13} color={c.mutedForeground} />}
            <T muted medium style={{ fontSize: 13 }}>
              {section.title}
            </T>
          </View>
        )}
        renderItem={({ item }) => {
          if (item.kind === "orchestrator") {
            const { orchestrator, computer, children } = item.entry;
            const orchestratorRun = orchestrator.run;
            const unstarted = !orchestratorRun && (starting === orchestrator.id ? t("Starting…") : t("Not started"));
            return (
              <ResultRow
                icon={<OrchestratorGlyph icon={orchestrator.icon} size={orchestrator.icon?.image ? 36 : 18} />}
                title={orchestrator.name}
                detail={[agentsLine(children), computer.machine.name, unstarted].filter(Boolean).join(" · ")}
                words={words}
                right={<AttentionBadge attention={item.entry.attention} />}
                onPress={
                  orchestratorRun
                    ? () => open(computer.machine.id, orchestratorRun)
                    : canOrchestrate(computer) && !starting
                      ? () => ask(item.entry)
                      : undefined
                }
              />
            );
          }
          const e = item.entry;
          return (
            <ResultRow
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
            <Empty
              icon={SearchIcon}
              title={t("No results for “{{query}}”", { query: query.trim() })}
              note={t("Search by a thread's title, repository, branch, or computer.")}
            />
          ) : (
            <Empty icon={MessagesSquare} title={t("No threads yet")} note={t("Threads you start show up here.")} />
          )
        }
      />
    </>
  );
}

/** One result: its icon, its title and line under it with the query's words highlighted, and its state. */
function ResultRow({
  icon,
  title,
  detail,
  words,
  right,
  onPress,
}: {
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
      accessibilityLabel={title}
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
});
