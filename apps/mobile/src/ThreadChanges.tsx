// A thread's changes, as the desktop's Changes view (0062) shows them, in a sheet: its diff across
// every turn or for one turn, from the checkpoints plxd captures as each turn ends, each file with
// its lines added and removed, folding on a tap. Reverting to a turn stays on the desktop.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { t } from "i18next";
import { ChevronRight, CircleAlert, FileDiff, FileText, History } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ThreadRun, TurnDiffResult } from "../../desktop/src/protocol/generated/protocol";
import { parseDiff, type DiffFile } from "../../desktop/src/renderer/parseDiff";
import { changeRows, turnChoices, type ChangeRow } from "./changesLogic";
import { Choices } from "./Choices";
import { useComputer } from "./fleet";
import type { Screens } from "./nav";
import { DiffLine, DiffStats, useCard } from "./PullRequestParts";
import { Empty, Icon, Row, Section, T, useColors } from "./ui";

/** A file's path, its lines added and removed, and a chevron, which folds its lines on a tap. */
function FileHeader({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: (path: string) => void }) {
  const c = useColors();
  const card = useCard();
  const slash = file.path.lastIndexOf("/");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={file.path}
      onPress={() => onToggle(file.path)}
      style={[styles.file, { backgroundColor: card, borderColor: c.border }]}
    >
      <Icon icon={FileText} size={15} color={c.faintForeground} />
      <T numberOfLines={1} ellipsizeMode="head" style={styles.path}>
        <T muted style={styles.pathPart}>
          {file.oldPath && `${file.oldPath} → `}
          {file.path.slice(0, slash + 1)}
        </T>
        <T medium style={styles.pathPart}>
          {file.path.slice(slash + 1)}
        </T>
      </T>
      <DiffStats additions={file.added} deletions={file.removed} compact />
      <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
        <Icon icon={ChevronRight} size={14} color={c.faintForeground} />
      </View>
    </Pressable>
  );
}

