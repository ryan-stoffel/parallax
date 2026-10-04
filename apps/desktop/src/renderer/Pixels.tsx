import type { CSSProperties } from "react";

/**
 * A 3 by 3 dot matrix for tasks about to start: a plus for one, and a dot a task for a list, up to
 * nine. In currentColor, with the rest of the grid faint.
 */
export function PixelStack({ count }: { count: number }) {
  const plus = [1, 3, 4, 5, 7];
  const lit = (i: number) => (count > 1 ? i < Math.min(count, 9) : plus.includes(i));
  return (
    <span aria-hidden className="grid size-3.5 shrink-0 grid-cols-3 gap-[1.5px] p-px">
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          className={`rounded-[1px] bg-current transition-opacity duration-150 ${lit(i) ? "opacity-100" : "opacity-20"}`}
        />
      ))}
    </span>
  );
}

/** One square of a `PixelField`. */
export interface Pixel {
  id: string;
  /** What it stands for, which sets its shade. */
  tone: "memory" | "note" | "learned" | "proposal";
  /** Shown on hover. */
  title: string;
  /** New since the user last looked: it lights up as it arrives. */
  fresh?: boolean;
}

const tones: Record<Pixel["tone"], string> = {
  memory: "bg-foreground/55",
  note: "bg-foreground/30",
  learned: "bg-accent",
  proposal: "bg-warning",
};

// A stable spread of delays, so the field's shimmer doesn't move in step.
const delayOf = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 4000);
};

/**
 * A field of small squares, one for each thing a Project knows, in the order it was learned, so
 * it fills as the Project grows. Fresh ones arrive with a pixel fade, and with `live` a few
 * shimmer now and then, as agents add to it. Decoration: what each stands for is listed in text.
 */
export function PixelField({
  pixels,
  live,
  slots = 48,
}: {
  pixels: readonly Pixel[];
  live?: boolean;
  /** Empty squares to draw at least, so a young Project shows room to grow. */
  slots?: number;
}) {
  const empty = Math.max(0, slots - pixels.length);
  return (
    <div aria-hidden className="grid grid-cols-[repeat(auto-fill,7px)] gap-[3px]">
      {pixels.map((p) => (
        <span
          key={p.id}
          title={p.title}
          className={`size-[7px] rounded-[1.5px] ${tones[p.tone]} ${p.fresh ? "pixel-in" : ""} ${live ? "pixel-twinkle" : ""}`}
          style={{ "--pixel-delay": `${-delayOf(p.id)}ms` } as CSSProperties}
        />
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <span key={i} className="size-[7px] rounded-[1.5px] bg-foreground/[0.06]" />
      ))}
    </div>
  );
}
