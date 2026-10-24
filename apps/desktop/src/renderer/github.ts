// A pull request's Markdown as GitHub writes it, for the desktop's PR panel and the mobile app's:
// which images are GitHub's, its HTML images as Markdown ones, and a screenshot's name. Pure.

/** Whether `src` is on GitHub's image hosts, the only remote images the app's CSP loads. */
export const onGithub = (src: unknown): src is string =>
  typeof src === "string" && /^https:\/\/(github\.com|[\w-]+\.githubusercontent\.com)\//.test(src);

/**
 * GitHub's Markdown with each HTML `<img>`, as GitHub writes a dropped screenshot, as a Markdown
 * image, since Markdown here renders no HTML. Code, fenced or inline, stays as written. ponytail:
 * regexes, not a Markdown or HTML parser; they miss an `<img>` whose attributes hold a `>`, and
 * code fenced by more than three marks.
 */
export function githubText(body: string): string {
  return body
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : images(part)))
    .join("");
}

const images = (text: string) =>
  text.replace(/<img\b[^>]*>/gi, (tag) => {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];
    const src = attr("src");
    return src ? `![${(attr("alt") ?? "").replace(/[[\]]/g, "")}](${src})` : tag;
  });

/** A screenshot's name: its alt text, or without a useful one, its file's name. */
export function shotName(src: string, alt: string): string {
  if (alt.trim() && alt.trim().toLowerCase() !== "image") return alt.trim();
  return decodeURIComponent(new URL(src).pathname.split("/").at(-1) || "Screenshot");
}
