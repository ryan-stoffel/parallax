import { ArrowUpRight } from "lucide-react";

/**
 * The arrow a row shows on hover or focus to say it opens that chat. Its row needs `group`; the
 * space stays reserved so the row doesn't shift.
 */
export function OpenHint() {
  return (
    <ArrowUpRight
      aria-hidden
      className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
    />
  );
}
