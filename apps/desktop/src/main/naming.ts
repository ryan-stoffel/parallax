import type { ThreadName } from "../preload/bridge";

const maxWords = 4;
const maxSlugLength = 40;

/**
 * A branch name from `text`: its first four words, lowercase, joined by hyphens. Matches wispd's
 * `branchSlug` rules. Undefined when `text` has no letters or digits.
 */
export function slugify(text: string): string | undefined {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slug = words.slice(0, maxWords).join("-").slice(0, maxSlugLength).replace(/-+$/, "");
  return slug || undefined;
}

/** A model's reply as a title. Undefined when it isn't one, such as a chatty answer. */
export function cleanTitle(reply: string): string | undefined {
  const title = reply
    .trim()
    .split("\n")[0]!
    .replace(/^["'\s]+|["'.\s]+$/g, "");
  const words = title.split(/\s+/).length;
  return title && words <= 8 && !/[?!]/.test(title) ? title : undefined;
}

/** What a thread is named without the model: no title, and a branch from the prompt's words. */
export function fallbackName(prompt: string): ThreadName {
  return { slug: slugify(prompt) };
}
