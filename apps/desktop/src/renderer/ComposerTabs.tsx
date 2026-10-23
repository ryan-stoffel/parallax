import { ChevronDown, ChevronUp } from "lucide-react";
import { useState, type ReactNode } from "react";

/** One tab over the composer: `label` names it on the tab that counts the folded ones. */
export interface ComposerTab {
  key: string;
  label: string;
  node: ReactNode;
}

// The tabs that show before the rest fold away.
const shown = 2;

/**
 * The tabs tucked over a composer, such as the plan, the queue, and what a thread waits on, given
 * back to front as rows of one panel, a divider between each, whose foot tucks behind the
 * composer. Each tab is a bare row: the panel draws the frame. The front two show; the rest fold
 * behind one more row that names them and opens them all. Folded tabs stay mounted, so their
 * state lives on.
 */
export function ComposerTabs({ tabs }: { tabs: readonly ComposerTab[] }) {
  const [expanded, setExpanded] = useState(false);
  const folding = tabs.length > shown;
  // Opened tabs fold again once there are too few to fold, so the next ones to come start folded.
  if (expanded && !folding) setExpanded(false);
  const folded = folding && !expanded ? tabs.length - shown : 0;
  if (tabs.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Composer tabs"
      className="relative mx-5 -mb-4 flex flex-col divide-y divide-border overflow-hidden rounded-t-3xl border border-b-0 border-border bg-surface pb-4"
    >
      {folding && (
        <section aria-label="More tabs">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((was) => !was)}
            className="flex w-full min-w-0 items-center gap-2 py-1.5 pr-3.5 pl-4 text-left text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            {expanded ? (
              <span className="flex-1">Show fewer</span>
            ) : (
              <>
                <span className="shrink-0 font-medium">{folded} more</span>
                <span className="min-w-0 flex-1 truncate text-faint-foreground">
                  {tabs
                    .slice(0, folded)
                    .map((tab) => tab.label)
                    .join(", ")}
                </span>
              </>
            )}
            {expanded ? (
              <ChevronDown aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <ChevronUp aria-hidden className="size-3.5 shrink-0" />
            )}
          </button>
        </section>
      )}
      {tabs.map((tab, i) => (
        <div key={tab.key} hidden={i < folded}>
          {tab.node}
        </div>
      ))}
    </div>
  );
}
