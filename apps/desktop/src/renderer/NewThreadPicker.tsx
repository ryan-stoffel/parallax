import { ArrowDown, ArrowLeft, ArrowUp, Search } from "lucide-react";
import { useId, useState, type Ref } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { kbd } from "./AddDialog";
import { RepoIcon } from "./Sidebar";
import { noRepo, type ThreadGroup } from "./threads";
import { RowBadge, rowShortcut } from "./ui";

/**
 * Mod+N's picker: which repository, or No Repo, a new thread goes in, laid out as Add Repository
 * is. Up and Down move, Enter picks, Mod+1 to Mod+9 pick that row, Escape closes. Open it with
 * `ref.current.showModal()`; picking closes it and calls `onPick` with the group's id.
 */
export function NewThreadPicker({
  ref,
  groups,
  repos,
  hostName,
  onPick,
}: {
  ref: Ref<HTMLDialogElement>;
  /** Repositories and No Repo, as the sidebar groups them. */
  groups: ThreadGroup[];
  /** The host's repo entries, for each group's icon and path. */
  repos: Repo[];
  hostName: string;
  onPick: (groupId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const q = query.trim().toLowerCase();
  const shown = groups.filter((g) => g.name.toLowerCase().includes(q));
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
          if (value) onPick(value);
        }}
        onKeyDown={(e) => {
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          const n = rowShortcut(e);
          if (n !== undefined) {
            // Not the sidebar's row too.
            e.preventDefault();
            e.stopPropagation();
            const group = shown[n];
            if (group) e.currentTarget.requestSubmit(submitterFor(e.currentTarget, group.id));
          } else if (step && shown.length > 0) {
            e.preventDefault();
            const i = current ? shown.indexOf(current) : 0;
            setActive((i + step + shown.length) % shown.length);
          } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            if (current) e.currentTarget.requestSubmit(submitterFor(e.currentTarget, current.id));
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
            aria-activedescendant={current && `${listId}-${current.id}`}
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
            {shown.map((g, i) => {
              const repo = repos.find((r) => r.id === g.id);
              return (
                <button
                  key={g.id}
                  id={`${listId}-${g.id}`}
                  type="submit"
                  role="option"
                  aria-selected={g === current}
                  name="group"
                  value={g.id}
                  data-active={g === current || undefined}
                  onMouseMove={() => setActive(i)}
                  className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left data-active:bg-hover"
                >
                  <RepoIcon repo={repo} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">
                      {g.id === noRepo ? "No repo" : g.name}
                    </span>
                    {repo && g.id !== noRepo && (
                      <span className="block truncate text-[12.5px] text-muted-foreground">
                        {hostName} · {repo.path}
                      </span>
                    )}
                  </span>
                  {i < 9 && <RowBadge index={i} />}
                </button>
              );
            })}
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
