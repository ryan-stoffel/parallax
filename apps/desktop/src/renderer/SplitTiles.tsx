import { Columns2, Rows2 } from "lucide-react";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { clampRatio, evenRatio, ratioAt, tileLayout, type Rect } from "./splitLayout";

/** A rect as CSS, inset by `inset` pixels on every side. */
const placed = (r: Rect, inset = 0): CSSProperties => ({
  left: `calc(${r.left * 100}% + ${inset}px)`,
  top: `calc(${r.top * 100}% + ${inset}px)`,
  width: `calc(${r.width * 100}% - ${inset * 2}px)`,
  height: `calc(${r.height * 100}% - ${inset * 2}px)`,
});

/** How far an arrow key moves a focused divider. */
const keyStep = 0.05;

/**
 * The split's threads tiled in their Fibonacci layout (splitLayout.ts), each node in its tile,
 * with a divider on each cut that drags or arrow-keys to resize and double-clicks back to even.
 * Tiles are siblings keyed by `key`, so one coming or going never remounts the others, and they
 * glide to their new places. A drag shows its ratios here and hands them up once it ends, so App
 * doesn't render on every move. `drop` outlines the tile a thread dragged over would fill: one
 * more tile's last, or `replace`'s.
 */
export function SplitTiles({
  items,
  ratios,
  onResize,
  drop,
}: {
  items: { key: string; node: ReactNode }[];
  ratios: number[];
  onResize: (ratios: number[]) => void;
  drop?: { replace?: number };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number[]>();
  // The cut being dragged and its latest ratios, read by pointer events that may land before a render.
  const drag = useRef<{ cut: number; ratios: number[] }>(undefined);
  const shown = live ?? ratios;
  const endDrag = () => {
    if (!drag.current) return;
    onResize(drag.current.ratios);
    drag.current = undefined;
    setLive(undefined);
  };
  const { tiles, cuts } = tileLayout(items.length, shown);
  const resize = (cut: number, ratio: number) => {
    const next = [...shown];
    next[cut] = ratio;
    return next;
  };
  const next = drop && drop.replace === undefined;
  const target = drop
    ? next
      ? tileLayout(items.length + 1, [...ratios, evenRatio]).tiles[items.length]
      : tiles[drop.replace!]
    : undefined;
  // The cut a new tile makes: side by side after an odd count, top and bottom after an even one.
  const NewCut = items.length % 2 === 1 ? Columns2 : Rows2;
  return (
    <div
      ref={box}
      data-resizing={live ? "" : undefined}
      className="group/tiles relative min-h-0 min-w-0 flex-1"
    >
      {items.map(({ key, node }, i) => {
        const t = tiles[i]!;
        return (
          <div
            key={key}
            style={placed(t)}
            className={`absolute flex min-h-0 min-w-0 transition-[left,top,width,height] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none ${t.left > 0 ? "border-l border-border" : ""} ${t.top > 0 ? "border-t border-border" : ""}`}
          >
            {node}
          </div>
        );
      })}
      {cuts.map((cut, i) => {
        const t = tiles[i]!;
        const { region, vertical } = cut;
        // A strip 9px across centered on the line, along the region it cuts. After the first, it
        // starts clear of the cut before's strip, which keeps the corner they share.
        const clear = i > 0 ? 5 : 0;
        const style: CSSProperties = vertical
          ? {
              left: `calc(${(t.left + t.width) * 100}% - 4px)`,
              top: `calc(${region.top * 100}% + ${clear}px)`,
              width: 9,
              height: `calc(${region.height * 100}% - ${clear}px)`,
            }
          : {
              top: `calc(${(t.top + t.height) * 100}% - 4px)`,
              left: `calc(${region.left * 100}% + ${clear}px)`,
              height: 9,
              width: `calc(${region.width * 100}% - ${clear}px)`,
            };
        const keyed = (e: KeyboardEvent) => {
          const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
          if (step === undefined) return;
          e.preventDefault();
          const ratio = clampRatio((shown[i] ?? evenRatio) + step * keyStep);
          onResize(resize(i, ratio));
        };
        return (
          <div
            key={`cut-${i}`}
            role="separator"
            tabIndex={0}
            aria-label="Resize threads"
            aria-orientation={vertical ? "vertical" : "horizontal"}
            aria-valuenow={Math.round((shown[i] ?? evenRatio) * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            title="Drag to resize, double-click to even out"
            style={style}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { cut: i, ratios: shown };
              setLive(shown);
            }}
            onPointerMove={(e) => {
              if (drag.current?.cut !== i) return;
              const r = box.current!.getBoundingClientRect();
              const x = (e.clientX - r.left) / r.width;
              const y = (e.clientY - r.top) / r.height;
              drag.current.ratios = resize(i, ratioAt(cut, x, y));
              setLive(drag.current.ratios);
            }}
            onPointerUp={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={() => onResize(resize(i, evenRatio))}
            onKeyDown={keyed}
            className={`group/cut absolute z-10 flex items-center justify-center outline-none ${vertical ? "cursor-col-resize" : "cursor-row-resize"}`}
          >
            <span
              aria-hidden
              className={`rounded-full bg-accent opacity-0 transition-opacity duration-150 group-hover/cut:opacity-100 group-focus-visible/cut:opacity-100 group-active/cut:opacity-100 ${vertical ? "h-full w-0.5" : "h-0.5 w-full"}`}
            />
          </div>
        );
      })}
      {target && (
        <div
          aria-hidden
          style={placed(target, 8)}
          className="pointer-events-none absolute z-20 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-background/85 backdrop-blur-sm transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
        >
          <span className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-body font-medium text-accent-foreground [&_svg]:size-4">
            <NewCut />
            {next ? "Open side by side" : "Open here"}
          </span>
        </div>
      )}
    </div>
  );
}

/** A small map of a split of `count` threads at even sizes, tile `index` filled. */
export function TileGlyph({ count, index }: { count: number; index: number }) {
  const { tiles } = tileLayout(count, []);
  // 16 by 12, its tiles 1px apart inside a 1px frame.
  const w = 16;
  const h = 12;
  return (
    <svg aria-hidden viewBox={`0 0 ${w} ${h}`} className="h-3 w-4 shrink-0">
      <rect
        x={0.5}
        y={0.5}
        width={w - 1}
        height={h - 1}
        rx={2}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
      />
      {tiles.map((t, i) => (
        <rect
          key={i}
          x={2 + t.left * (w - 4) + (t.left > 0 ? 0.5 : 0)}
          y={2 + t.top * (h - 4) + (t.top > 0 ? 0.5 : 0)}
          width={t.width * (w - 4) - (t.left > 0 ? 0.5 : 0) - (t.left + t.width < 1 ? 0.5 : 0)}
          height={t.height * (h - 4) - (t.top > 0 ? 0.5 : 0) - (t.top + t.height < 1 ? 0.5 : 0)}
          rx={0.75}
          fill="currentColor"
          fillOpacity={i === index ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}
