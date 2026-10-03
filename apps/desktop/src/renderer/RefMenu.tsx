import { ChevronDown, GitBranch, Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ToggleEvent } from "react";

import type { RepoRef } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { MenuOption, menuButton, menuPanel, moveFocus } from "./ui";

/** The most rows the menu draws. A search filters every ref, not just these. */
const maxRows = 100;

/** A ref's quiet note in the menu. */
const hint = (r: RepoRef) =>
  r.current ? "current" : r.worktree ? "worktree" : r.default ? "default" : undefined;

/**
 * New Thread's ref picker, for a plxd with `repoRefs`. For a new worktree its button reads
 * `From <ref>`, the checkout's branch until one is picked. For the current checkout it reads the
 * picked ref, or `Select ref`. Its menu searches the repository's branches from `repo/refs`, asked
 * again each time it opens.
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
  // Each repository's refs, or why they couldn't be listed, so a late answer lands on its own.
  const [all, setAll] = useState<Record<string, RepoRef[] | string>>({});
  const [query, setQuery] = useState("");
  const refs = all[repo];

  const load = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "repo/refs", { repo });
    const refs = "error" in answer ? describeError(answer.error) : answer.result.refs;
    setAll((prev) => ({ ...prev, [repo]: refs }));
  }, [hostId, repo]);
  // On mount too, for the checkout's branch in a new worktree's label.
  useEffect(() => void load(), [load]);

  const list = typeof refs === "object" ? refs : [];
  const q = query.trim().toLowerCase();
  const matches = q ? list.filter((r) => r.name.toLowerCase().includes(q)) : list;
  const shown = matches.slice(0, maxRows);
  const label = checkout
    ? (value ?? "Select ref")
    : `From ${value ?? list.find((r) => r.current)?.name ?? "HEAD"}`;

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
        className={`${menuButton} min-w-0`}
      >
        <GitBranch />
        <span className="truncate">{label}</span>
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
            className="min-w-0 flex-1 bg-transparent text-[13.5px] placeholder:text-faint-foreground focus-visible:outline-none"
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
            <p className="px-2 py-1.5 text-[12.5px] text-faint-foreground">
              {refs === undefined ? "Loading…" : typeof refs === "string" ? refs : "No matches"}
            </p>
          )}
        </div>
        {matches.length > maxRows && (
          <p className="border-t border-border px-3 py-2 text-[12px] text-faint-foreground">
            Showing {maxRows} of {matches.length} refs
          </p>
        )}
      </div>
    </>
  );
}
