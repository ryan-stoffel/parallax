import { useEffect, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { openDocx, type Docx } from "./docx";
import { describeError } from "./errors";
import { fromBase64 } from "./ooxml";
import { openPptx, type Pptx } from "./pptx";
import { openXlsx, type Xlsx } from "./xlsx";

/**
 * Documents an agent presented with `present_files` (PLX-755): read from its thread's folder
 * through `agent/file`, opened by type, and shared by the transcript's cards and the side panel
 * until a newer presentation reloads them.
 */

import type { DocKind, DocRef } from "./transcript";

export type { DocKind, DocRef };

export type Opened =
  | { kind: "docx"; docx: Docx }
  | { kind: "xlsx"; xlsx: Xlsx }
  | { kind: "pptx"; pptx: Pptx }
  /** A PDF, with its first page's height over its width. */
  | { kind: "pdf"; pdf: PDFDocumentProxy; ratio: number };

export interface Loaded {
  bytes: Uint8Array;
  opened: Opened;
}

export const kinds: Record<DocKind, string> = {
  docx: "Document",
  pdf: "Document",
  xlsx: "Spreadsheet",
  pptx: "Presentation",
};

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

async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // pdf.js takes the buffer over, and the download keeps it.
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

async function load(hostId: string, doc: DocRef): Promise<Loaded> {
  const answer = await window.parallax.request(hostId, "agent/file", {
    runId: doc.runId,
    path: doc.path,
    side: "working",
  });
  if ("error" in answer) throw new Error(describeError(answer.error));
  const file = answer.result;
  if (!file.exists) throw new Error("This file isn't in the thread's folder anymore.");
  if (file.tooLarge || file.content == null)
    throw new Error("This file is too large to open here.");
  const bytes = fromBase64(file.content);
  const opened: Opened =
    doc.kind === "docx"
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
