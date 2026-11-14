// A thread's folder on its computer, as the desktop's Files panel browses it, as a sheet: folders
// first, then by name, each folder opening in place with a back chevron up. A file opens read-only,
// as plain text in the sheet. An image, or a file that's binary or too large to show here, shows its
// card instead, which opens it in Quick Look. Changing files stays on the desktop.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { t } from "i18next";
import { ChevronLeft, File, FileSymlink, Folder } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";

import { msg } from "../../desktop/src/i18n";
import type { RpcError } from "../../desktop/src/preload/bridge";
import type { AgentEntry } from "../../desktop/src/protocol/generated/protocol";
import { describeError } from "../../desktop/src/renderer/errors";
import { FileCard, kindOf } from "./FileCard";
import { useComputer } from "./fleet";
import { GlassButton } from "./Glass";
import type { Screens } from "./nav";
import { inOrder, join, linesOf, nameOf, parentOf, textOf } from "./threadFilesLogic";
import { Icon, Row, T, useColors } from "./ui";

/** Where the sheet is: a folder, "" for the thread's own, or a file. */
type At = { path: string; file: boolean };

/**
 * What's there: a folder's entries, a file's lines, what to say (shown with `t`) and offer instead,
 * or plxd's refusal.
 */
type Shown =
  | { entries: AgentEntry[]; truncated: boolean }
  | { lines: string[] }
  | { note?: string; card?: boolean }
  | { error: string };

/**
 * The most bytes the sheet reads to show as text: one message that arrives within the heartbeat's
 * 10 s on a slow link, as the desktop's `pieceBytes`.
 */
const shownBytes = 256 * 1024;

const tooLarge: Shown = { note: msg("This file is too large to show here."), card: true };
const gone: Shown = { note: msg("This file isn't there anymore.") };

/** plxd's reason it refused, without JSON-RPC's prefix. */
const refusal = (error: RpcError): Shown => ({ error: describeError(error).replace(/^Invalid params: /, "") });

/** Folder `path` of run `runId`'s folder, "" for the folder itself, in the order it's shown. */
async function listFolder(hostId: string, runId: string, path: string): Promise<Shown> {
  const listed = await window.parallax.request(hostId, "agent/files", { runId, ...(path && { path }) });
  if ("error" in listed) return refusal(listed.error);
  return { entries: inOrder(listed.result.entries), truncated: listed.result.truncated };
}

/** File `path` as the sheet shows it. Its size comes first, so a large one is never read here. */
async function readFile(hostId: string, runId: string, path: string): Promise<Shown> {
  const file = { runId, path, side: "working" as const };
  const stat = await window.parallax.request(hostId, "agent/file", { ...file, sizeOnly: true });
  if ("error" in stat) return refusal(stat.error);
  if (!stat.result.exists) return gone;
  if (kindOf(path) === "image") return { card: true };
  if ((stat.result.size ?? 0) > shownBytes) return tooLarge;
  const read = await window.parallax.request(hostId, "agent/file", file);
  if ("error" in read) return refusal(read.error);
  if (!read.result.exists) return gone;
  if (read.result.tooLarge || read.result.content == null) return tooLarge;
  const text = textOf(read.result.content);
  return text === undefined ? { note: msg("This is a binary file."), card: true } : { lines: linesOf(text) };
}

export function ThreadFilesScreen({ route }: NativeStackScreenProps<Screens, "ThreadFiles">) {
  const { hostId, runId } = route.params;
  const c = useColors();
  const list = useRef<FlatList<AgentEntry | string>>(null);
  const [at, setAt] = useState<At>({ path: "", file: false });
  const [loaded, setLoaded] = useState<{ at: At; shown: Shown }>();
  // Read each time it opens, so going back shows the agent's latest files.
  useEffect(() => {
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [at]);
  const connectedNow = !!useComputer(hostId)?.connectedNow;
  useEffect(() => {
    if (!connectedNow) return;
    let live = true;
    void (at.file ? readFile : listFolder)(hostId, runId, at.path)
      .catch((e: unknown): Shown => ({ error: e instanceof Error ? e.message : String(e) }))
      .then((shown) => live && setLoaded({ at, shown }));
    return () => {
      live = false;
    };
  }, [at, connectedNow]);

  const shown = loaded?.at === at ? loaded.shown : undefined;
  const data: (AgentEntry | string)[] = !shown ? [] : "entries" in shown ? shown.entries : "lines" in shown ? shown.lines : [];
  // A form sheet sizes only a scroll view that follows one header view, so these two are the
  // screen's only children, and the one list stays mounted for folders and files alike.
  return (
    <>
      <View collapsable={false} style={styles.top}>
        {!!at.path && (
          <GlassButton label={t("Back")} onPress={() => setAt({ path: parentOf(at.path), file: false })}>
            <Icon icon={ChevronLeft} size={22} />
          </GlassButton>
        )}
        <T medium numberOfLines={1} ellipsizeMode="head" style={styles.title}>
          {at.path || t("Files")}
        </T>
      </View>
      <FlatList
        ref={list}
        data={data}
        keyExtractor={(item, i) => (typeof item === "string" ? String(i) : item.name)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 16 }}
        renderItem={({ item, index }) =>
          typeof item === "string" ? (
            <T mono selectable style={styles.line}>
              {item || " "}
            </T>
          ) : (
            <Row
              icon={item.kind === "dir" ? Folder : item.kind === "symlink" ? FileSymlink : File}
              title={item.name}
              chevron={item.kind === "dir"}
              last={index === data.length - 1}
              onPress={() => setAt({ path: join(at.path, item.name), file: item.kind !== "dir" })}
            />
          )
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {!shown ? (
              <ActivityIndicator color={c.mutedForeground} />
            ) : "error" in shown ? (
              <T alert style={{ color: c.danger }}>
                {shown.error}
              </T>
            ) : "entries" in shown ? (
              <T muted>{t("This folder is empty.")}</T>
            ) : "lines" in shown ? (
              <T muted>{t("This file is empty.")}</T>
            ) : (
              <>
                {!!shown.note && <T muted>{t(shown.note)}</T>}
                {shown.card && <FileCard source={{ hostId, runId, path: at.path, name: nameOf(at.path) }} />}
              </>
            )}
          </View>
        }
        ListFooterComponent={
          shown && "entries" in shown && shown.truncated ? (
            <T muted style={styles.more}>
              {t("More files not shown.")}
            </T>
          ) : null
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  // Padding, not margins: the sheet sizes the list by this view's frame. As tall with its back
  // button as without, so the list doesn't jump.
  top: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 72, paddingTop: 22, paddingBottom: 6, paddingHorizontal: 16 },
  title: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  line: { lineHeight: 19, paddingHorizontal: 16 },
  empty: { gap: 12, padding: 16 },
  more: { padding: 16 },
});
