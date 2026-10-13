import { strFromU8, unzipSync } from "fflate";

/**
 * The shared parts of the Office files the side panel opens (PLX-755): a .docx, .xlsx, or .pptx is
 * a zip of XML parts, linked by `_rels` files. Each format module reads the parts it shows.
 */

/** A package's parts by path, such as `word/document.xml`. */
export type Parts = Record<string, Uint8Array>;

export const unzip = (bytes: Uint8Array): Parts => unzipSync(bytes);

/** The XML part at `path`, parsed, or undefined when it's missing or isn't XML. */
export function readXml(parts: Parts, path: string): Document | undefined {
  const bytes = parts[path];
  if (!bytes) return undefined;
  const doc = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  return doc.getElementsByTagName("parsererror").length ? undefined : doc;
}

/** `el`'s child elements, only those named `name` (with its prefix, as `w:p`) when given. */
export const kids = (el: Element | null | undefined, name?: string): Element[] =>
  el ? [...el.children].filter((c) => !name || c.nodeName === name) : [];

/** `el`'s first child element named `name`. */
export const kid = (el: Element | null | undefined, name: string): Element | undefined =>
  el ? [...el.children].find((c) => c.nodeName === name) : undefined;

/** The first element named `name` at any depth under `el`. */
export const find = (el: Element | Document | null | undefined, name: string) =>
  el?.getElementsByTagName(name)[0] as Element | undefined;

/** The `w:val`-style attribute `name` of `el`'s child `child`. */
export const val = (el: Element | null | undefined, child: string, name = "w:val") =>
  kid(el, child)?.getAttribute(name) ?? undefined;

/** The folder a part is in, such as `word` for `word/document.xml`. */
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** The parts `part`'s relationships name, by id, as paths in the package. */
export function rels(parts: Parts, part: string): Map<string, string> {
  const doc = readXml(parts, `${folderOf(part)}_rels/${part.slice(folderOf(part).length)}.rels`);
  const found = new Map<string, string>();
  for (const rel of doc ? [...doc.getElementsByTagName("Relationship")] : []) {
    const target = rel.getAttribute("Target");
    if (!target || rel.getAttribute("TargetMode") === "External") continue;
    // Targets are relative to the part's folder, or absolute from the package's root.
    const path = new URL(target, `http://package/${folderOf(part)}`).pathname.slice(1);
    found.set(rel.getAttribute("Id") ?? "", decodeURIComponent(path));
  }
  return found;
}

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** The image part at `path` as a data: URL, which the renderer's CSP allows, or undefined. */
export function imageUrl(parts: Parts, path: string | undefined): string | undefined {
  const bytes = path ? parts[path] : undefined;
  const type = imageTypes[path?.split(".").pop()?.toLowerCase() ?? ""];
  return bytes && type ? `data:${type};base64,${toBase64(bytes)}` : undefined;
}

/** `bytes` in standard base64, in chunks, since one call can't spread megabytes of arguments. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Office's units: twentieths of a point (twips) and English Metric Units, as CSS pixels. */
export const twipsToPx = (twips: number) => twips / 15;
export const emuToPx = (emu: number) => emu / 9525;
