// The host's threads, newest first, as the desktop sidebar shows them: project or repo, title,
// branch, and whether it's working or needs you.
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import type { Thread } from "../../desktop/src/protocol/generated/protocol";
import { asksOf, groupOf, noRepo, type ThreadsView } from "../../desktop/src/renderer/threads";
import { isRunning } from "../../desktop/src/renderer/transcript";
import { Mark, T, useColors } from "./ui";

/** "now", "5m", "3h", "2d": how long ago `iso` was, as the sidebar says it. */
function ago(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

export function ThreadList({
  view,
  name,
  status,
  onOpen,
  onSettings,
}: {
  view: ThreadsView;
  name: string;
  status?: string;
  onOpen: (thread: Thread) => void;
  onSettings: () => void;
}) {
  const c = useColors();
  const { state } = view;
  const when = (t: Thread) => t.lastPromptAt ?? t.createdAt;
  const threads = state.threads
    .filter((t) => !t.archived)
    .sort((a, b) => when(b).localeCompare(when(a)));
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={styles.header}>
        <Mark />
        <T medium style={{ fontSize: 20, flex: 1 }}>
          Parallax
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={onSettings}
          hitSlop={12}
        >
          <T muted style={{ fontSize: 14 }}>
            {name}
          </T>
        </Pressable>
      </View>
      {(status ?? view.error) && (
        <T muted style={styles.status}>
          {status ?? view.error}
        </T>
      )}
      <T muted style={styles.section}>
        Threads
      </T>
      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 40 }}
        ListEmptyComponent={
          <T muted style={{ padding: 12 }}>
            {status
              ? "Offline"
              : view.loading
                ? "Loading…"
                : "No threads yet. Start one on your computer."}
          </T>
        }
        renderItem={({ item: t }) => {
          const run = state.runs[t.id];
          const group = groupOf(state, t);
          const where =
            group === noRepo ? "No repo" : state.repos.find((r) => r.id === group)?.name;
          const title = state.titles[t.id] ?? "New thread";
          const [status, color] =
            asksOf(state, t.id) > 0
              ? ["Needs you", c.warning]
              : isRunning(run?.status)
                ? ["Working", c.accent]
                : [ago(when(t)), c.mutedForeground];
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${title}, ${status}`}
              onPress={() => onOpen(t)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.selected }]}
            >
              <View style={styles.line}>
                <T muted style={styles.small}>
                  {where}
                </T>
                <T style={{ ...styles.small, color }}>{status}</T>
              </View>
              <T numberOfLines={1}>{title}</T>
              {run?.branch && (
                <T muted style={styles.small}>
                  {run.branch}
                </T>
              )}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 64,
    paddingBottom: 12,
  },
  status: { paddingHorizontal: 20, fontSize: 13 },
  section: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, fontSize: 13 },
  row: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9, gap: 1 },
  line: { flexDirection: "row", justifyContent: "space-between" },
  small: { fontSize: 13, lineHeight: 18 },
});
