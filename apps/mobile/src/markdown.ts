// Markdown's tokens as ui.tsx draws them: marked's, with LaTeX read from the delimiters the
// desktop accepts (math.ts rewrites \(...\) and \[...\] to dollars and escapes a lone dollar), and
// a code block's simple syntax colors. Pure, for the test.
import { Marked, type Token, type TokenizerExtension } from "marked";

import { dollarMath } from "../../desktop/src/renderer/math";

/** LaTeX: `$$...$$` is display math, centered on its own line, and `$...$` sits in the text. */
export interface MathToken {
  type: "math";
  raw: string;
  text: string;
  display: boolean;
}

// $$...$$ opening a line and closing one: a block of its own, whatever Markdown its lines look like.
const blockMath: TokenizerExtension = {
  name: "math",
  level: "block",
  start: (src) => /^ {0,3}\$\$/m.exec(src)?.index,
  tokenizer(src) {
    const match = /^ {0,3}\$\$([^]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (match) return { type: "math", raw: match[0], text: match[1]!.trim(), display: true };
  },
};

// $$...$$ within a paragraph, displayed as the desktop's displayDoubleDollar does, or $...$.
const inlineMath: TokenizerExtension = {
  name: "math",
  level: "inline",
  start: (src) => {
    const at = src.indexOf("$");
    return at < 0 ? undefined : at;
  },
  tokenizer(src) {
    const match = /^\$\$([^]+?)\$\$/.exec(src) ?? /^\$((?:\\[^]|[^\\$])+?)\$/.exec(src);
    if (match)
      return {
        type: "math",
        raw: match[0],
        text: match[1]!.trim(),
        display: match[0].startsWith("$$"),
      };
  },
};

const marked = new Marked({ gfm: true, extensions: [blockMath, inlineMath] });

/** `text`'s Markdown tokens, its LaTeX as `MathToken`s. */
export const lex = (text: string): Token[] => marked.lexer(dollarMath(text));

/**
 * The path a link names when it's a file rather than a web page, as the desktop's `linkedPath`:
 * relative, absolute, or a `file:` URL, decoded, with `/` between folders. Undefined for any other
 * scheme, a link within the page, or another computer's file.
 */
export function linkedPath(href?: string): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("//")) return undefined;
  const drive = /^[a-z]:(?:[\\/]|%5c)/i;
  let path = href;
  if (/^file:/i.test(href)) {
    const url = /^file:\/\/([^/]*)(\/[^?#]*)/i.exec(href);
    if (!url || (url[1] && url[1] !== "localhost")) return undefined;
    path = url[2]!.replace(/^\/(?=[a-z]:)/i, "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !drive.test(href)) return undefined;
  else path = href.replace(/[?#][^]*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray %, kept as written.
  }
  return path.replaceAll("\\", "/");
}

/** A highlighted piece of code: its text and its kind, which picks its color. */
export type Piece = { text: string; kind?: "keyword" | "string" | "number" | "title" | "type" | "comment" };

// Languages whose comments start with #.
const hashComments = new Set(["sh", "bash", "zsh", "shell", "console", "python", "py", "ruby", "rb", "yaml", "yml", "toml", "r", "perl", "make", "makefile", "dockerfile", "nix", "elixir", "ex", "graphql", "ini", "conf"]);
// Languages whose comments start with --.
const dashComments = new Set(["sql", "lua", "haskell", "hs", "elm"]);
// Keywords of the languages agents write most, one set for all of them.
const keywords = new Set(
  "abstract as async await break case catch class const continue def default defer del do elif else enum except export extends false fi final finally fn for from func function go if impl implements import in interface is lambda let loop match mod module mut new nil none null of package pass pub raise return self static struct super switch then this throw true try type typeof undefined use var void when where while with yield".split(" "),
);

/**
 * `code` in pieces for simple syntax colors, as the desktop's highlighting colors them: comments,
 * strings, numbers, keywords, function names, and capitalized type names. Never a full grammar,
 * so only a fence naming its language is colored. A diff has none: ui.tsx colors its lines.
 */
export function highlight(code: string, language?: string): Piece[] {
  if (!language || language === "diff" || language === "patch" || language === "text") return [{ text: code }];
  const lang = language.toLowerCase();
  const comment = hashComments.has(lang)
    ? String.raw`#[^\n]*`
    : dashComments.has(lang)
      ? String.raw`--[^\n]*`
      : String.raw`\/\/[^\n]*|\/\*[^]*?\*\/`;
  // ponytail: one tokenizer for every language, so a keyword of one colors in another; a grammar
  // per language if that ever matters.
  const pattern = new RegExp(
    String.raw`(${comment})|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\`(?:\\.|[^\`\\])*\`)|(\b\d[\d_.]*(?:e[+-]?\d+)?[a-z]*\b|\b0x[\da-f]+\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)`,
    "gi",
  );
  const pieces: Piece[] = [];
  let at = 0;
  for (const m of code.matchAll(pattern)) {
    const [text, isComment, isString, isNumber, isCall, word] = m;
    const kind: Piece["kind"] = isComment
      ? "comment"
      : isString
        ? "string"
        : isNumber
          ? "number"
          : keywords.has((isCall ?? word)!)
            ? "keyword"
            : isCall
              ? "title"
              : /^[A-Z][a-z]/.test(word!)
                ? "type"
                : undefined;
    if (!kind) continue;
    if (m.index > at) pieces.push({ text: code.slice(at, m.index) });
    pieces.push({ text, kind });
    at = m.index + text.length;
  }
  if (at < code.length) pieces.push({ text: code.slice(at) });
  return pieces;
}
