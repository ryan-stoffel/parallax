// The sidebar's repo filter and search (PLX-789).
import { stored } from "./stored";

/**
 * What the sidebar lists: every thread, one repo entry, or the threads with no repo. A repo is
 * named by its host and id. An area (0073) is a scope from when they showed, which lists every
 * thread now (0075).
 */
export type Scope = "all" | "none" | `area:${string}/${string}` | `repo:${string}/${string}`;

// Before areas, the Repos filter kept a repo as `host/id`, in its own key, as plain text.
function legacyScope(): Scope {
  try {
    const old = localStorage.getItem("parallax:repoFilter");
    if (old === "none") return "none";
    if (old && old !== "all" && old.includes("/")) return `repo:${old}` as Scope;
  } catch {
    // Storage is off.
  }
  return "all";
}

const isScope = (raw: unknown): raw is Scope =>
  raw === "all" || raw === "none" || (typeof raw === "string" && /^(area|repo):[^/]+\/./.test(raw));

/** The scope the sidebar shows, kept on this computer. */
export const scopeStore = stored<Scope>("parallax:scope", legacyScope(), (raw, fallback) =>
  isScope(raw) ? raw : fallback,
);

/** A scope's kind, host, and id. */
export function parseScope(scope: Scope) {
  if (scope === "all" || scope === "none") return { kind: scope } as const;
  const [kind, rest] = scope.split(/:(.*)/s) as ["area" | "repo", string];
  const slash = rest.indexOf("/");
  return { kind, hostId: rest.slice(0, slash), id: rest.slice(slash + 1) } as const;
}

/**
 * Where ⌥↓ (`step` 1) or ⌥↑ (-1) goes among `keys`, the rows that need the user in one fixed
 * order, from `current`: the next one, wrapping, so repeated jumps reach every one. From a row
 * not in the list, Down starts at the first and Up at the last.
 */
export function jumpTarget(keys: readonly string[], current: string | undefined, step: 1 | -1) {
  if (keys.length === 0) return undefined;
  const i = current === undefined ? -1 : keys.indexOf(current);
  if (i === -1) return step === 1 ? keys[0] : keys.at(-1);
  return keys[(i + step + keys.length) % keys.length];
}

/** A search's words, lowercased. */
export const searchWords = (query: string) =>
  query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Whether a row matches every word of a search: each in `text` (its title, repo, branch, and pull
 * request numbers), or among the words plxd found in its messages (`inMessages`). Returns the
 * words found only in its messages, so the row can show a snippet, or undefined for no match.
 */
export function searchMatch(
  words: readonly string[],
  text: string,
  inMessages: (word: string) => boolean,
): string[] | undefined {
  const haystack = text.toLowerCase();
  const onlyInMessages: string[] = [];
  for (const word of words) {
    if (haystack.includes(word)) continue;
    if (!inMessages(word)) return undefined;
    onlyInMessages.push(word);
  }
  return onlyInMessages;
}

/** `text` split into runs, each marked when it is one of `words`, for highlighting matches. */
export function highlight(
  text: string,
  words: readonly string[],
): { text: string; mark: boolean }[] {
  if (words.length === 0) return [{ text, mark: false }];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text
    .split(new RegExp(`(${escaped.join("|")})`, "gi"))
    .filter(Boolean)
    .map((part) => ({ text: part, mark: words.includes(part.toLowerCase()) }));
}
