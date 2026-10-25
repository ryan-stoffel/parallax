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
 * the line never grows past one row.
 */
export function ComposerTabs({ tabs }: { tabs: readonly ComposerTab[] }) {
  if (tabs.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Composer tabs"
      className="relative mx-5 -mb-4 flex min-w-0 items-center overflow-hidden rounded-t-2xl border border-b-0 border-border bg-surface pr-1.5 pb-4"
    >
      {tabs.map((tab, i) => (
        <div
          key={tab.key}
          // Clipped, so a tab sliding in rises from its own place, not over the one beside it.
          className={`overflow-hidden ${i === 0 ? "min-w-0 flex-1" : "flex shrink-0 items-center before:mr-0.5 before:h-4 before:w-px before:bg-border"}`}
        >
          {i === 0 ? tab.node : (tab.compact ?? tab.node)}
        </div>
      ))}
    </div>
  );
}
