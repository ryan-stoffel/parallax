// Syntax colors for a diff's lines, one line at a time, as `.hljs-*` spans. A line on its own can't
// know it's inside a multi-line comment or string, which a diff often cuts into anyway.

import { common, createLowlight } from "lowlight";

/** A run of a line's text, with its `hljs-*` classes and whether a word diff marks it. */
export type Token = { text: string; cls?: string; marked?: boolean };

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  properties?: { className?: string[] };
};

const lowlight = createLowlight(common);

/** Lines already colored, since rows come and go as the diff scrolls. */
const seen = new Map<string, Token[]>();
const MAX_SEEN = 20_000;

/** The language to color `path` as, by its extension, when one is known. */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const at = name.lastIndexOf(".");
  const ext = at > 0 ? name.slice(at + 1).toLowerCase() : "";
  return ext && lowlight.registered(ext) ? ext : undefined;
}

function flatten(nodes: Node[], classes: string[], into: Token[]) {
  for (const node of nodes) {
    if (node.type === "text" && node.value) {
      into.push({ text: node.value, ...(classes.length ? { cls: classes.join(" ") } : {}) });
    } else if (node.children) {
      flatten(node.children, [...classes, ...(node.properties?.className ?? [])], into);
    }
  }
}

/** `text`'s runs in `language`, or the whole line as one when it has none. */
export function lineTokens(language: string | undefined, text: string): Token[] {
  if (!language || !text) return [{ text }];
  const key = `${language}\0${text}`;
  const known = seen.get(key);
  if (known) return known;
  const tokens: Token[] = [];
  flatten(lowlight.highlight(language, text).children as Node[], [], tokens);
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.set(key, tokens);
  return tokens;
}

/** `tokens` cut at `mark`'s ends, the runs inside it marked, for a word diff over colored text. */
export function markTokens(tokens: readonly Token[], mark?: readonly [number, number]): Token[] {
  if (!mark) return tokens as Token[];
  const out: Token[] = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    for (const [from, to, marked] of [
      [at, Math.min(end, mark[0]), false],
      [Math.max(at, mark[0]), Math.min(end, mark[1]), true],
      [Math.max(at, mark[1]), end, false],
    ] as const) {
      if (from < to) out.push({ ...token, text: token.text.slice(from - at, to - at), marked });
    }
    at = end;
  }
  return out;
}
