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

// A tab's inset from the composer's edges, 20px at the front and 10px more per tab behind it.
const inset = (depth: number) => ({ marginInline: 20 + depth * 10 });

/**
 * The tabs tucked over a composer, such as the plan, the queue, and what a thread waits on, given
 * back to front and stacked as folders in a file cabinet: each sits a little narrower than the one
 * in front, and its foot tucks behind it. The front two show; the rest fold behind one more tab
 * that names them and opens them all. Folded tabs stay mounted, so their state lives on.
 */
export function ComposerTabs({ tabs }: { tabs: readonly ComposerTab[] }) {
  const [expanded, setExpanded] = useState(false);
  const folding = tabs.length > shown;
  const folded = folding && !expanded ? tabs.length - shown : 0;
  if (tabs.length === 0) return null;
  return (
    <div role="group" aria-label="Composer tabs" className="flex flex-col">
      {folding && (
        <div className="relative -mb-4" style={inset(tabs.length - folded)}>
          <section
            aria-label="More tabs"
            className="rounded-t-3xl border border-b-0 border-border bg-surface pb-4"
          >
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((was) => !was)}
              className="flex w-full min-w-0 items-center gap-2 rounded-t-3xl py-1.5 pr-3.5 pl-4 text-left text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
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
        </div>
      )}
      {tabs.map((tab, i) => (
        <div
          key={tab.key}
          hidden={i < folded}
          className="relative -mb-4"
          style={inset(tabs.length - 1 - i)}
        >
          {tab.node}
        </div>
      ))}
    </div>
  );
}
