import { Target } from "lucide-react";

export { pursuedGoal } from "./transcript";

/**
 * The goal the run is working toward, above the composer while it runs. `compact` names it only in
 * its tooltip, for a place beside other tabs.
 */
export function GoalStrip({ objective, compact }: { objective: string; compact?: boolean }) {
  return (
    <section
      aria-label="Goal"
      title={objective}
      className={`plan-strip flex min-w-0 items-center text-[13px] ${compact ? "h-7 gap-1.5 px-1.5 text-muted-foreground" : "gap-2.5 py-1.5 pr-3.5 pl-4"}`}
    >
      <Target aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className={compact ? "text-[12.5px]" : "shrink-0 font-medium"}>
        {compact ? "Goal" : "Pursuing goal"}
      </span>
      {!compact && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{objective}</span>
      )}
    </section>
  );
}
