// The path a Markdown link names when it's a file, for ui.tsx.

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
