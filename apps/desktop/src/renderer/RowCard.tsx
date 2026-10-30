// The sidebar's row card (0091): one shell for thread, Project, and draft rows.
import type { HTMLAttributes, ReactNode } from "react";

// One observer for every row: it keeps each row's `--row-tools` at its tools' width, so the line
// they cover on hover leaves exactly their room.
let toolsObserver: ResizeObserver | undefined;
function watchTools(el: HTMLElement | null) {
  if (!el || typeof ResizeObserver === "undefined") return;
  toolsObserver ??= new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const width = (target as HTMLElement).offsetWidth;
      target.parentElement?.style.setProperty("--row-tools", `${width + 4}px`);
    }
  });
  toolsObserver.observe(el);
  return () => toolsObserver?.unobserve(el);
}

/**
 * A sidebar row. A card's top line is `place` (where it is) with `status` at its end, then its
 * `title`, then `details`; a `compact` row is one line of `place` (an icon), the title, and the
 * status, as is a card's first line with no place (under its repo's heading). In the top-right, `actions` show while it's hovered or focused, in place of the status,
 * and `trailing` (a pin) always shows. The line under them keeps clear of their measured width, and
 * nothing changes size on hover, so the row never reflows. `rowKey` is its `data-flip`, so it
 * slides and fades as the list changes (flip.ts), and its `data-row`, which the arrow keys and
 * focus after a change move through. `main` goes on the button that opens it, a plain box while
 * `editing` (an input can't sit in a button); `li` on the row itself. `children` follow the button,
 * as its menus. A `dense` row, as under a Traditional folder, is a card with less padding whose
 * first line is `place` (an icon, or nothing), the title, and the status.
 */
export function RowCard({
  rowKey,
  kind,
  compact = false,
  dense = false,
  place,
  status,
  title,
  dim = false,
  details,
  actions,
  trailing,
  selected = false,
  picked = false,
  outlined = false,
  flash = false,
  faded = false,
  editing = false,
  before,
  li,
  main,
  children,
}: {
  rowKey: string;
  kind: "thread" | "project" | "draft";
  compact?: boolean;
  /** Less padding, for a card under a Traditional folder's heading (0091). */
  dense?: boolean;
  place?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
  /** Whether the title is quieter, as a finished thread's is until hovered or open. */
  dim?: boolean;
  details?: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  /** One of the rows picked for a bulk action. */
  picked?: boolean;
  /** Outlined in the warning color, for an unsent prompt (PLX-887). */
  outlined?: boolean;
  /** Just finished, so it flashes once. */
  flash?: boolean;
  /** Being dragged. */
  faded?: boolean;
  editing?: boolean;
  /** Drawn first, as the line where a dragged row would land. */
  before?: ReactNode;
  li?: HTMLAttributes<HTMLLIElement>;
  main?: HTMLAttributes<HTMLElement> & { draggable?: boolean };
  children?: ReactNode;
}) {
  const Main = editing ? "div" : "button";
  const look = picked
    ? "bg-accent/14 ring-1 ring-accent/38 ring-inset"
    : selected
      ? "bg-selected text-foreground"
      : `group-hover/row:bg-hover ${outlined ? "ring-1 ring-warning ring-inset" : ""}`;
  const hover =
    "group-hover/row:pr-(--row-tools,8.5rem) group-has-[:focus-visible]/row:pr-(--row-tools,8.5rem)";
  // The line the tools sit over: clear of the trailing pin always, and of the actions on hover.
  const clear = editing ? "" : `${trailing ? "pr-6" : ""} ${actions ? hover : ""}`;
  const statusLook = `shrink-0 ${actions ? "group-has-[:focus-visible]/row:hidden group-hover/row:hidden" : ""}`;
  const titleColor =
    selected || !dim ? "text-foreground" : "text-foreground/70 group-hover/row:text-foreground";
  // A compact or dense row, or a card with no place (under its repo's heading), leads with its title.
  const oneLine = compact || dense || !place;
  const titleText = (
    <span
      data-title
      className={`min-w-0 flex-1 truncate text-body transition-colors ${compact ? "font-medium" : "font-semibold"} ${titleColor}`}
    >
      {title}
    </span>
  );
  const statusText = (
    <span data-status className={`text-meta text-faint-foreground ${statusLook}`}>
      {status}
    </span>
  );
  return (
    <li
      data-kind={kind}
      data-flip={rowKey}
      {...li}
      className={`group/row relative rounded-lg transition-[background-color,opacity] duration-100 ${look} ${flash ? "row-flash" : ""} ${faded ? "opacity-40" : ""}`}
    >
      {before}
      <Main
        {...(!editing && { type: "button" as const })}
        aria-current={selected ? "page" : undefined}
        data-row={rowKey}
        data-kind={kind}
        {...main}
        className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 text-left -outline-offset-2 transition-transform duration-100 active:scale-[0.985] ${compact ? "py-[5px]" : dense ? "py-1.5" : "py-2"}`}
      >
        {oneLine ? (
          <span className={`flex w-full items-center gap-2 ${clear}`}>
            {place}
            {titleText}
            {statusText}
          </span>
        ) : (
          <>
            <span
              className={`flex h-4.5 w-full items-center gap-2 text-meta text-faint-foreground ${clear}`}
            >
              <span className="flex min-w-0 flex-1 items-center">{place}</span>
              {statusText}
            </span>
            {titleText}
          </>
        )}
        {details}
      </Main>
      {(actions || trailing) && (
        <div
          ref={watchTools}
          className={`absolute top-1 right-1 flex items-center gap-0.5 [&_button]:cursor-pointer ${editing ? "hidden" : ""}`}
        >
          {actions && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100">
              {actions}
            </div>
          )}
          {trailing}
        </div>
      )}
      {children}
    </li>
  );
}

/** A small icon button for a row's tools, as Snooze, the actions menu, a pin, or a draft's X; its icon sets its own size. */
export const rowTool =
  "grid size-5.5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground";
