// Fixes for how remark-math reads LaTeX in agent messages (PLX-759).

// Text up to a blank line, which ends a paragraph and so any inline math or code span in it.
const INLINE = String.raw`(?:(?!\n[ \t]*\n)[^])`;

// What dollarMath reads, in order at each position. Kept as they are, since Markdown doesn't
// process escapes in them: a fenced code block at any indent (to its closing fence or the end), an
// indented code block, a URL, or a code span. Then $$...$$ (one opening a line may run to the end,
// as a streaming one does), \[...\], \(...\), an escaped character, a $...$ pair as Pandoc reads
// one (no space just inside either dollar, no digit right after the closing one), or a lone dollar.
// ponytail: an indented block after a blank line counts as code even when it's a list item's
// paragraph, which then keeps remark-math's own reading of its dollars.
const TOKENS = new RegExp(
  [
    String.raw`(?:^|\n)[ \t]*(\`{3,}|~{3,})[^]*?(?:\n[ \t]*\1|$)`,
    String.raw`(?:^|\n[ \t]*\n)(?: {4}|\t)(?:[^\n]|\n(?:[ \t]*\n)*(?: {4}|\t))*`,
    String.raw`(?:https?:\/\/|www\.)[^\s<>]*|<[A-Za-z][\w+.-]*:[^\s<>]*>`,
    String.raw`(\`+)${INLINE}*?\2(?!\`)`,
    String.raw`(?:^|\n)[ \t]*\$\$[^]*?(?:\$\$|$)|\$\$${INLINE}*?\$\$`,
    // Each reads a backslash with the character after it, so \\[2pt] is a line break, and neither
    // runs past another of its openers, which keeps unclosed ones from rescanning a paragraph.
    String.raw`\\\[((?:\\[^[\]\n]|(?!\n[ \t]*\n)[^\\])+?)\\\]`,
    String.raw`\\\(((?:\\[^()\n]|(?!\n[ \t]*\n)[^\\])+?)\\\)`,
    String.raw`\\[^]`,
    String.raw`\$(?=[^\s$])(?:\\[^]|(?!\n[ \t]*\n)[^\\$])*?(?<=[^\s\\])\$(?!\d)`,
    String.raw`\$`,
  ].join("|"),
  "g",
);

/**
 * Prepares Markdown for remark-math, outside code: `\[...\]` becomes `$$...$$` and `\(...\)`
 * becomes `$...$`, since remark-math reads only dollars and Markdown's escapes would eat the
 * backslashes. A `\(...\)` holding a dollar stays, since remark-math ends inline math at any
 * dollar, even an escaped one. A dollar that can't pair as Pandoc reads it is escaped, so "$5 and
 * $10" and "$PATH and $HOME" stay text, with any Markdown between them intact. Code and URLs stay
 * as they are, and so do delimiters still arriving, as in a streaming message, until they close.
 */
export const dollarMath = (text: string): string =>
  /[$\\]/.test(text)
    ? text.replace(TOKENS, (match, _fence, _ticks, display?: string, inline?: string) =>
        display !== undefined
          ? `$$${display}$$`
          : inline !== undefined && !inline.includes("$")
            ? `$${inline.trim()}$`
            : match === "$"
              ? "\\$"
              : match,
      )
    : text;
