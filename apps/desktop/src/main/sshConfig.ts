import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// What Add host suggests (PLX-580): the hosts ssh already knows, from the user's ssh config and
// known_hosts. Only names leave main; nothing here is ever written.

/** A config line without a trailing ` # comment`, which OpenSSH 8.7 and later ignore. */
const uncommented = (line: string) => line.replace(/\s#.*$/, "");

/** The `Host` names in one ssh config file's text, without wildcard or negated patterns. */
export function configHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = uncommented(raw);
    const match = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    for (const name of match[1]!.split(/\s+/)) {
      const bare = name.replace(/^"|"$/g, "");
      if (bare && !/[*?!]/.test(bare)) hosts.push(bare);
    }
  }
  return hosts;
}

/** The `Include` patterns in one ssh config file's text. */
export function configIncludes(text: string): string[] {
  const includes: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = uncommented(raw);
    const match = /^\s*Include\s+(.+?)\s*$/i.exec(line);
    if (match) includes.push(...match[1]!.split(/\s+/).map((p) => p.replace(/^"|"$/g, "")));
  }
  return includes;
}

/**
 * The plain host names in known_hosts' text: each line's first field, split on commas, with
 * `[host]:port` unwrapped. Hashed lines (`|1|…`), markers (`@cert-authority`), and comments are
 * skipped, since they name no host anyone can read.
 */
export function knownHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0];
    if (!first || first.startsWith("#") || first.startsWith("|") || first.startsWith("@")) continue;
    for (const entry of first.split(",")) {
      const host = /^\[(.+)\]:\d+$/.exec(entry)?.[1] ?? entry;
      if (host && !/[*?!]/.test(host)) hosts.push(host);
    }
  }
  return hosts;
}

/**
 * The files an `Include` pattern names: relative to `~/.ssh`, `~` expanded, and a `*` or `?` in
 * the last part matched against that folder's files.
 */
function expandInclude(pattern: string, home: string): string[] {
  const full = pattern.startsWith("~")
    ? path.join(home, pattern.slice(1))
    : path.isAbsolute(pattern)
      ? pattern
      : path.join(home, ".ssh", pattern);
  const base = path.basename(full);
  if (!/[*?]/.test(base)) return [full];
  const glob = new RegExp(
    `^${base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  try {
    return readdirSync(path.dirname(full))
      .filter((name) => glob.test(name))
      .sort()
      .map((name) => path.join(path.dirname(full), name));
  } catch {
    return [];
  }
}

/** A file's text, or "" when it can't be read. */
const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * The hosts to suggest, de-duplicated: `~/.ssh/config`'s, following `Include` (up to 16 files,
 * so a loop can't run away), then `~/.ssh/known_hosts`'s.
 */
export function sshSuggestions(home: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const queue = [path.join(home, ".ssh", "config")];
  while (queue.length && seen.size < 16) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = read(file);
    hosts.push(...configHosts(text));
    for (const include of configIncludes(text)) queue.push(...expandInclude(include, home));
  }
  hosts.push(...knownHosts(read(path.join(home, ".ssh", "known_hosts"))));
  return [...new Set(hosts)];
}
