// Fixes for how remark-math reads LaTeX in agent messages (PLX-759).

// A fenced code block, to its closing fence or the end, or a code span; then \[...\] or \(...\).
const CODE_OR_TEX =
  /(?:^|\n) {0,3}(`{3,}|~{3,})[^]*?(?:\n {0,3}\1|$)|(`+)[^]*?\2|\\\[([^]+?)\\\]|\\\(([^]+?)\\\)/g;

/**
 * Rewrites `\[...\]` as `$$...$$` and `\(...\)` as `$...$`, outside code, since remark-math reads
 * only dollars and Markdown's escapes would otherwise eat the backslashes. Unclosed delimiters, as
 * a streaming message has, stay as they are until they close.
 */
export const dollarMath = (text: string): string =>
  text.includes("\\")
    ? text.replace(CODE_OR_TEX, (match, _fence, _ticks, display?: string, inline?: string) =>
        display !== undefined
          ? `$$${display}$$`
          : inline !== undefined
            ? `$${inline.trim()}$`
            : match,
      )
    : text;

type MathNode = {
  type: string;
  value?: string;
  children?: MathNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: { className?: string[] } };
};

/**
 * A remark plugin, after remark-math, for how models write dollars. `$$...$$` within a line is
 * display math, since they write display equations that way. A `$...$` pair is math only as
 * Pandoc reads it: no space just inside either dollar and no digit right after the closing one,
 * so "$5 and $10" and "$PATH and $HOME" stay text.
 */
export function dollarRules() {
  return (tree: MathNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: MathNode) =>
      node.children?.forEach((child, i, siblings) => {
        if (child.type !== "inlineMath") return walk(child);
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const raw = source.slice(start, end);
        if (raw.startsWith("$$")) {
          const props = child.data?.hProperties;
          if (props) props.className = ["language-math", "math-display"];
        } else if (/^\$\s|\s\$$/.test(raw) || /\d/.test(source[end] ?? "")) {
          siblings[i] = { type: "text", value: raw };
        }
      });
    walk(tree);
  };
}
