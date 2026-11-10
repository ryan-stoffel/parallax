import type { ReactNode } from "react";

import { DiffLineView } from "../ChangesDiff";
import { icons } from "../icons";
import { Button } from "../ui";
import type { ThreadView } from "./model";
import { suggestionLines } from "./suggestions";

/** Applying suggestions: the ones in the batch, and what a click on one does. */
export type SuggestionActions = {
  /** Why none can apply here, such as no push access. */
  blocked?: string;
  batch: ReadonlySet<string>;
  onCommit: (commentId: string) => void;
  onToggleBatch: (commentId: string) => void;
};

/** Commit and Add to batch, or why not, for the suggestion in `commentId` on `thread`. */
export function SuggestionButtons({
  commentId,
  thread,
  actions,
}: {
  commentId: string;
  thread: ThreadView;
  actions: SuggestionActions;
}) {
  const reason =
    actions.blocked ??
    (thread.outdated
      ? "Outdated: the code changed since this was suggested"
      : thread.side === "left"
        ? "It's on a removed line"
        : undefined);
  if (reason) return <span className="px-1 text-meta text-faint-foreground">{reason}</span>;
  const inBatch = actions.batch.has(commentId);
  return (
    <>
      <Button size="sm" onClick={() => actions.onToggleBatch(commentId)}>
        {inBatch ? "Remove from batch" : "Add to batch"}
      </Button>
      <Button size="sm" variant="outline" onClick={() => actions.onCommit(commentId)}>
        <icons.commit aria-hidden />
        Commit suggestion
      </Button>
    </>
  );
}

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
