// Fixes for how remark-math reads LaTeX in agent messages (PLX-759).

// Text up to a blank line, which ends a paragraph and so any inline math or code span in it.
const INLINE = String.raw`(?:(?!\n[ \t]*\n)[^])`;

// What dollarMath reads, in order at each position: a fenced code block (to its closing fence or
// the end), a code span, $$...$$, \[...\], \(...\), an escaped character, a $...$ pair as Pandoc
// reads one (no space just inside either dollar, no digit right after the closing one), or a
// lone dollar.
const TOKENS = new RegExp(
  [
    String.raw`(?:^|\n) {0,3}(\`{3,}|~{3,})[^]*?(?:\n {0,3}\1|$)`,
    String.raw`(\`+)${INLINE}*?\2(?!\`)`,
    String.raw`\$\$[^]*?(?:\$\$|$)`,
    String.raw`\\\[(${INLINE}+?)\\\]`,
    String.raw`\\\((${INLINE}+?)\\\)`,
    String.raw`\\[^]`,
    String.raw`\$(?=[^\s$])(?:\\[^]|(?!\n[ \t]*\n)[^\\$])*?(?<=[^\s\\])\$(?!\d)`,
    String.raw`\$`,
  ].join("|"),
  "g",
);

/**
 * Prepares Markdown for remark-math, outside code: `\[...\]` becomes `$$...$$` and `\(...\)`
 * becomes `$...$`, since remark-math reads only dollars and Markdown's escapes would eat the
 * backslashes. A dollar that can't pair as Pandoc reads it is escaped, so "$5 and $10" and
 * "$PATH and $HOME" stay text, with any Markdown between them intact. Delimiters still arriving,
 * as in a streaming message, stay as they are until they close.
 */
export const dollarMath = (text: string): string =>
  /[$\\]/.test(text)
    ? text.replace(TOKENS, (match, _fence, _ticks, display?: string, inline?: string) =>
        display !== undefined
          ? `$$${display}$$`
          : inline !== undefined
            ? `$${inline.trim()}$`
            : match === "$"
              ? "\\$"
              : match,
      )
    : text;
