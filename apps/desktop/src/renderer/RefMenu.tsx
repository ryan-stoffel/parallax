import { ChevronDown, GitBranch, Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ToggleEvent } from "react";

import type { RepoRef } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { MenuOption, menuButton, menuPanel, moveFocus } from "./ui";

/** The most rows the menu draws. A search filters every ref, not just these. */
const maxRows = 100;

/** The most of a label's end that stays visible when it is cut in the middle. */
const tailLength = 12;

/**
 * The refs a new worktree starts from until one is picked, the first that exists: `develop`, else
 * `main`, each remote-tracking first since the local one is often stale (PLX-869).
 */
const baseOrder = ["origin/develop", "develop", "origin/main", "main"];

// Each repository's refs, or why they couldn't be listed, by host and repository, kept while the
// app runs, so a picker that mounts or changes computer reads its ref at once. Only a picker's own
// answer picks a default base, since a kept list may be stale.
const known = new Map<string, RepoRef[] | string>();

/** A ref's quiet note in the menu. */
const hint = (r: RepoRef) =>
  r.current ? "current" : r.worktree ? "worktree" : r.default ? "default" : undefined;

/**
 * New Thread's ref picker, for a plxd with `repoRefs`. For a new worktree its button reads
 * `From <ref>`, and picks the first of `baseOrder` the repository has, else it reads the checkout's
 * branch. For the current checkout it reads the picked ref, or `Select ref`. While another
 * repository's refs load, it keeps the label it had. Its menu searches the repository's branches
 * from `repo/refs`, asked again each time it opens.
 */
export function RefMenu({
  hostId,
  repo,
  checkout,
  value,
  onChange,
}: {
  hostId: string;
  repo: string;
  checkout: boolean;
  value?: string;
  onChange: (ref: string) => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const key = `${hostId}/${repo}`;
  const refs = known.get(key);
  // The host and repository of this picker's last answer in `known`: a new object each time, so
  // every answer renders.
  const [fresh, setFresh] = useState<{ key: string }>();

  const load = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "repo/refs", { repo });
    const refs = "error" in answer ? describeError(answer.error) : answer.result.refs;
    known.set(`${hostId}/${repo}`, refs);
    setFresh({ key: `${hostId}/${repo}` });
  }, [hostId, repo]);
  // On mount too, for a new worktree's default base.
  useEffect(() => void load(), [load]);

  const list = typeof refs === "object" ? refs : [];
  const q = query.trim().toLowerCase();
  const matches = q ? list.filter((r) => r.name.toLowerCase().includes(q)) : list;
  const shown = matches.slice(0, maxRows);
  const base = checkout ? undefined : baseOrder.find((name) => list.some((r) => r.name === name));
  useEffect(() => {
    if (value === undefined && base && fresh?.key === key) onChange(base);
  }, [value, base, fresh, key]);
  const [last, setLast] = useState<string>();
  const label =
    refs === undefined && value === undefined && last !== undefined
      ? last
      : checkout
        ? (value ?? "Select ref")
        : `From ${value ?? base ?? list.find((r) => r.current)?.name ?? "HEAD"}`;
  if (label !== last) setLast(label);
  // Where the label's visible end starts: its last word, after a `-`, `/`, or space, up to
  // `tailLength` characters of it.
  const tail = Math.max(
    label.length - tailLength,
    Math.max(label.lastIndexOf("-"), label.lastIndexOf("/"), label.lastIndexOf(" ")) + 1,
  );

  const choose = (r: RepoRef) => {
    menu.current?.hidePopover();
    onChange(r.name);
  };

  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        title={label}
        className={`${menuButton} min-w-0 max-w-72`}
      >
        <GitBranch />
        {/* Cut in the middle, so a long branch keeps its end: `From bug/PLX-781-sweep…worktrees`. */}
        <span className="flex min-w-0">
          {/* `whitespace-pre` keeps a space the cut lands after, as in `From main`. */}
          <span className="overflow-hidden text-ellipsis whitespace-pre">
            {label.slice(0, tail)}
          </span>
          <span className="shrink-0">{label.slice(tail)}</span>
        </span>
        <ChevronDown aria-hidden className="opacity-70" />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Ref"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "closed") return setQuery("");
          searchBox.current?.focus();
          void load();
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel("end")} w-72 overflow-hidden p-0`}
      >
        <label className="flex items-center gap-2 border-b border-border px-3 py-2.5 focus-within:border-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            ref={searchBox}
            type="search"
            aria-label="Search refs"
            placeholder="Search refs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) choose(shown[0]);
            }}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <div className="max-h-80 overflow-y-auto p-1">
          {shown.map((r) => (
            <MenuOption
              key={r.name}
              option={{ value: r.name, label: r.name, hint: hint(r) }}
              checked={r.name === value}
              onClick={() => choose(r)}
            />
          ))}
          {(refs === undefined || typeof refs === "string" || shown.length === 0) && (
            <p className="px-2 py-1.5 text-body text-faint-foreground">
              {refs === undefined ? "Loading…" : typeof refs === "string" ? refs : "No matches"}
            </p>
          )}
        </div>
        {matches.length > maxRows && (
          <p className="border-t border-border px-3 py-2 text-meta text-faint-foreground">
            Showing {maxRows} of {matches.length} refs
          </p>
        )}
      </div>
    </>
  );
}
