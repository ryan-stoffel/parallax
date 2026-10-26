import type { ReactNode } from "react";

/** One tab over the composer: `node` as its own row, `compact` as an item beside others. */
export interface ComposerTab {
  key: string;
  node: ReactNode;
  /** A short form, such as an icon and a count, that opens the rest. Else `node` is used. */
  compact?: ReactNode;
}

/**
 * The tabs tucked over a composer, such as the subagents, the plan, the queue, and what a thread
 * waits on, given back to front as one line whose foot tucks behind the composer. The first tab
 * takes the line's free room as its full row; the rest sit after it in their compact form, so
 * the line never grows past one row. The tray is a shade under the box, so it reads as behind it,
 * and each tab's hover is a rounded piece of it. `short`, over a box that stepped back, trims the
 * line's height to match the box's one row.
 */
export function ComposerTabs({
  tabs,
  short = false,
}: {
  tabs: readonly ComposerTab[];
  short?: boolean;
}) {
  if (tabs.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Composer tabs"
      className={`relative mx-5 -mb-4 flex min-w-0 items-center gap-0.5 overflow-hidden rounded-t-xl border border-b-0 border-border bg-[color-mix(in_oklab,var(--foreground)_3%,var(--surface))] px-1 ${short ? "pt-0.5 pb-4.5" : "pt-1 pb-5"}`}
    >
      {tabs.map((tab, i) => (
        <div
          key={tab.key}
          // Clipped, so a tab sliding in rises from its own place, not over the one beside it, and
          // a short line cuts only its rows' padding.
          className={`overflow-hidden rounded-lg ${short ? "h-6" : ""} ${i === 0 ? "grid min-w-0 flex-1 content-center" : "flex shrink-0 items-center gap-0.5 before:h-3.5 before:w-px before:bg-border"}`}
        >
          {i === 0 ? tab.node : (tab.compact ?? tab.node)}
        </div>
      ))}
    </div>
  );
}
