// The transcript's diffs, as the desktop draws them: an edit's lines in JetBrains Mono, added and
// removed ones tinted in the theme's colors with their sign, numbered when the diff says where they
// are, scrolling sideways; and a turn's changed files card (the desktop's TurnChanges.tsx) under its
// last reply, each file opening to its lines in the turn's diff (`orchestration/getTurnDiff`).
import { ChevronRight, FileText } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ThreadRun } from "../../desktop/src/protocol/generated/protocol";
import { fileRows, type DiffViewRow } from "./diffLogic";
import { DiffStats } from "./PullRequestParts";
import { font } from "./theme";
import { Icon, T, useColors } from "./ui";

// The lines shown before Show all, so a long write doesn't stall the transcript.
const shownLines = 120;

/** A diff's lines in a box that scrolls sideways, cut to `shownLines` with Show all. */
export function DiffView({ rows }: { rows: readonly DiffViewRow[] }) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, shownLines);
  const numbered = rows.some((r) => r.kind !== "band" && r.line !== undefined);
  const looks = {
    add: { sign: "+", color: c.added, row: { backgroundColor: `${c.added}1f`, borderLeftColor: c.added } },
    del: { sign: "−", color: c.danger, row: { backgroundColor: `${c.danger}1f`, borderLeftColor: c.danger } },
    context: { sign: " ", color: c.faintForeground, row: { borderLeftColor: "transparent" } },
  };
  return (
    <View style={{ gap: 4 }}>
      <View style={[styles.box, { backgroundColor: c.code, borderColor: c.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: "100%" }}>
          {/* A column as wide as its widest line, so every line's tint reaches the same edge. */}
          <View style={{ paddingVertical: 4 }}>
            {shown.map((r, i) => {
              if (r.kind === "band")
                return (
                  <T key={i} style={{ ...styles.code, ...styles.band, color: c.faintForeground, backgroundColor: c.hover }}>
                    {r.text}
                  </T>
                );
              const look = looks[r.kind];
              return (
                <View
                  key={i}
                  accessibilityLabel={`${r.kind === "add" ? "Added: " : r.kind === "del" ? "Removed: " : ""}${r.text}`}
                  style={[styles.row, look.row]}
                >
                  {numbered && <T style={{ ...styles.code, ...styles.number, color: c.faintForeground }}>{r.line ?? ""}</T>}
                  <T style={{ ...styles.code, ...styles.sign, color: look.color }}>{look.sign}</T>
                  <T style={{ ...styles.code, paddingRight: 12 }}>{r.text || " "}</T>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
      {rows.length > shownLines && (
        <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setAll(!all)}>
          <T muted style={{ fontSize: 12.5 }}>
            {all ? "Show less" : `Show all ${rows.length} lines`}
          </T>
        </Pressable>
      )}
    </View>
  );
}

/** Turn diffs read, by computer, thread, and turn: a ready checkpoint's diff never changes. */
const turnDiffs = new Map<string, Promise<string>>();

/** Turn `ordinal`'s diff, from the checkpoint before it to its own, or why it couldn't be read. */
function readTurnDiff(hostId: string, threadId: string, ordinal: number): Promise<string> {
  const key = `${hostId}/${threadId}/${ordinal}`;
  let read = turnDiffs.get(key);
  if (!read) {
    read = window.parallax
      .request(hostId, "orchestration/getTurnDiff", { threadId, from: ordinal - 1, to: ordinal })
      .then((a) => {
        if ("error" in a) throw new Error(a.error.message);
        return a.result.diff;
      });
    // A failed read is tried again next time.
    read.catch(() => turnDiffs.delete(key));
    turnDiffs.set(key, read);
  }
  return read;
}

/** One changed file's lines in its turn's diff, read once the file opens. */
function FileDiff({ hostId, threadId, ordinal, path }: { hostId: string; threadId: string; ordinal: number; path: string }) {
  const c = useColors();
  const [diff, setDiff] = useState<string | { error: string }>();
  useEffect(() => {
    let live = true;
    readTurnDiff(hostId, threadId, ordinal).then(
      (d) => live && setDiff(d),
      (e: Error) => live && setDiff({ error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [hostId, threadId, ordinal]);
  const rows = useMemo(() => (typeof diff === "string" ? fileRows(diff, path) : []), [diff, path]);
  if (diff === undefined) return <T faint style={{ fontSize: 12.5, paddingVertical: 4 }}>Loading…</T>;
  if (typeof diff !== "string")
    return (
      <T alert style={{ fontSize: 12.5, color: c.danger }}>
        {diff.error}
      </T>
    );
  if (rows.length === 0) return <T faint style={{ fontSize: 12.5 }}>No lines to show, as for a binary file.</T>;
  return <DiffView rows={rows} />;
}

/** A turn's changed files with more than this many start folded, as on the desktop. */
const openUpTo = 10;

/**
 * The files turn `run` changed, as its checkpoint counts them (0062): how many and their lines,
 * then each file with its own, opening to its lines. Nothing while the turn has no ready
 * checkpoint or changed nothing. Which rows are open is the transcript's, by `open` and `toggle`,
 * since rows unmount off screen.
 */
export function TurnChanges({
  hostId,
  threadId,
  run,
  open,
  toggle,
}: {
  hostId: string;
  threadId: string;
  run: ThreadRun;
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
}) {
  const c = useColors();
  const files = run.checkpoint?.status === "ready" ? (run.checkpoint.files ?? []) : [];
  if (!run.ordinal || files.length === 0) return null;
  const ordinal = run.ordinal;
  const key = `changes:${run.id}`;
  // Toggling flips the list from how it starts.
  const listed = open.has(key) !== files.length <= openUpTo;
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.surface }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: listed }}
        onPress={() => toggle(key)}
        style={styles.header}
      >
        <T medium style={{ fontSize: 14 }}>
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </T>
        <DiffStats additions={added} deletions={removed} />
        <View style={{ flex: 1 }} />
        <View style={{ transform: [{ rotate: listed ? "90deg" : "0deg" }] }}>
          <Icon icon={ChevronRight} size={14} color={c.faintForeground} />
        </View>
      </Pressable>
      {listed &&
        files.map((file) => {
          const fileKey = `${key}\n${file.path}`;
          const slash = file.path.lastIndexOf("/");
          return (
            <View key={file.path} style={[styles.file, { borderTopColor: c.border }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open.has(fileKey) }}
                accessibilityLabel={file.path}
                onPress={() => toggle(fileKey)}
                style={styles.fileLine}
              >
                <Icon icon={FileText} size={14} color={c.faintForeground} />
                <T numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>
                  <T faint style={{ fontSize: 13, lineHeight: 18 }}>
                    {file.path.slice(0, slash + 1)}
                  </T>
                  {file.path.slice(slash + 1)}
                </T>
                <DiffStats additions={file.additions} deletions={file.deletions} compact />
              </Pressable>
              {open.has(fileKey) && (
                <View style={{ paddingBottom: 10 }}>
                  <FileDiff hostId={hostId} threadId={threadId} ordinal={ordinal} path={file.path} />
                </View>
              )}
            </View>
          );
        })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden" },
  code: { fontFamily: font.mono, fontSize: 11.5, lineHeight: 17 },
  band: { paddingHorizontal: 10, paddingVertical: 1 },
  row: { flexDirection: "row", borderLeftWidth: 2 },
  number: { minWidth: 32, textAlign: "right", paddingRight: 8 },
  sign: { width: 16, paddingLeft: 4 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: "hidden", marginTop: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 12 },
  file: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  fileLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36 },
});
