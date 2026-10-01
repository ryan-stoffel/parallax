import type { ThreadName } from "../preload/bridge";

const maxWords = 4;
const maxTitleWords = 6;
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

/**
 * A thread's name from the model's reply, `Title: ...` then `Branch: ...` (see namer.ts). The
 * title keeps its first six words. Undefined when the reply isn't in that shape.
 */
export function parseName(reply: string): ThreadName | undefined {
  const match = /^Title: (.+)\nBranch: (.+)$/.exec(reply.trim());
  if (!match) return undefined;
  const title = match[1]!
    .split(/\s+/)
    .slice(0, maxTitleWords)
    .join(" ")
    .replace(/[\s.'-]+$/, "");
  const slug = slugify(match[2]!);
  return slug ? { title, slug } : undefined;
}

/** What a thread is named without the model: no title, and a branch from the prompt's words. */
export function fallbackName(prompt: string): ThreadName {
  return { slug: slugify(prompt) };
}
