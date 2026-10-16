import { useEffect, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import type { RpcError } from "../preload/bridge";
import { openDocx, type Docx } from "./docx";
import { describeError } from "./errors";
import { fromBase64 } from "./ooxml";
import { openPptx, type Pptx } from "./pptx";
import { openXlsx, type Xlsx } from "./xlsx";

/**
 * Documents an agent presented with `present_files` (PLX-755) or linked in a message (PLX-834):
 * read from its thread's folder through `agent/file`, opened by type, and shared by the
 * transcript's cards and the side panel until a newer presentation reloads them.
 */

import { isMedia, type DocKind, type DocRef, type MediaKind } from "./transcript";

export type { DocKind, DocRef };

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

/** `bytes` as a size people read: 512 bytes, 12 KB, 3.4 MB. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

async function load(hostId: string, doc: DocRef): Promise<Loaded> {
  const answer = await window.parallax.request(hostId, "agent/file", {
    runId: doc.runId,
    path: doc.path,
    side: "working",
  });
  if ("error" in answer) throw new Error(await failure(hostId, answer.error));
  const file = answer.result;
  if (!file.exists) throw new Error("This file isn't in the thread's folder anymore.");
  if (file.tooLarge || file.content == null)
    throw new Error("This file is too large to open here.");
  const bytes = fromBase64(file.content);
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

/** `doc` from `hostId`, opened, and opened again when a newer presentation reloads it. */
export function useDocument(hostId: string, doc: DocRef) {
  const loads = useSyncExternalStore(subscribe, () => version);
  const [state, setState] = useState<{ loaded?: Loaded; error?: string }>({});
  const { runId, path, name, kind } = doc;
  useEffect(() => {
    let live = true;
    const ref = { runId, path, name, kind };
    const key = keyOf(hostId, ref);
    let loading = cache.get(key);
    if (!loading) {
      loading = load(hostId, ref);
      cache.set(key, loading);
      // A failed read is tried again the next time.
      loading.catch(() => cache.delete(key));
    }
    loading.then(
      (loaded) => live && setState({ loaded }),
      (error: unknown) =>
        live && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [hostId, runId, path, name, kind, loads]);
  return state;
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
