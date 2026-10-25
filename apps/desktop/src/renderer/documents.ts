import { useEffect, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import type { ConnectionState, HostResponse, RpcError } from "../preload/bridge";
import { openDocx, type Docx } from "./docx";
import { describeError } from "./errors";
import { fromBase64 } from "./ooxml";
import { openPptx, type Pptx } from "./pptx";
import { openXlsx, type Xlsx } from "./xlsx";

/**
 * Documents an agent presented with `present_files` (PLX-755) or linked in a message (PLX-834):
 * read from its thread's folder through `agent/file`, in slices on a plxd with `fileChunks`
 * (PLX-835, decision 0074), opened by type, and shared by the
 * transcript's cards and the side panel until a newer presentation reloads them.
 */

import { isMedia, type DocKind, type DocRef, type MediaKind } from "./transcript";

export type { DocRef };

export type Opened =
  | { kind: "docx"; docx: Docx }
  | { kind: "xlsx"; xlsx: Xlsx }
  | { kind: "pptx"; pptx: Pptx }
  /** A PDF, with its first page's height over its width. */
  | { kind: "pdf"; pdf: PDFDocumentProxy; ratio: number }
  /** An image or video (PLX-785), shown from its bytes as they are. */
  | { kind: "media" }
  /** Any other file (PLX-834): only its bytes, to download. */
  | { kind: "file" };

export interface Loaded {
  bytes: Uint8Array;
  opened: Opened;
}

export const kinds: Record<Exclude<DocKind, MediaKind>, string> = {
  docx: "Document",
  pdf: "Document",
  xlsx: "Spreadsheet",
  pptx: "Presentation",
  file: "File",
};

/** A file's type in a badge: its kind, or for a plain file its extension. */
export const typeOf = (doc: DocRef) =>
  doc.kind === "file"
    ? (/\.([a-z0-9]{1,10})$/i.exec(doc.name)?.[1]?.toUpperCase() ?? "FILE")
    : doc.kind.toUpperCase();

/** `bytes` as a size people read: 512 bytes, 12 KB, 3.4 MB, 1.0 GB. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A file's name as a title: no extension, and spaces for underscores and hyphens. */
export const titleOf = (name: string) =>
  name
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();

const cache = new Map<string, Promise<Loaded>>();
const listeners = new Set<() => void>();
let version = 0;
const keyOf = (hostId: string, doc: DocRef) => `${hostId}\n${doc.runId}\n${doc.path}`;

/** `bytes` as a PDF, with pdf.js loaded on first use. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // pdf.js takes the buffer over, and the download keeps it.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  // A file that isn't a PDF, or is locked, would keep its worker running.
  return task.promise.catch(async (error: unknown) => {
    await task.destroy();
    throw error;
  });
}

/** Why a request to `hostId` failed, for people: the host being offline, or plxd's reason. */
export async function failure(hostId: string, error: RpcError): Promise<string> {
  const state = await window.parallax.connectionState(hostId).catch(() => undefined);
  return state?.status === "connected" ? describeError(error) : "The host is offline.";
}

/** Run `runId`'s html_render page or recording `attachmentId` (PLX-639), from `agent/image`. */
export async function readAttachment(
  hostId: string,
  runId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const answer = await window.parallax.request(hostId, "agent/image", {
    runId,
    imageId: attachmentId,
  });
  if ("error" in answer) throw new Error(await failure(hostId, answer.error));
  return fromBase64(answer.result.data);
}

/** A host's `fileChunks` capability (0074): the bytes one slice or piece carries, and the largest file pieces make. */
interface FileChunks {
  chunkBytes: number;
  maxBytes: number;
}

/**
 * The most file bytes the app puts in one slice or piece, below plxd's `chunkBytes` (a maximum).
 * About 350 KB of base64, which sends inside the heartbeat's 10 s liveness (`LIVENESS_MS`) on a
 * link down to about 0.3 Mbit/s, so a piece in flight never ends the connection.
 */
export const pieceBytes = 256 * 2 ** 10;

/**
 * `connection`'s `fileChunks`, with `chunkBytes` at most `pieceBytes`. Undefined while it isn't
 * connected, or when its plxd moves each file in one message.
 */
export function fileChunks(connection?: ConnectionState): FileChunks | undefined {
  const cap =
    connection?.status === "connected" ? connection.capabilities["fileChunks"] : undefined;
  const chunkBytes = cap?.["chunkBytes"];
  const maxBytes = cap?.["maxBytes"];
  return typeof chunkBytes === "number" && typeof maxBytes === "number"
    ? { chunkBytes: Math.min(chunkBytes, pieceBytes), maxBytes }
    : undefined;
}

/** `hostId`'s `fileChunks`, as it's connected now. */
export const chunksOf = async (hostId: string) =>
  fileChunks(await window.parallax.connectionState(hostId).catch(() => undefined));

/** How long a retry waits for its host to reconnect before it's sent anyway. */
const reconnectWaitMs = 60_000;

/**
 * Resolves once `hostId` is connected, or can't reconnect by itself, or after `reconnectWaitMs`,
 * whichever comes first.
 */
function reconnected(hostId: string): Promise<void> {
  const settled = (state: ConnectionState) =>
    state.status === "connected" || (state.status === "failed" && !state.retrying);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, reconnectWaitMs);
    const stop = window.parallax.onConnectionState((id, state) => {
      if (id === hostId && settled(state)) done();
    });
    void window.parallax.connectionState(hostId).then((state) => settled(state) && done(), done);
  });
}

