import { useEffect, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { openDocx, type Docx } from "./docx";
import { describeError } from "./errors";
import { fromBase64, toBase64 } from "./ooxml";
import { openPptx, type Pptx } from "./pptx";
import { openXlsx, type Xlsx } from "./xlsx";

/**
 * Documents an agent presented with `present_files` (PLX-755): read from its thread's folder
 * through `agent/file`, opened by type, and shared by the transcript's cards and the side panel
 * until a save reloads them.
 */

export type DocKind = "docx" | "xlsx" | "pptx" | "pdf";

/** A presented file: its run, its path in the run's folder, its name, and its type. */
export interface DocRef {
  runId: string;
  path: string;
  name: string;
  kind: DocKind;
}

export type Opened =
  | { kind: "docx"; docx: Docx }
  | { kind: "xlsx"; xlsx: Xlsx }
  | { kind: "pptx"; pptx: Pptx }
  | { kind: "pdf"; pdf: PDFDocumentProxy };

export interface Loaded {
  bytes: Uint8Array;
  opened: Opened;
}

export const kinds: Record<DocKind, { label: string; editable: boolean }> = {
  docx: { label: "Document", editable: true },
  pdf: { label: "Document", editable: false },
  xlsx: { label: "Spreadsheet", editable: true },
  pptx: { label: "Presentation", editable: false },
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
          : { kind: "pdf", pdf: await openPdf(bytes) };
  return { bytes, opened };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** `doc` from `hostId`, opened, and opened again after each save. */
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

/**
 * Saves `bytes` over `doc` with `agent/fileWrite`, then reloads it everywhere it shows. Answers
 * why it failed, or undefined.
 */
export async function writeDocument(
  hostId: string,
  doc: DocRef,
  bytes: Uint8Array,
): Promise<string | undefined> {
  const answer = await window.parallax.request(hostId, "agent/fileWrite", {
    runId: doc.runId,
    path: doc.path,
    content: toBase64(bytes),
  });
  if ("error" in answer) return describeError(answer.error).replace(/^Invalid params: /, "");
  cache.delete(keyOf(hostId, doc));
  version++;
  for (const listener of listeners) listener();
  return undefined;
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

/** The message that tells the thread the user saved an edit, with what changed. */
export function savedMessage(doc: DocRef, changes: string[]): string {
  const what = changes.length
    ? changes.map((line) => `- ${line}`).join("\n")
    : "- Formatting only; no text changed.";
  return [
    `I edited \`${doc.path}\` in Parallax and saved it.`,
    what,
    "Acknowledge the edit in a sentence or two. If you made other files from this one, such as a PDF of it, rebuild them and present them again.",
  ].join("\n\n");
}
