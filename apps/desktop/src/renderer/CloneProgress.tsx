import { LoaderCircle } from "lucide-react";

/**
 * git's progress line, such as `Receiving objects:  42% (420/1000), 12.40 MiB | 6.20 MiB/s`, as
 * its phase, percent, and what follows the count. A line that isn't one is all phase.
 */
export function parseProgress(line: string): { phase: string; percent?: number; detail?: string } {
  const text = line.replace(/^remote:\s*/, "");
  const match = /^([^:]+):\s+(\d+)%(?:\s*\(\d+\/\d+\))?,?\s*(.*?)(?:,?\s*done\.)?$/.exec(text);
  if (!match) return { phase: text };
  const detail = match[3]!.replaceAll(" | ", " · ");
  return { phase: match[1]!, percent: Number(match[2]), ...(detail && { detail }) };
}

/**
 * A clone under way (PLX-905): `title`, then a bar with git's phase and percent from `line`, its
 * latest progress line. With no line yet the bar pulses. `cloning` false, while a repository is
 * only being added, shows the title alone.
 */
export function CloneProgress({
  title,
  line,
  cloning = true,
}: {
  title: string;
  line?: string;
  cloning?: boolean;
}) {
  const progress = line ? parseProgress(line) : undefined;
  const percent = progress?.percent;
  return (
    <div role="status" className="rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="flex items-center gap-2 text-body">
        <LoaderCircle
          aria-hidden
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {percent !== undefined && (
          <span className="text-muted-foreground tabular-nums">{percent}%</span>
        )}
      </div>
      {cloning && (
        <>
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-hover">
            <div
              className={`h-full rounded-full bg-accent transition-[width] duration-500 ${percent === undefined ? "w-1/4 animate-pulse" : ""}`}
              style={percent === undefined ? undefined : { width: `${percent}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between gap-3 text-meta text-muted-foreground">
            <span className="truncate">{progress?.phase ?? "Connecting…"}</span>
            {progress?.detail && <span className="shrink-0 tabular-nums">{progress.detail}</span>}
          </div>
        </>
      )}
    </div>
  );
}
