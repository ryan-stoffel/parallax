import { Target } from "lucide-react";

import type { Item } from "./transcript";

/**
 * The goal the user's latest message set with `/goal <objective>` (PLX-749), which Claude Code
 * and Codex keep working toward until it is met. `/goal clear` sets none.
 */
// ponytail: a later message from the user hides the goal even if the CLI still pursues it; read
// the CLI's goal state if that matters.
export function pursuedGoal(items: readonly Item[]): string | undefined {
  const last = items.findLast((i) => i.kind === "user" && !i.wake && i.from === undefined);
  if (last?.kind !== "user" || !last.text || last.images?.length) return undefined;
  const objective = /^\/goal\s+(.+)$/is.exec(last.text.trim())?.[1]?.trim();
  return objective?.toLowerCase() === "clear" ? undefined : objective;
}

/** The goal the run is working toward, above the composer while it runs. */
export function GoalStrip({ objective }: { objective: string }) {
  return (
    <section
      aria-label="Goal"
      title={objective}
      className="plan-strip flex min-w-0 items-center gap-2.5 py-1.5 pr-3.5 pl-4 text-[13px]"
    >
      <Target aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">Pursuing goal</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{objective}</span>
    </section>
  );
}
