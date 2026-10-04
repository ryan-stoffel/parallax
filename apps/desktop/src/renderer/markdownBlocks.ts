import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// The parser MarkdownText renders with (react-markdown runs remark-parse and its remark plugins),
// without the HTML, highlighting, and React steps after it.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/**
 * The length from which a streaming message renders block by block. Measured in the built app,
 * a shorter one renders whole about as fast, so it skips the split's parse.
 */
export const SPLIT_FROM = 1_000;

// A blank line: Markdown counts only spaces and tabs as blank.
const BLANK_LINE = /\n[ \t]*\r?\n/;

type Tree = { type: string; children?: Tree[] };

/** Whether a tree holds a link or footnote definition, which any block can use. */
const defines = (node: Tree): boolean =>
  node.type === "definition" ||
  node.type === "footnoteDefinition" ||
  (node.children?.some(defines) ?? false);

/**
 * Splits Markdown into blocks that each render on their own exactly as they do in the whole
 * text. Joined, the blocks are the text. A streaming message renders them one by one, so only
 * its last, growing block goes through the whole render (PLX-448).
 *
 * The split points come from the renderer's own parser, so fences, lists, and line endings mean
 * the same here as there: the starts of the lines that begin top-level nodes, where a blank line
 * comes between them and neither is raw HTML. Text with a definition isn't split, since a
 * definition reaches every block.
 *
 * `previous` is this function's blocks for an earlier text. When `text` extends it, as a
 * streaming message grows, all but its last two blocks are kept and only the rest is parsed.
 * Markdown is parsed line by line and appending changes only the last line, so it can't move a
 * split point whose next block's first line is complete: one before a block another follows.
 */
export function markdownBlocks(text: string, previous: string[] = []): string[] {
  const blocks = text.startsWith(previous.join("")) ? previous.slice(0, -2) : [];
  const rest = text.slice(blocks.join("").length);
  const tree = parser.parse(rest);
  if (defines(tree)) return [text];
  let start = 0;
  tree.children.forEach((node, i) => {
    const before = tree.children[i - 1];
    if (!before || before.type === "html" || node.type === "html") return;
    const end = before.position!.end.offset!;
    // The start of its line, so an indented node keeps its indent, which a fence strips.
    const line = rest.lastIndexOf("\n", node.position!.start.offset! - 1) + 1;
    if (!BLANK_LINE.test(rest.slice(end, line))) return;
    blocks.push(rest.slice(start, line));
    start = line;
  });
  blocks.push(rest.slice(start));
  return blocks;
}
