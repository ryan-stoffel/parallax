// What a transcript's Markdown links, for the desktop's MarkdownText (AgentChat.tsx) and the
// phone's (apps/mobile ui.tsx), both drawn by Enriched Markdown: inline code that names a file,
// which its link recognition makes a link to it, and the images that stay links. Pure, for the test.

/**
 * Inline code that names a file, after T3 Code's pattern: a path that starts at `./`,
 * `../`, `~/`, a drive, or a top-level folder of macOS or Linux, or a relative path with a folder and
 * an extension that starts with a letter, each with an optional `:line:column`. Never a URL, or a
 * host and port such as `127.0.0.1:8080`. It must be valid for iOS's NSRegularExpression and
 * Android's java.util.regex as well as JavaScript.
 */
export const filePath =
  /^(?!\S*:\/\/)(?:(?:\.{1,2}[\\/]|~[\\/]|\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|private|root|usr|bin|sbin|lib|srv|run|media|workspace|workspaces)\/|[A-Za-z]:[\\/])[^\s`]+|(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z][A-Za-z0-9_-]*(?::\d+){0,2})$/;

/** A link's target without the `:line:column` a recognized file path may end in. */
export const fileReference = (href: string) =>
  href.includes("://") ? href : href.replace(/(?::\d+){1,2}$/, "");

// A fenced code block, or a code span, whose text is never Markdown.
const code = /^ {0,3}(`{3,}|~{3,})[^]*?^ {0,3}\1[ \t]*$|(`+)[^`][^]*?\2/gm;
const image = /!\[([^\]]*)\]\((\s*<?)([^\s)>]+)/g;

/**
 * `markdown` with each image whose URL `shown` refuses written as a link to it, with its alt text,
 * as the desktop's transcript shows one, so it never loads and still reads. Code is left as written.
 */
export function unloadedImages(markdown: string, shown: (url: string) => boolean): string {
  const links = (text: string) =>
    text.replace(image, (all, alt: string, open: string, url: string) =>
      shown(url) ? all : `[${alt || "Image"}](${open}${url}`,
    );
  let out = "";
  let at = 0;
  for (const m of markdown.matchAll(code)) {
    out += links(markdown.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + links(markdown.slice(at));
}
