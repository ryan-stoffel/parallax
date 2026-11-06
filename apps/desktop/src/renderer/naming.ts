const maxWords = 4;
const maxSlugLength = 40;

/**
 * A branch name from `text`: its first four words, lowercase, joined by hyphens. Matches plxd's
 * `branchSlug` rules. Undefined when `text` has no letters or digits. A new thread starts on it,
 * until the host's plxd names the thread and renames its branch (0058).
 */
export function slugify(text: string): string | undefined {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slug = words.slice(0, maxWords).join("-").slice(0, maxSlugLength).replace(/-+$/, "");
  return slug || undefined;
}
