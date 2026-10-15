import type { Area, Thread } from "../protocol/generated/protocol";
import { stored } from "./stored";

/**
 * What the sidebar lists (PLX-789): every thread, one host's area, one repo entry or Space, or the
 * threads with no repo. An area or repo is named by its host and id.
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
 * The colors an area can take, in the editor's order: the project palette's keys (index.css), so
 * they follow the theme.
 */
export const areaColors = [
  { key: "violet", label: "Violet" },
  { key: "orange", label: "Orange" },
  { key: "teal", label: "Teal" },
  { key: "sky", label: "Blue" },
  { key: "pink", label: "Pink" },
  { key: "green", label: "Green" },
  { key: "yellow", label: "Gold" },
  { key: "gray", label: "Slate" },
];

/** An area color key as CSS. A key this app doesn't know is the accent. */
export const areaColor = (key: string) =>
  areaColors.some((c) => c.key === key) ? `var(--project-${key})` : "var(--accent)";

/** A new area's color: the first one no area uses, else the first. */
export const nextColor = (areas: readonly Area[]) =>
  (areaColors.find((c) => !areas.some((a) => a.color === c.key)) ?? areaColors[0]!).key;

/** The longest area name, as plxd's `MAX_AREA_NAME_CHARS`. */
export const maxAreaName = 40;

/** Why `name` can't name an area among `areas` (other than `self`), for people, or undefined. */
export function areaNameError(name: string, areas: readonly Area[], self?: string) {
  const trimmed = name.trim();
  if (!trimmed) return "Give it a name.";
  if (trimmed.length > maxAreaName) return `Keep it to ${maxAreaName} characters.`;
  const lower = trimmed.toLowerCase();
  if (areas.some((a) => a.id !== self && a.name.toLowerCase() === lower))
    return `You already have an area called “${trimmed}”.`;
  return undefined;
}

/**
 * By thread id: its topmost listed ancestor's id, itself for a top-level thread. A child follows
 * its root into every area the root is in. A loop of parents stops where it repeats.
 */
export function rootIds(threads: readonly Thread[]): Map<string, string> {
  const parents = new Map(threads.map((t) => [t.id, t.parent]));
  const roots = new Map<string, string>();
  for (const t of threads) {
    const seen = new Set([t.id]);
    let root: string = t.id;
    for (let up = parents.get(root); up && parents.has(up) && !seen.has(up); up = parents.get(up)) {
      seen.add(up);
      root = up;
    }
    roots.set(t.id, root);
  }
  return roots;
}

/** What makes a sidebar row an area member: a thread by its root's id, or a Project. */
export type Member = { kind: "thread"; root: string } | { kind: "project"; id: string };

/** Whether `member` is in `area`. */
export const inArea = (area: Area, member: Member) =>
  member.kind === "thread" ? area.threads.includes(member.root) : area.projects.includes(member.id);

/** `area` with top-level thread or Project `id` added (`on`) or taken out. */
export function withMember(area: Area, kind: "thread" | "project", id: string, on: boolean) {
  const list = kind === "thread" ? area.threads : area.projects;
  const next = on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);
  return kind === "thread" ? { threads: next } : { projects: next };
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
