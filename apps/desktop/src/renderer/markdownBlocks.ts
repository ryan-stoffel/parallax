// An opening or closing code fence: up to three spaces, then three or more ` or ~.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A line that can't continue the block above a blank line: it starts at column 0, so it isn't
// indented code or a list item's continuation, and it isn't a list item, which would join a
// list above into one loose list.
const STARTS_BLOCK = /^(?![-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))\S/;
// Markdown that reaches across blank lines: link and footnote definitions, which any block can
// use, and raw HTML blocks that only end at their closing tag.
const CROSS_BLOCK = /^ {0,3}(?:\[[^\]]+\]:|<[!?]|<(?:pre|script|style|textarea)(?:[\s>]|$))/im;

/**
 * Splits Markdown at the top-level blank lines outside code fences where each block renders
 * exactly as it does in the whole text. Joined, the blocks are the text. A streaming message
 * renders them one by one, so only its last, growing block re-parses (PLX-448).
 */
export function markdownBlocks(text: string): string[] {
  if (CROSS_BLOCK.test(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let blank = false;
  // The open fence's run of ` or ~, which a run as long of the same character closes.
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const run = FENCE.exec(line);
    if (fence) {
      const [, marks = "", rest = ""] = run ?? [];
      if (marks[0] === fence[0] && marks.length >= fence.length && !rest.trim()) fence = undefined;
    } else {
      if (blank && offset > start && STARTS_BLOCK.test(line)) {
        blocks.push(text.slice(start, offset));
        start = offset;
      }
      // A backtick fence's info string can't hold a backtick; then it's inline code.
      if (run && !(run[1]!.startsWith("`") && run[2]!.includes("`"))) fence = run[1];
    }
    blank = !line.trim();
    offset += line.length + 1;
  }
  blocks.push(text.slice(start));
  return blocks;
}
