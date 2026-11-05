import type { ReactNode } from "react";

import { DiffLineView } from "../ChangesDiff";
import { icons } from "../icons";
import { suggestionLines } from "./suggestions";

/** A suggested change, as GitHub draws one: the lines it replaces, and what with. */
export function Suggestion({
  before,
  after,
  start,
  children,
}: {
  before: string[];
  after: string[];
  start: number;
  /** What can be done with it, under its lines. */
  children?: ReactNode;
}) {
  return (
    <figure
      aria-label="Suggested change"
      className="overflow-hidden rounded-lg border border-border bg-code"
    >
      <figcaption className="flex h-8 items-center gap-1.5 border-b border-border px-2.5 text-meta text-muted-foreground">
        <icons.suggest aria-hidden className="size-3.5" />
        {after.length ? "Suggested change" : "Suggests deleting"}
      </figcaption>
      <div className="font-mono text-meta leading-5">
        {suggestionLines(before, after, start).map((line, i) => (
          <DiffLineView key={i} line={line} />
        ))}
      </div>
      {children && (
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
          {children}
        </div>
      )}
    </figure>
  );
}
