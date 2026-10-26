// Pieces of the sidebar (0075): its View options, and the small parts the sidebar shares.
import type { ReactNode } from "react";

import type { TodayGroup } from "./pins";

/** Today's auto-archive choices, in hours, and never. */
const quietChoices = [
  [null, "Off"],
  [12, "12h"],
  [24, "1d"],
  [72, "3d"],
  [168, "1w"],
] as const;

/** An auto-archive choice in words, for a toast: "a day", "3 days". */
export const quietFor = (hours: number) =>
  hours === 24
    ? "a day"
    : hours === 168
      ? "a week"
      : hours < 24
        ? `${hours} hours`
        : `${hours / 24} days`;

/**
 * A row of choices whose thumb slides to the chosen one, as a radio group: Left and Right move the
 * choice, and only the chosen option takes Tab.
 */
function Segmented<T extends string | number | boolean | null>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  const at = Math.max(
    0,
    options.findIndex(([v]) => v === value),
  );
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = (at + step + options.length) % options.length;
        onChange(options[next]![0]);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
      }}
      className="relative grid rounded-md bg-foreground/[0.06] p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="seg-thumb absolute inset-y-0.5 left-0.5 rounded-sm"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${at * 100}%)`,
        }}
      />
      {options.map(([v, text], n) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={n === at}
          tabIndex={n === at ? 0 : -1}
          onClick={() => onChange(v)}
          className="relative h-6 rounded-sm px-1.5 text-meta font-medium whitespace-nowrap text-faint-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The sidebar's View options, at the foot of the filter menu (PLX-1043): how today's threads
 * group, how tall their rows are, whether Projects list at all, and when finished threads
 * archive themselves.
 */
export function ViewOptions({
  autoHours,
  onAutoHours,
  compact,
  onCompact,
  projects,
  onProjects,
  group,
  onGroup,
}: {
  autoHours: number | null;
  onAutoHours: (hours: number | null) => void;
  compact: boolean;
  onCompact: (compact: boolean) => void;
  /** Whether Projects list; hidden, they list only while searching. */
  projects: boolean;
  onProjects: (show: boolean) => void;
  /** How today's threads are grouped. */
  group: TodayGroup;
  onGroup: (group: TodayGroup) => void;
}) {
  return (
    <div role="group" aria-label="View" className="flex flex-col gap-2.5">
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
        <span className="text-body text-muted-foreground">Group</span>
        <Segmented
          label="Group"
          value={group}
          options={[
            ["none", "None"],
            ["repo", "Repo"],
            ["day", "Day"],
          ]}
          onChange={onGroup}
        />
        <span className="text-body text-muted-foreground">Rows</span>
        <Segmented
          label="Rows"
          value={compact}
          options={[
            [false, "Full"],
            [true, "One line"],
          ]}
          onChange={onCompact}
        />
        <span className="text-body text-muted-foreground">Projects</span>
        <Segmented
          label="Projects"
          value={projects}
          options={[
            [true, "Show"],
            [false, "Hide"],
          ]}
          onChange={onProjects}
        />
      </div>
      {!projects && (
        <p className="text-meta leading-snug text-faint-foreground">
          Hidden Projects still show while you search.
        </p>
      )}
      <p className="text-body text-muted-foreground">Archive finished threads after</p>
      <Segmented
        label="Archive finished threads after"
        value={autoHours}
        options={quietChoices}
        onChange={onAutoHours}
      />
      <p className="text-meta leading-snug text-faint-foreground">
        Only threads you've seen. Pinned threads stay.
      </p>
    </div>
  );
}

/** A count that rolls up into place when it changes (index.css). */
export function Tick({ value }: { value: number }) {
  return (
    <span key={value} className="tick tabular-nums">
      {value}
    </span>
  );
}

/** Slides its children's height open or shut; they stay mounted, and inert while shut. */
export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={`grid transition-[grid-template-rows,opacity] duration-250 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * The sidebar's rows, in order, matching `also` (a selector to append to `[data-row]`), less any
 * in a shut `Fold` or closed folder: what Up, Down, and focus after a change move through.
 */
export const shownRows = (also = "") =>
  [...document.querySelectorAll<HTMLElement>(`#sidebar [data-row]${also}`)].filter(
    (r) => !r.closest("[inert]"),
  );

/** Runs `then` after closing the menu it's in, for a favorite's or pin's menu items. */
export const close = (then: () => void) => (e: { currentTarget: HTMLElement }) => {
  e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
  then();
};
