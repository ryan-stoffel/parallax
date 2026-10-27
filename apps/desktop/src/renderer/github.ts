// A pull request's Markdown as GitHub writes it, for the desktop's PR panel and the mobile app's:
// which images load, its HTML images as Markdown ones, and a screenshot's name. Pure.

/** A pull request's number, from its URL. */
export const numberOf = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? "?";

/** A GitHub pull request link's number, on any of its tabs, or undefined for any other link. */
export const prNumber = (url: string) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#]|$)/i.exec(url)?.[1];

/**
 * Whether `src` is an https image, which a pull request's Markdown loads wherever it's hosted, as
 * GitHub shows it. The text is already public on GitHub, so loading it reveals only the viewer's
 * IP to the image's host.
 */
export const isHttps = (src: unknown): src is string =>
  typeof src === "string" && /^https:\/\/[^/]/i.test(src);

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
