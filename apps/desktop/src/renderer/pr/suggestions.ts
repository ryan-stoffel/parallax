// GitHub's suggestion blocks in a review comment: finding them, and what they change. Pure.

import { parseDiff, type DiffLine } from "../parseDiff";

/** A review comment's body as Markdown and suggestions, in order. */
export type BodyPart = { markdown: string } | { suggestion: string[] };

/** `body` split around its ```` ```suggestion ```` fences. An empty fence suggests deleting. */
export function splitSuggestions(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  const fence = /^(`{3,}|~{3,})suggestion[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??\1[ \t]*$/gm;
  let last = 0;
  for (const m of body.matchAll(fence)) {
    const before = body.slice(last, m.index).trim();
    if (before) parts.push({ markdown: before });
    parts.push({ suggestion: m[2] === undefined ? [] : m[2].split(/\r?\n/) });
    last = m.index + m[0].length;
  }
  const rest = body.slice(last).trim();
  if (rest) parts.push({ markdown: rest });
  return parts;
}

/** The new-side lines at the end of a thread's diff hunk: the `count` lines a suggestion replaces. */
export function linesUnderThread(hunk: string | undefined, count: number): string[] {
  if (!hunk) return [];
  const lines = hunk
    .split("\n")
    .filter((l) => !l.startsWith("@@") && !l.startsWith("-"))
    .map((l) => l.slice(1));
  return lines.slice(-count);
}

/** A suggestion as diff lines from `before` to `after`, numbered from `start`, words marked. */
export function suggestionLines(before: string[], after: string[], start: number): DiffLine[] {
  const diff = [
    "diff --git a/s b/s",
    "+++ b/s",
    `@@ -${start},${before.length} +${start},${after.length} @@`,
    ...before.map((l) => `-${l}`),
    ...after.map((l) => `+${l}`),
  ].join("\n");
  return parseDiff(diff)[0]!.lines.filter((l) => l.op !== "@");
}

/** A block to start a suggestion from `lines`, with a blank line before it after other text. */
export function suggestionBlock(lines: readonly string[], textBefore: string) {
  const lead =
    textBefore && !textBefore.endsWith("\n\n") ? (textBefore.endsWith("\n") ? "\n" : "\n\n") : "";
  return `${lead}\`\`\`suggestion\n${lines.join("\n")}\n\`\`\`\n`;
}
