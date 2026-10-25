// Files in a transcript as cards, as the desktop's FileCards and FileCard show them: one an agent
// presented or linked, read from its thread's folder with `agent/file`, or one a message sent,
// read back with `host/readUpload`. A card shows the file's type, name, and size, and a PDF its
// pages. Tapping one downloads it to the app's cache, in slices as the desktop reads them, and
// opens it in Quick Look, whose share button saves or sends it.
import * as Haptics from "expo-haptics";
import { File, Paths } from "expo-file-system";
import type { LucideIcon } from "lucide-react-native";
import {
  ArrowDown,
  File as PlainFile,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  Presentation,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { preview } from "../modules/pinned-tls";
import type { Colors } from "./theme";
import { Icon, T, useColors } from "./ui";

/**
 * Where a file is: `path` in run `runId`'s folder on `hostId`, or with no `runId`, the path
 * `host/upload` saved a sent file at.
 */
interface FileSource {
  hostId: string;
  runId?: string;
  path: string;
  name: string;
}

/** The most bytes asked in one slice, as the desktop's `pieceBytes`: it arrives within the heartbeat's 10 s. */
const pieceBytes = 256 * 1024;

/** One slice of `source` from `offset`, or with none all of it: its base64, and the whole file's size. */
async function sliceOf(
  source: FileSource,
  at?: { offset: number; length: number },
): Promise<{ data: string; size: number }> {
  const { hostId, runId, path } = source;
  if (!runId) {
    const answer = await window.parallax.request(hostId, "host/readUpload", { path, ...at });
    if ("error" in answer) throw new Error(answer.error.message);
    return { data: answer.result.data, size: answer.result.size ?? 0 };
  }
  const answer = await window.parallax.request(hostId, "agent/file", { runId, path, side: "working", ...at });
  if ("error" in answer) throw new Error(answer.error.message);
  const file = answer.result;
  if (!file.exists) throw new Error("This file isn't in the thread's folder anymore.");
  if (file.tooLarge || file.content == null) throw new Error("This file is too large to open here.");
  return { data: file.content, size: file.size ?? 0 };
}

/** `source`'s size in bytes, asked without its content. */
async function sizeOf(source: FileSource): Promise<number> {
  if (!source.runId) return (await sliceOf(source, { offset: 0, length: 1 })).size;
  const answer = await window.parallax.request(source.hostId, "agent/file", {
    runId: source.runId,
    path: source.path,
    side: "working",
    sizeOnly: true,
  });
  if ("error" in answer) throw new Error(answer.error.message);
  if (!answer.result.exists) throw new Error("This file isn't in the thread's folder anymore.");
  return answer.result.size ?? 0;
}

/** `hostId`'s slice size: its `fileChunks` (0074) up to `pieceBytes`, or undefined to read whole. */
async function chunkOf(hostId: string): Promise<number | undefined> {
  const state = await window.parallax.connectionState(hostId).catch(() => undefined);
  const chunk = state?.status === "connected" ? state.capabilities["fileChunks"]?.["chunkBytes"] : undefined;
  return typeof chunk === "number" ? Math.min(chunk, pieceBytes) : undefined;
}

const keyOf = (s: FileSource) => `${s.hostId}\n${s.runId ?? ""}\n${s.path}`;

/** A short, stable folder name for a file's key, so two files of one name don't meet in the cache. */
const folderOf = (key: string) => {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
};

// Each file's download this launch, by host, run, and path: one read however many cards show it.
const downloads = new Map<string, Promise<string>>();

/**
 * `source` saved in the app's cache under its own name, which Quick Look shows, as a `file://`
 * URL. Read in slices on a plxd with `fileChunks`, each appended as it comes, with `onProgress`
 * given the share read so far; else in one message.
 */
function download(source: FileSource, onProgress?: (share: number) => void): Promise<string> {
  const key = keyOf(source);
  let saved = downloads.get(key);
  if (saved) return saved;
  saved = (async () => {
    const file = new File(Paths.cache, "files", folderOf(key), source.name.replace(/[/\\]/g, "_"));
    file.create({ intermediates: true, overwrite: true });
    const chunk = await chunkOf(source.hostId);
    if (!chunk) {
      file.write((await sliceOf(source)).data, { encoding: "base64" });
      return file.uri;
    }
    for (let offset = 0; ; offset += chunk) {
      const { data, size } = await sliceOf(source, { offset, length: chunk });
      file.write(data, { encoding: "base64", append: true });
      onProgress?.(size ? Math.min(1, (offset + chunk) / size) : 1);
      if (offset + chunk >= size) return file.uri;
    }
  })();
  downloads.set(key, saved);
  // A host that's away now may answer later.
  saved.catch(() => downloads.delete(key));
  return saved;
}

/** Downloads `source` and opens it in Quick Look, or says why it couldn't. */
async function openFile(source: FileSource, onProgress?: (share: number) => void): Promise<void> {
  void Haptics.selectionAsync();
  try {
    await preview(await download(source, onProgress));
  } catch (error) {
    Alert.alert(`Couldn't open ${source.name}`, error instanceof Error ? error.message : String(error));
  }
}

/**
 * The pages a PDF's bytes hold, counted by its page objects. Undefined when they're packed in
 * compressed object streams, which only a PDF reader can count.
 */
async function pagesOf(uri: string): Promise<number | undefined> {
  const bytes = await new File(uri).bytes();
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length;
  return pages || undefined;
}

/** PDFs this size or smaller download when their card shows, for their page count. */
const countUpTo = 5 * 1024 * 1024;

/** `bytes` as people read a size: 512 bytes, 12 KB, 3.4 MB, as the desktop's `sizeOf`. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type Kind = "pdf" | "image" | "video" | "audio" | "document" | "sheet" | "slides" | "archive" | "code" | "file";

const kinds: [Kind, RegExp][] = [
  ["pdf", /^pdf$/],
  ["image", /^(png|jpe?g|gif|webp|heic|svg|bmp|tiff?|ico)$/],
  ["video", /^(mp4|mov|m4v|webm|avi|mkv)$/],
  ["audio", /^(mp3|wav|m4a|aac|flac|ogg|aiff?)$/],
  ["document", /^(docx?|rtf|txt|md|mdx|pages|odt|tex|epub)$/],
  ["sheet", /^(xlsx?|csv|tsv|numbers|ods)$/],
  ["slides", /^(pptx?|key|odp)$/],
  ["archive", /^(zip|gz|tgz|tar|7z|rar|bz2|xz|zst|dmg)$/],
  [
    "code",
    /^(rs|ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|sh|bash|zsh|json|ya?ml|toml|xml|html?|css|scss|sql|vue|svelte|dart|zig|ex|exs|hs|scala|nix|ipynb|lock|diff|patch)$/,
  ],
];

/** A file's kind, by its extension. */
const kindOf = (name: string): Kind => {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return kinds.find(([, test]) => test.test(ext))?.[0] ?? "file";
};

/** Each kind's icon and color, from the desktop's project colors. */
const looks: Record<Kind, { icon: LucideIcon; color: (c: Colors) => string }> = {
  pdf: { icon: FileText, color: (c) => c.projectRed },
  image: { icon: FileImage, color: (c) => c.projectTeal },
  video: { icon: FilePlay, color: (c) => c.projectPink },
  audio: { icon: FileMusic, color: (c) => c.projectPink },
  document: { icon: FileText, color: (c) => c.projectSky },
  sheet: { icon: FileSpreadsheet, color: (c) => c.projectGreen },
  slides: { icon: Presentation, color: (c) => c.projectOrange },
  archive: { icon: FileArchive, color: (c) => c.projectYellow },
  code: { icon: FileCode, color: (c) => c.projectViolet },
  file: { icon: PlainFile, color: (c) => c.projectGray },
};

/** A PDF's first page, drawn as a sheet of paper: a folded corner, lines of text, and a red PDF tag. */
function PdfSheet() {
  const c = useColors();
  return (
    <View style={styles.sheet}>
      <Svg width={46} height={58} viewBox="0 0 46 58">
        <Path d="M3 1h29l13 13v40a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z" fill="#ffffff" />
        <Path d="M32 1v10a3 3 0 0 0 3 3h10z" fill="#e4e4ea" />
        {[20, 25, 30, 35].map((y, i) => (
          <Rect key={y} x={7} y={y} width={i === 3 ? 18 : 30} height={2.2} rx={1.1} fill="#d6d6de" />
        ))}
        <Rect x={4} y={41} width={25} height={11} rx={2.5} fill={c.projectRed} />
      </Svg>
      <T style={styles.pdfTag}>PDF</T>
    </View>
  );
}

/** The share read so far, as a ring filling clockwise, or a spinner before the first slice. */
function Progress({ share }: { share?: number }) {
  const c = useColors();
  if (!share) return <ActivityIndicator size="small" color={c.mutedForeground} />;
  const r = 11;
  const around = 2 * Math.PI * r;
  return (
    <Svg width={28} height={28} viewBox="0 0 28 28" style={{ transform: [{ rotate: "-90deg" }] }}>
      <Circle cx={14} cy={14} r={r} stroke={c.selected} strokeWidth={3} fill="none" />
      <Circle
        cx={14}
        cy={14}
        r={r}
        stroke={c.accent}
        strokeWidth={3}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${around * share} ${around}`}
      />
    </Svg>
  );
}

/**
 * A file as a card: a PDF as a sheet of paper with its pages, any other by its kind's icon, then
 * its name, type, and size. Tapping it downloads it, showing its progress, and opens it in Quick
 * Look.
 */
export function FileCard({ source }: { source: FileSource }) {
  const c = useColors();
  const kind = kindOf(source.name);
  const look = looks[kind];
  const [size, setSize] = useState<number>();
  const [pages, setPages] = useState<number>();
  const [error, setError] = useState<string>();
  // The share downloaded while it's being opened, 0 before the first slice.
  const [share, setShare] = useState<number>();
  useEffect(() => {
    let live = true;
    void sizeOf(source)
      .then(async (bytes) => {
        if (!live) return;
        setSize(bytes);
        if (kind === "pdf" && bytes <= countUpTo) {
          const counted = await pagesOf(await download(source));
          if (live) setPages(counted);
        }
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [keyOf(source)]);
  const type = /\.([^./]+)$/.exec(source.name)?.[1]?.toUpperCase() ?? "File";
  const detail =
    error ??
    [type, pages && `${pages} ${pages === 1 ? "page" : "pages"}`, size !== undefined && sizeText(size)]
      .filter(Boolean)
      .join(" · ");
  const open = () => {
    if (share !== undefined) return;
    setShare(0);
    void openFile(source, setShare).finally(() => setShare(undefined));
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${source.name}`}
      accessibilityHint={detail}
      onPress={open}
      style={({ pressed }) => [
        styles.card,
        kind === "pdf" && styles.pdfCard,
        { borderColor: c.border, backgroundColor: pressed ? c.selected : c.surface },
      ]}
    >
      {kind === "pdf" ? (
        <PdfSheet />
      ) : (
        <View style={[styles.badge, { backgroundColor: c.selected }]}>
          <Icon icon={look.icon} size={20} color={look.color(c)} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={2} style={{ fontSize: 15, lineHeight: 20, fontWeight: "500" }}>
          {source.name}
        </T>
        <T numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: error ? c.danger : c.mutedForeground }}>
          {detail}
        </T>
      </View>
      <View style={[styles.action, { backgroundColor: c.selected }]}>
        {share !== undefined ? <Progress share={share} /> : <Icon icon={ArrowDown} size={16} color={c.foreground} />}
      </View>
    </Pressable>
  );
}

