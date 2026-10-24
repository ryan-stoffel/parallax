// Search every thread on every computer, as a sheet up to just below the notch: before any typing,
// the recent threads; then each thread whose title, repository, branch, or computer matches every
// word. A result opens as the main view.
import { Search as SearchIcon, X } from "lucide-react-native";
import { useState } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";

import { useFleet } from "./fleet";
import { ago, useShow } from "./nav";
import { RepoIcon, useSharedIcons } from "./RepoIcon";
import { entriesOf, when, type Entry } from "./Sidebar";
import { AttentionBadge, Icon, T, useColors } from "./ui";

const RECENT = 8;

/** Whether `e` matches every word of `query`, by its title, repository, branch, and computer. */
function matches(e: Entry, query: string) {
  const text = `${e.title} ${e.repo ?? ""} ${e.run?.branch ?? ""} ${e.computer.machine.name}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w));
}

export function SearchScreen() {
  const c = useColors();
  const show = useShow();
  const { computers } = useFleet();
  const shared = useSharedIcons();
  const [query, setQuery] = useState("");
  const many = computers.length > 1;

  const all = entriesOf(computers).sort((a, b) => when(b.thread).localeCompare(when(a.thread)));
  const results = query.trim()
    ? all.filter((e) => matches(e, query))
    :all.filter((e) => !e.thread.archived).slice(0, RECENT);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={[styles.field, { backgroundColor: c.selected }]}>
        <Icon icon={SearchIcon} size={17} color={c.mutedForeground} />
        <TextInput
          accessibilityLabel="Search threads"
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Search threads"
          placeholderTextColor={c.faintForeground}
          selectionColor={c.accent}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="never"
          style={[styles.input, { color: c.foreground }]}
        />
        {!!query && (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear" hitSlop={10} onPress={() => setQuery("")}>
            <Icon icon={X} size={16} color={c.mutedForeground} />
          </Pressable>
        )}
      </View>
      <FlatList
        data={results}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        keyExtractor={(e) => `${e.computer.machine.id}:${e.thread.id}`}
        ListHeaderComponent={
          results.length ? (
            <T muted medium style={styles.heading}>
              {query.trim() ? "Threads" : "Recent"}
            </T>
          ) : null
        }
        ListEmptyComponent={
          <T muted style={styles.empty}>
            {query.trim() ? `No threads match "${query.trim()}".` : "No threads yet."}
          </T>
        }
        renderItem={({ item: e }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={e.title}
            onPress={() => show({ name: "Thread", params: { hostId: e.computer.machine.id, runId: e.thread.id } })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.hover }]}
          >
            <View style={[styles.icon, { backgroundColor: c.selected }]}>
              <RepoIcon repo={e.source} shared={shared} size={18} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.line}>
                <T numberOfLines={1} style={{ flex: 1, fontWeight: "500" }}>
                  {e.title}
                </T>
                {e.attention === "settled" ? (
                  <T faint style={styles.small}>
                    {ago(when(e.thread))}
                  </T>
                ) : (
                  <AttentionBadge attention={e.attention} />
                )}
              </View>
              <T muted numberOfLines={1} style={styles.small}>
                {[e.repo ?? "No repo", e.run?.branch, (many || query.trim()) && e.computer.machine.name]
                  .filter(Boolean)
                  .join(" · ")}
                {e.thread.archived ? " · Archived" : ""}
              </T>
            </View>
          </Pressable>
        )}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    height: 44,
    marginHorizontal: 16,
    marginTop: 22,
    marginBottom: 6,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
  },
  input: { flex: 1, fontSize: 17, paddingVertical: 0 },
  heading: { fontSize: 13, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  small: { fontSize: 13, lineHeight: 18 },
  empty: { textAlign: "center", paddingTop: 60, paddingHorizontal: 32 },
});