/**
 * `send`'s answer, sent up to twice more while it answers an error, as a timeout on a slow link
 * does. A retry first waits for `hostId` to reconnect, so a dropped connection resumes the
 * transfer from the same slice or piece. Only for a call that answers a repeat as it did the
 * first: a slice, or a piece (0074).
 */
export async function retried<R>(
  hostId: string,
  send: () => Promise<HostResponse<R>>,
): Promise<HostResponse<R>> {
  let answer = await send();
  for (let tries = 1; tries < 3 && "error" in answer; tries++) {
    await reconnected(hostId);
    answer = await send();
  }
  return answer;
}

/** Reads over this many bytes report their progress; smaller ones finish before it would show. */
export const progressFrom = 4 * 2 ** 20;

/** One slice of a file, or with no `at`, all of it in one message: its base64, and the whole file's size. */
export type Slice = (at?: {
  offset: number;
  length: number;
}) => Promise<{ data: string; size?: number }>;

/**
 * A whole file on `hostId`, read with `slice`: on a plxd with `fileChunks` (0074), in slices of
 * its `chunkBytes` into one buffer, so a file of any size reads over a slow link, with
 * `onProgress` given the share read after each slice of a file over `progressFrom`. Without
 * `fileChunks`, in one message, under that plxd's cap.
 */
export async function readSlices(
  hostId: string,
  slice: Slice,
  onProgress?: (share: number) => void,
): Promise<Uint8Array> {
  const chunks = await chunksOf(hostId);
  if (!chunks) return fromBase64((await slice()).data);
  let bytes: Uint8Array | undefined;
  let at = 0;
  do {
    const { data, size = 0 } = await slice({ offset: at, length: chunks.chunkBytes });
    bytes ??= new Uint8Array(size);
    const piece = fromBase64(data);
    // Rewritten, grown, or cut short since the first slice.
    if (size !== bytes.length || at + piece.length > size || (piece.length === 0 && at < size))
      throw new Error("This file changed while it was read. Try again.");
    bytes.set(piece, at);
    at += piece.length;
    if (size > progressFrom) onProgress?.(at / size);
  } while (at < bytes.length);
  return bytes;
}

/** File `path` in run `runId`'s folder on `hostId`, from `agent/file`, read with `readSlices`. */
export function readWorking(
  hostId: string,
  runId: string,
  path: string,
  onProgress?: (share: number) => void,
): Promise<Uint8Array> {
  const slice: Slice = async (at) => {
    const answer = await retried(hostId, () =>
      window.parallax.request(hostId, "agent/file", { runId, path, side: "working", ...at }),
    );
    if ("error" in answer) throw new Error(await failure(hostId, answer.error));
    const file = answer.result;
    if (!file.exists) throw new Error("This file isn't in the thread's folder anymore.");
    if (file.tooLarge || file.content == null)
      throw new Error("This file is too large to open here.");
    return { data: file.content, size: file.size };
  };
  return readSlices(hostId, slice, onProgress);
}

/** The size of file `path` in run `runId`'s folder on `hostId`, asked without its content. */
export async function workingSize(hostId: string, runId: string, path: string): Promise<number> {
  const answer = await window.parallax.request(hostId, "agent/file", {
    runId,
    path,
    side: "working",
    sizeOnly: true,
  });
  if ("error" in answer) throw new Error(await failure(hostId, answer.error));
  if (!answer.result.exists) throw new Error("This file isn't in the thread's folder anymore.");
  return answer.result.size ?? 0;
}