const isAbsolute = (path: string) => path.startsWith("/") || /^[a-z]:\//i.test(path);

/**
 * `path`, as a link names it, relative to the thread's folder `folder`, as `agent/file` takes it,
 * as the desktop's `inFolder`. Undefined when it's outside the folder.
 */
function inFolder(path: string, folder?: string): string | undefined {
  if (path.startsWith("~")) return undefined;
  let rest = path;
  if (isAbsolute(path)) {
    const base = folder?.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!base || !path.startsWith(`${base}/`)) return undefined;
    rest = path.slice(base.length + 1);
  }
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) return undefined;
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") || undefined;
}

// Each thread's folder by host and thread, once `agent/files` names it.
const folders = new Map<string, Promise<string | undefined>>();

/** Thread `runId`'s folder on `hostId`, which an absolute link has to be in. */
function threadFolder(hostId: string, runId: string): Promise<string | undefined> {
  const key = `${hostId}\n${runId}`;
  let folder = folders.get(key);
  if (!folder) {
    folder = window.parallax.request(hostId, "agent/files", { runId }).then((answer) => {
      if ("error" in answer) throw new Error(answer.error.message);
      return answer.result.folder;
    });
    folders.set(key, folder);
    folder.catch(() => folders.delete(key));
  }
  return folder;
}

/**
 * Opens a file an agent's message links, `path` as `linkedPath` reads it, from thread `runId`'s
 * folder, as the desktop's FileLink does. One outside the folder says so.
 */
export async function openLinked(hostId: string, runId: string, path: string): Promise<void> {
  try {
    const inside = inFolder(path, isAbsolute(path) ? await threadFolder(hostId, runId) : undefined);
    if (inside === undefined)
      return Alert.alert("Couldn't open the file", "This file is outside the thread's folder, so it can't be opened here.");
    await openFile({ hostId, runId, path: inside, name: inside.slice(inside.lastIndexOf("/") + 1) });
  } catch (error) {
    Alert.alert("Couldn't open the file", error instanceof Error ? error.message : String(error));
  }
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 14,
  },
  pdfCard: { paddingVertical: 14, paddingLeft: 16, gap: 14 },
  badge: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  sheet: {
    width: 46,
    height: 58,
    shadowColor: "#000000",
    shadowOpacity: 0.16,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  pdfTag: {
    position: "absolute",
    left: 4,
    top: 41,
    width: 25,
    fontSize: 7.5,
    lineHeight: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    textAlign: "center",
    color: "#ffffff",
  },
  action: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
