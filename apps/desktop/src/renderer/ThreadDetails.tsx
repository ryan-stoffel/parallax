import { ClipboardList, FolderGit2, FolderOpen } from "lucide-react";
import { useLayoutEffect, useState, type ComponentProps } from "react";

import { Actions } from "./Actions";
import { GitMenu } from "./GitMenu";
import { LineageSection } from "./Lineage";
import { OpenMenu } from "./OpenMenu";
import { hostIcon } from "./RunTargetMenu";
import type { Host } from "./hosts";
import { IconButton } from "./ui";

/** Where whether Thread details is shown is kept, for every thread. */
export const THREAD_DETAILS_KEY = "parallax.threadDetails";
export const THREAD_DETAILS_ID = "thread-details";

/** The docked card's width, `w-64`, with its right gap. */
const DOCKED_WIDTH = 268;
/** The least of its row the thread keeps beside the docked card; below it the card floats. */
export const THREAD_MIN_SHARE = 0.6;

/** Whether docking Thread details in a row `width` wide would leave the thread too little room. */
export const tooNarrowToDock = (width: number) =>
  width > 0 && width - DOCKED_WIDTH < width * THREAD_MIN_SHARE;

export type ThreadDetailsMode = "docked" | "floating" | "hidden";

/**
 * Where Thread details shows, for the thread row `ref` is set on, which may unmount and return
 * (behind the Pull requests page) and is measured again each time. With room it docks while the kept choice
 * says shown. Without room (the thread would keep less than `THREAD_MIN_SHARE` of the row) it
 * starts hidden, and the button floats it over the thread until pressed again; the kept choice is
 * left alone. Crossing the line either way closes a floating card.
 */
export function useThreadDetails() {
  const [element, ref] = useState<HTMLElement | null>(null);
  const [docked, setDocked] = useState(() => localStorage.getItem(THREAD_DETAILS_KEY) === "open");
  const [floating, setFloating] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // Crossing the line closes a floating card, adjusted while rendering rather than in an updater.
  const [measured, setMeasured] = useState(narrow);
  if (measured !== narrow) {
    setMeasured(narrow);
    setFloating(false);
  }
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setNarrow(tooNarrowToDock(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const toggle = () => {
    if (narrow) return setFloating((was) => !was);
    setDocked((was) => {
      localStorage.setItem(THREAD_DETAILS_KEY, was ? "closed" : "open");
      return !was;
    });
  };
  const mode: ThreadDetailsMode = narrow
    ? floating
      ? "floating"
      : "hidden"
    : docked
      ? "docked"
      : "hidden";
  return { mode, toggle, ref };
}

/** The top bar's button that shows and hides Thread details. */
export function ThreadDetailsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <IconButton
      label="Thread details"
      aria-pressed={open}
      aria-controls={THREAD_DETAILS_ID}
      onClick={onToggle}
    >
      <ClipboardList />
    </IconButton>
  );
}

/**
 * The thread's host, launchers, repository actions, Git status, and lineage, docked at the
 * thread's right, left of the side panel. Mounted while hidden, so the Open and action
 * shortcuts keep working.
 */
export function ThreadDetails({
  mode,
  host,
  folder,
  worktree,
  actions,
  git,
  lineage,
}: {
  mode: ThreadDetailsMode;
  host: Host;
  folder?: string;
  worktree?: boolean;
  actions?: ComponentProps<typeof Actions>;
  git?: ComponentProps<typeof GitMenu>;
  lineage?: Omit<ComponentProps<typeof LineageSection>, "visible">;
}) {
  return (
    <aside
      id={THREAD_DETAILS_ID}
      aria-label="Thread details"
      hidden={mode === "hidden"}
      data-mode={mode}
      // Docked, it takes room in the thread's row; floating, it hovers over the thread's right.
      // Either way it's an opaque card sized to its rows, scrolling at the row's height.
      className={`flex w-64 flex-col py-2 pr-3 ${
        mode === "floating"
          ? "pointer-events-none absolute inset-y-0 right-0 z-30 max-w-[calc(100%-1rem)]"
          : "shrink-0"
      }`}
    >
      <div className="pointer-events-auto max-h-full overflow-y-auto rounded-xl border border-border bg-surface text-foreground shadow-composer [&_svg]:size-[18px] [&_img]:size-[18px]">
        <section aria-label="Workspace" className="p-2">
          <div
            title={folder ?? "No folder yet"}
            className="flex items-center gap-2 px-2 py-2 text-[13px]"
          >
            <span aria-hidden className="shrink-0 text-muted-foreground">
              {hostIcon(host)}
            </span>
            {worktree ? (
              <FolderGit2 aria-hidden className="shrink-0 text-muted-foreground" />
            ) : (
              <FolderOpen aria-hidden className="shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium">{host.name}</span>
          </div>
          <OpenMenu hostId={host.id} folder={folder} />
          {actions && <Actions {...actions} />}
        </section>
        {git && (
          <section aria-label="Git" className="border-t border-border p-2">
            <GitMenu {...git} />
          </section>
        )}
        {lineage && <LineageSection {...lineage} visible={mode !== "hidden"} />}
      </div>
    </aside>
  );
}