export async function load(
  hostId: string,
  doc: DocRef,
  onProgress?: (share: number) => void,
): Promise<Loaded> {
  const bytes = await readWorking(hostId, doc.runId, doc.path, onProgress);
  if (doc.kind === "file") return { bytes, opened: { kind: "file" } };
  const opened: Opened = isMedia(doc.kind)
    ? { kind: "media" }
    : doc.kind === "docx"
      ? { kind: "docx", docx: openDocx(bytes) }
      : doc.kind === "xlsx"
        ? { kind: "xlsx", xlsx: openXlsx(bytes) }
        : doc.kind === "pptx"
          ? { kind: "pptx", pptx: openPptx(bytes) }
          : await (async () => {
              const pdf = await openPdf(bytes);
              const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
              return { kind: "pdf" as const, pdf, ratio: first.height / first.width };
            })();
  return { bytes, opened };
}

const reloadEverywhere = () => {
  version++;
  for (const listener of listeners) listener();
};

// Each file's latest present_files result seen, by the event seq its transcript key starts with.
const presented = new Map<string, number>();

/**
 * Reads `docs` from disk again when present_files result `item` is newer than any seen for them,
 * since an agent that rebuilds a file presents it again under the same path. An older result
 * scrolled back into view changes nothing. Called while rendering, before the cards load, so it
 * notifies what's already showing a file afterwards.
 */
export function readPresented(hostId: string, item: string, docs: DocRef[]) {
  const seq = Number.parseInt(item, 10);
  let stale = false;
  for (const doc of docs) {
    const key = keyOf(hostId, doc);
    const seen = presented.get(key);
    if (seen !== undefined && seq <= seen) continue;
    presented.set(key, seq);
    if (seen !== undefined) stale = cache.delete(key) || stale;
  }
  if (stale) queueMicrotask(reloadEverywhere);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Each file over `progressFrom`'s share read so far, by key, while it loads.
const shares = new Map<string, number>();

/**
 * `doc` from `hostId`, opened, and opened again when a newer presentation reloads it. While a
 * file over `progressFrom` loads, `progress` is the share of it read so far. With `read` false,
 * nothing is read, for a card that reads its file only when asked.
 */
export function useDocument(hostId: string, doc: DocRef, read = true) {
  const loads = useSyncExternalStore(subscribe, () => version);
  const share = useSyncExternalStore(subscribe, () => shares.get(keyOf(hostId, doc)));
  const [state, setState] = useState<{ loaded?: Loaded; error?: string }>({});
  const { runId, path, name, kind } = doc;
  useEffect(() => {
    if (!read) return;
    let live = true;
    const ref = { runId, path, name, kind };
    const key = keyOf(hostId, ref);
    let loading = cache.get(key);
    if (!loading) {
      loading = load(hostId, ref, (read) => {
        shares.set(key, read);
        for (const listener of listeners) listener();
      });
      cache.set(key, loading);
      loading.then(
        () => shares.delete(key),
        () => {
          shares.delete(key);
          // A failed read is tried again the next time.
          cache.delete(key);
        },
      );
    }
    loading.then(
      (loaded) => live && setState({ loaded }),
      (error: unknown) =>
        live && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [hostId, runId, path, name, kind, loads, read]);
  return { ...state, progress: state.loaded || state.error ? undefined : share };
}

/** Saves `bytes` as `name` through the browser's download, which asks where. */
export function download(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `bytes` as a blob: URL for an `<img>` or `<video>`, revoked when they change or unmount. */
export function useObjectUrl(bytes?: Uint8Array): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!bytes) return;
    const made = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    setUrl(made);
    return () => {
      URL.revokeObjectURL(made);
      setUrl(undefined);
    };
  }, [bytes]);
  return url;
}

/** Page `n`, counted from 1, drawn `width` CSS pixels wide at the screen's density. */
export async function drawPdfPage(pdf: PDFDocumentProxy, n: number, width: number) {
  const page = await pdf.getPage(n);
  const scale = (width / page.getViewport({ scale: 1 }).width) * devicePixelRatio;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.display = "block";
  await page.render({ canvas, viewport }).promise;
  return canvas;
}