/** Why there's no diff to show. */
export function ThreadChangesScreen({ route }: NativeStackScreenProps<Screens, "ThreadChanges">) {
  const { hostId, runId } = route.params;
  const c = useColors();
  const insets = useSafeAreaInsets();
  const computer = useComputer(hostId);
  const connection = computer?.state;
  const unavailable =
    connection?.status !== "connected"
      ? t("{{name}} isn't connected.", { name: computer?.machine.name ?? t("This computer") })
      : "checkpoints" in connection.capabilities
        ? undefined
        : t("Update Parallax on this computer to see a thread's changes.");
  const prompt = computer?.view.state.runs[runId]?.prompt ?? "";

  const [runs, setRuns] = useState<ThreadRun[] | { error: string }>();
  // The turn shown by its ordinal, or every turn.
  const [shownTurn, setShownTurn] = useState<number | "all">("all");
  const [picking, setPicking] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<TurnDiffResult | { error: string }>();

  useEffect(() => {
    if (unavailable) return;
    let live = true;
    const load = () =>
      void window.parallax.request(hostId, "orchestration/threadRuns", { threadId: runId }).then((a) => {
        if (live) setRuns("error" in a ? { error: a.error.message } : a.result.runs);
      });
    load();
    // Checkpoint events stay on the thread's subscription, outside the shell's stream.
    const stop = window.parallax.watch(hostId, { threadId: runId }, (message) => {
      if (
        message.type === "snapshot" ||
        (message.type === "event" && ["thread.checkpoint", "thread.reverted"].includes(message.event.event.kind))
      )
        load();
    });
    return () => {
      live = false;
      stop();
    };
  }, [hostId, runId, unavailable]);

  const choices = useMemo(() => (Array.isArray(runs) ? turnChoices(runs, prompt) : []), [runs, prompt]);
  const latest = choices[choices.length - 1]?.ordinal;
  // A turn a revert undid falls back to every turn.
  const turn = choices.find((t) => t.ordinal === shownTurn);
  const ordinal = turn?.ordinal;

  useEffect(() => setShown(undefined), [hostId, runId, latest, ordinal]);
  useEffect(() => {
    if (unavailable || !computer?.connectedNow || latest === undefined) return;
    let live = true;
    const answer =
      ordinal === undefined
        ? window.parallax.request(hostId, "orchestration/getFullThreadDiff", { threadId: runId, to: latest })
        : window.parallax.request(hostId, "orchestration/getTurnDiff", { threadId: runId, from: ordinal - 1, to: ordinal });
    void answer.then((a) => {
      if (live) setShown("error" in a ? { error: a.error.message } : a.result);
    });
    return () => {
      live = false;
    };
  }, [hostId, runId, latest, ordinal, unavailable, computer?.connectedNow]);

  const diff = shown && "diff" in shown ? shown : undefined;
  const files = useMemo(() => (diff ? parseDiff(diff.diff) : []), [diff]);
  const rows = useMemo(() => changeRows(files, folded), [files, folded]);

  const toggle = useCallback((path: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const renderItem = useCallback(
    ({ item }: { item: ChangeRow }) => {
      if (item.kind === "file") return <FileHeader file={item.file} open={item.open} onToggle={toggle} />;
      if (item.kind === "line") return <DiffLine row={item.row} />;
      return (
        <T faint style={{ fontSize: 13, paddingHorizontal: 12, paddingVertical: 8 }}>
          {item.text}
        </T>
      );
    },
    [toggle],
  );

  // What's already read stays through a lost connection, and is read again when it's back.
  const empty =
    unavailable && !diff ? (
      <Empty icon={FileDiff} title={t("Changes aren't available")} note={unavailable} />
    ) : runs && "error" in runs ? (
      <Empty icon={CircleAlert} title={t("Couldn't load the changes")} note={runs.error} />
    ) : runs && latest === undefined ? (
      <Empty icon={FileDiff} title={t("No changes yet")} note={t("Edits from this thread show up here for review.")} />
    ) : undefined;
  const loading = !unavailable && (!runs || (latest !== undefined && !shown));

  return (
    <>
      <FlatList
        style={{ backgroundColor: c.background }}
        data={empty ? [] : rows}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        initialNumToRender={80}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 12 }}>
            {empty ?? (
              <>
                {latest !== undefined && (
                  <Section>
                    <Row
                      icon={History}
                      title={turn?.label ?? t("All turns")}
                      detail={turn?.description}
                      chevron={!unavailable}
                      last
                      onPress={unavailable ? undefined : () => setPicking(true)}
                    />
                  </Section>
                )}
                {loading && <ActivityIndicator style={{ marginTop: 30 }} color={c.accent} />}
                {shown && "error" in shown && (
                  <T alert style={{ color: c.danger, fontSize: 14 }}>
                    {shown.error}
                  </T>
                )}
                {diff && (
                  <View style={styles.summary}>
                    <T muted style={{ fontSize: 14 }}>
                      {files.length === 0
                        ? t("No files changed.")
                        : t("{{count}} changed files", { count: files.length, defaultValue_one: "{{count}} changed file" })}
                    </T>
                    {files.length > 0 && (
                      <DiffStats
                        additions={files.reduce((n, f) => n + f.added, 0)}
                        deletions={files.reduce((n, f) => n + f.removed, 0)}
                      />
                    )}
                  </View>
                )}
                {diff?.truncated && (
                  <T style={{ color: c.warning, fontSize: 14 }}>
                    {t("This diff was too long, so it's cut short and later files may be missing.")}
                  </T>
                )}
              </>
            )}
          </View>
        }
      />
      <Choices
        title={t("Turn")}
        open={picking}
        value={String(ordinal ?? "all")}
        options={[{ value: "all", label: t("All turns") }, ...choices]}
        onChoose={(value) => {
          setShownTurn(value === "all" ? "all" : Number(value));
          setFolded(new Set());
        }}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  path: { flex: 1, fontSize: 13, lineHeight: 17 },
  pathPart: { fontSize: 13, lineHeight: 17 },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
