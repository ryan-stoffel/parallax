import { ArrowDown, ArrowLeft, ArrowUp, Search } from "lucide-react";
import { useId, useState, type Ref } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { kbd } from "./AddDialog";
import { RepoIcon } from "./Sidebar";
import { noRepo, type OtherRepo, type ThreadGroup } from "./threads";
import { RowBadge, rowShortcut } from "./ui";

/**
 * Mod+N's picker: which repository, or No Repo, a new thread goes in, laid out as Add Repository
 * is. Up and Down move, Enter picks, Mod+1 to Mod+9 pick that row, Escape closes. Open it with
 * `ref.current.showModal()`; picking closes it and calls `onPick` with the group's id, or for one
 * of the other computers' repositories, `onPickElsewhere` with its computer and entry.
 */
export function NewThreadPicker({
  ref,
  groups,
  repos,
  hostName,
  elsewhere,
  onPick,
  onPickElsewhere,
}: {
  ref: Ref<HTMLDialogElement>;
  /** Repositories and No Repo, as the sidebar groups them. */
  groups: ThreadGroup[];
  /** The host's repo entries, for each group's icon and path. */
  repos: Repo[];
  hostName: string;
  /** The other computers' repositories, listed after the host's own. */
  elsewhere: OtherRepo[];
  onPick: (groupId: string) => void;
  onPickElsewhere: (hostId: string, groupId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const q = query.trim().toLowerCase();
  // Each row's value is its group id, or for another computer's repository, `host/entry`, since
  // entry ids are only unique per computer.
  const rows = [
    ...groups.map((g) => ({
      value: g.id,
      name: g.id === noRepo ? "No repo" : g.name,
      repo: repos.find((r) => r.id === g.id),
      hostName,
      pick: () => onPick(g.id),
    })),
    ...elsewhere.map((o) => ({
      value: `${o.host.id}/${o.repo.id}`,
      name: o.repo.name,
      repo: o.repo,
      hostName: o.host.name,
      pick: () => onPickElsewhere(o.host.id, o.repo.id),
    })),
  ];
  const shown = rows.filter((row) => row.name.toLowerCase().includes(q));
  const current = shown[Math.min(active, shown.length - 1)];

  return (
    <dialog
      ref={ref}
      aria-label="New thread in"
      onClose={() => {
        setQuery("");
        setActive(0);
      }}
      className="mx-auto mt-[14vh] w-[36rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface p-0 text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        method="dialog"
        // The dialog closes itself on submit; the button that submitted says what was picked.
        onSubmit={(e) => {
          const value = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
          rows.find((row) => row.value === value)?.pick();
        }}
        onKeyDown={(e) => {
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          const n = rowShortcut(e);
          if (n !== undefined) {
            // Not the sidebar's row too.
            e.preventDefault();
            e.stopPropagation();
            const row = shown[n];
            if (row) e.currentTarget.requestSubmit(submitterFor(e.currentTarget, row.value));
          } else if (step && shown.length > 0) {
            e.preventDefault();
            const i = current ? shown.indexOf(current) : 0;
            setActive((i + step + shown.length) % shown.length);
          } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            if (current)
              e.currentTarget.requestSubmit(submitterFor(e.currentTarget, current.value));
          }
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          <button
            type="submit"
            value=""
            aria-label="Close"
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
          >
            <ArrowLeft />
          </button>
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            // The native attribute, so showModal focuses the search box rather than Close.
            ref={(el) => el?.setAttribute("autofocus", "")}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={current && `${listId}-${current.value}`}
            aria-label="Search repositories"
            placeholder="Search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-2 pb-2">
          <p
            id={`${listId}-heading`}
            className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-faint-foreground"
          >
            Repositories
          </p>
          <div id={listId} role="listbox" aria-labelledby={`${listId}-heading`}>
            {shown.map((row, i) => (
              <button
                key={row.value}
                id={`${listId}-${row.value}`}
                type="submit"
                role="option"
                aria-selected={row === current}
                name="group"
                value={row.value}
                data-active={row === current || undefined}
                onMouseMove={() => setActive(i)}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left data-active:bg-hover"
              >
                <RepoIcon repo={row.repo} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{row.name}</span>
                  {row.repo && row.value !== noRepo && (
                    <span className="block truncate text-[12.5px] text-muted-foreground">
                      {row.hostName} · {row.repo.path}
                    </span>
                  )}
                </span>
                {i < 9 && <RowBadge index={i} />}
              </button>
            ))}
          </div>
          {shown.length === 0 && (
            <p className="px-2.5 py-2 text-[13px] text-faint-foreground">No repositories match</p>
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-border bg-background/40 px-4 py-2.5 text-[12.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <kbd className={`${kbd} grid size-5.5 place-items-center p-0`}>
              <ArrowUp className="size-3" />
            </kbd>
            <kbd className={`${kbd} grid size-5.5 place-items-center p-0`}>
              <ArrowDown className="size-3" />
            </kbd>
            Move
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className={kbd}>Enter</kbd>
            Pick
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className={kbd}>Esc</kbd>
            Close
          </span>
        </div>
      </form>
    </dialog>
  );
}

/** The group's own button, so a keyboard pick submits the same value a click would. */
function submitterFor(form: HTMLFormElement, id: string): HTMLButtonElement | undefined {
  return form.querySelector<HTMLButtonElement>(`button[name="group"][value="${id}"]`) ?? undefined;
}
