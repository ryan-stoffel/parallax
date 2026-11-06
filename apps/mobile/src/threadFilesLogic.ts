// The Files sheet's pure pieces: a folder's order, paths in a thread's folder, and a file's bytes as
// lines of text. Pure, for the test.
import type { AgentEntry } from "../../desktop/src/protocol/generated/protocol";

/** Folders first, then by name, as the desktop's FilesPanel lists them. */
export const inOrder = (entries: readonly AgentEntry[]): AgentEntry[] =>
  [...entries].sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || (a.name < b.name ? -1 : 1));

export const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `base64`'s bytes as text, or undefined when they're binary: they hold a NUL or aren't UTF-8. */
export function textOf(base64: string): string | undefined {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The most characters one row of a file holds, so a minified line can't make one huge text view. */
const longestRow = 2000;

/** `text`'s rows to draw: its lines, without a last empty one, and any very long line in pieces. */
export function linesOf(text: string): string[] {
  if (!text) return [];
  const rows: string[] = [];
  for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/))
    for (let at = 0; at === 0 || at < line.length; at += longestRow) rows.push(line.slice(at, at + longestRow));
  return rows;
}
