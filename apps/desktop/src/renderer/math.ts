// Fixes for how remark-math reads LaTeX in agent messages (PLX-759).

// Text up to a blank line, which ends a paragraph and so any inline math or code span in it.
const INLINE = String.raw`(?:(?!\n[ \t]*\n)[^])`;

// What's kept as it is, since Markdown doesn't process escapes in it: a fenced code block at any
// indent (to its closing fence or the end), an indented code block, a URL, or a code span.
// ponytail: an indented block after a blank line counts as code even when it's a list item's
// paragraph, which then keeps remark-math's own reading of its dollars.
const KEPT = [
  String.raw`(?:^|\n)[ \t]*(\`{3,}|~{3,})[^]*?(?:\n[ \t]*\1|$)`,
  String.raw`(?:^|\n[ \t]*\n)(?: {4}|\t)(?:[^\n]|\n(?:[ \t]*\n)*(?: {4}|\t))*`,
  String.raw`(?:https?:\/\/|www\.)[^\s<>]*|<[A-Za-z][\w+.-]*:[^\s<>]*>`,
  String.raw`(\`+)${INLINE}*?\2(?!\`)`,
];

// \(...\). It reads a backslash with the character after it, and doesn't run past another of its
// openers, which keeps unclosed ones from rescanning a paragraph.
const PARENS = String.raw`\\\(((?:\\[^()\n]|(?!\n[ \t]*\n)[^\\])+?)\\\)`;

// What dollarMath reads, in order at each position: what's kept, then $$...$$ (one opening a line
// may run to the end, as a streaming one does), \[...\], \(...\), an escaped character, a $...$
// pair as Pandoc reads one (no space just inside either dollar, no digit right after the closing
// one), or a lone dollar.
const TOKENS = new RegExp(
  [
    ...KEPT,
    String.raw`(?:^|\n)[ \t]*\$\$[^]*?(?:\$\$|$)|\$\$${INLINE}*?\$\$`,
    // As PARENS reads its own, so \\[2pt] is a line break.
    String.raw`\\\[((?:\\[^[\]\n]|(?!\n[ \t]*\n)[^\\])+?)\\\]`,
    PARENS,
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

// What mathSource reads in what dollarMath returns: what's kept, then the math. That's a \(...\)
// left for the dollar in it, `$$...$$` (to the end, while one is still arriving), or `$...$`: by
// then every dollar left unescaped is math's. A pair never takes in a backtick, since a code
// span comes before math, as in "$5 and `$x`". An escaped character stays as it is.
const MATH = new RegExp(
  [
    ...KEPT,
    `(${PARENS}|${String.raw`\$\$[^]*?(?:\$\$|$)|\$(?:\\[^]|(?!\n[ \t]*\n)[^\\$\`])*\$`})`,
    String.raw`\\[^]`,
  ].join("|"),
  "g",
);

/**
 * What `dollarMath` returns with its math as plain text, for when math isn't typeset (Settings >
 * Appearance > Chat's Render math, PLX-1519): each `$...$` and `$$...$$` shows as written, dollars
 * included, since every character Markdown could read as syntax is escaped (`$a*b*c$` keeps its
 * asterisks, `\{` and `\\` their backslashes) and its lines break where the source's do. Code,
 * URLs, and the text around the math stay as they are.
 */
export const mathSource = (text: string): string =>
  /[$\\]/.test(text)
    ? text.replace(MATH, (match, _fence, _ticks, math?: string) =>
        math === undefined
          ? match
          : math
              .replace(/[!-/:-@[-`{-~]/g, "\\$&")
              // A hard line break, which a paragraph's last line can't end with.
              .replace(/\n(?![ \t]*(?:\n|$))/g, "\\\n"),
      )
    : text;
