import { ArrowDown, ArrowLeft, ArrowUp, FolderPlus, Search } from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";

import { GitHubLogo } from "./logos";

interface Source {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  /** Why it can't be picked right now, shown as a badge. */
  unavailable?: string;
}

const kbd = "rounded-md bg-selected px-1.5 py-0.5 font-sans text-[11.5px] text-foreground";

/**
 * Add Repository, a native modal <dialog> laid out like a command palette: a search box over
 * the sources a repository can come from. Up and Down move, Enter picks, Escape closes. Open it
 * with `ref.current.showModal()`; picking Local folder closes it and calls `onLocalFolder`.
 */
export function AddRepositoryDialog({
  ref,
  local,
  onLocalFolder,
}: {
  ref: Ref<HTMLDialogElement>;
  /** Whether the host is this computer, so its folders can be browsed. */
  local: boolean;
  onLocalFolder: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const sources: Source[] = [
    {
      id: "local",
      name: "Local folder",
      description: "Pick a repository that's already on this computer",
      icon: <FolderPlus />,
      unavailable: local ? undefined : "This computer only",
    },
    {
      id: "github",
      name: "GitHub repository",
      description: "Clone one by its owner/name",
      icon: <GitHubLogo />,
      // Cloning needs wispd's help on the host, which it doesn't offer yet.
      unavailable: "Not available yet",
    },
  ];
  const q = query.trim().toLowerCase();
  const shown = sources.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q));
  const pickable = shown.filter((s) => !s.unavailable);
  const current = pickable[Math.min(active, pickable.length - 1)];

  return (
    <dialog
      ref={ref}
      aria-label="Add repository"
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
          if ((e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "local")
            onLocalFolder();
        }}
        onKeyDown={(e) => {
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          if (step && pickable.length > 0) {
            e.preventDefault();
            const i = current ? pickable.indexOf(current) : 0;
            setActive((i + step + pickable.length) % pickable.length);
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
            aria-label="Search sources"
            placeholder="Search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div className="px-2 pb-2">
          <p className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-faint-foreground">
            Sources
          </p>
          {shown.map((s) => (
            <button
              key={s.id}
              type="submit"
              name="source"
              value={s.id}
              disabled={!!s.unavailable}
              data-active={s === current || undefined}
              onMouseMove={() => !s.unavailable && setActive(pickable.indexOf(s))}
              className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left data-active:bg-hover disabled:opacity-60 [&>svg]:size-5 [&>svg]:shrink-0"
            >
              {s.icon}
              <span className="min-w-0 flex-1">
                <span className="block text-[14px]">{s.name}</span>
                <span className="block text-[12.5px] text-muted-foreground">{s.description}</span>
              </span>
              {s.unavailable && (
                <span className="shrink-0 rounded-md border border-amber-500/30 px-2 py-0.5 text-[12px] text-amber-500">
                  {s.unavailable}
                </span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <p className="px-2.5 py-2 text-[13px] text-faint-foreground">No sources match</p>
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

/** The source's own button, so a keyboard Enter submits the same value a click would. */
function submitterFor(form: HTMLFormElement, id: string): HTMLButtonElement | undefined {
  return form.querySelector<HTMLButtonElement>(`button[name="source"][value="${id}"]`) ?? undefined;
}
