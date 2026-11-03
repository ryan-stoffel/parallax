import { ArrowLeftRight, Columns2, PanelTop, Rows2 } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { tileDragType } from "./threadDrag";
import {
  clampRatio,
  evenRatio,
  fittingTiles,
  maxTiles,
  ratioAt,
  tileAt,
  tileLayout,
  type Rect,
} from "./splitLayout";

/** How far an arrow key moves a focused divider. */
const keyStep = 0.05;

/** A rect as CSS, inset by `inset` pixels on every side. */
const placed = (r: Rect, inset = 0): CSSProperties => ({
  left: `calc(${r.left * 100}% + ${inset}px)`,
  top: `calc(${r.top * 100}% + ${inset}px)`,
  width: `calc(${r.width * 100}% - ${inset * 2}px)`,
  height: `calc(${r.height * 100}% - ${inset * 2}px)`,
});

/** One thread in the split: its chat. */
export interface TileItem {
  key: string;
  node: ReactNode;
}

/** Where a thread dragged over the split would open, and the box that previews it. */
interface DropTarget {
  at: number;
  rect: Rect;
  label: "beside" | "tab" | "replace" | "swap";
}

/**
 * The split's threads tiled in their Fibonacci layout (splitLayout.ts). With `tiled` off it holds
 * one thread, full size. Tiled, a line marks the focused one, and as many threads tile as keep
 * `minTile`: the rest stack in the last tile, which shows the focused one, or the last one shown.
 * `maximized` stacks them all in one tile. The top bar's tab names them all and picks among them.
 * Chats are siblings keyed by `key`, so a tile coming, going, or stacking never remounts the
 * others, and they glide to their places.
 *
 * A divider on each cut drags or arrow-keys to resize and double-clicks back to even. A drag shows
 * its ratios here and hands them up once it ends, so App doesn't render on every move. `details`
 * floats over the focused thread's tile. A thread `drop` accepts, dragged over, previews where it
 * would open: a new tile while there's room, as a tab once one won't fit, or in place of the tile
 * under the pointer when the split is full. A tile dragged from the top bar's tab, `draggedTile`,
 * swaps with the one under the pointer.
 */
export function SplitTiles({
  items,
  tiled,
  focused,
  ratios,
  onResize,
  maximized,
  onSwap,
  draggedTile,
  details,
  drop,
}: {
  items: TileItem[];
  tiled: boolean;
  focused: number;
  ratios: number[];
  onResize: (ratios: number[]) => void;
  maximized: boolean;
  onSwap: (from: number, to: number) => void;
  draggedTile: () => number | undefined;
  details?: ReactNode;
  drop?: { accepts: (e: DragEvent) => boolean; onDrop: (at: number, e: DragEvent) => void };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = box.current!;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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

  const n = items.length;
  const fit = (count: number, cuts: readonly number[]) =>
    fittingTiles(count, cuts, size.width, size.height);
  // How many tiles show; the last holds the threads from `last` on, as tabs.
  const visible = !tiled ? n : maximized ? 1 : fit(n, shown);
  const last = visible - 1;
  const { tiles, cuts } = tileLayout(visible, shown);
  // The stack's shown thread: the focused one when it's there, else the one shown last.
  const stackShown = useRef<string>(undefined);
  if (focused >= last) stackShown.current = items[focused]?.key;
  const remembered = items.findIndex((item, i) => i >= last && item.key === stackShown.current);
  const stackActive = focused >= last ? focused : remembered === -1 ? last : remembered;
  const tileOf = (i: number) => Math.min(i, last);
  const activeIn = (tile: number) => (tile === last ? stackActive : tile);

  // `shown` with cut `cut` at `ratio`, or undefined when that would stack a tile that shows now,
  // taking away the divider that could bring it back.
  const resize = (cut: number, ratio: number) => {
    const next = [...shown];
    next[cut] = ratio;
    return fit(n, next) < visible ? undefined : next;
  };

  const [target, setTarget] = useState<DropTarget>();
  const tileUnder = (e: DragEvent<HTMLElement>) => {
    const r = box.current!.getBoundingClientRect();
    return tileAt(tiles, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const targetOf = (e: DragEvent<HTMLElement>): DropTarget | undefined => {
    if (e.dataTransfer.types.includes(tileDragType)) {
      const tile = tileUnder(e);
      const dragged = draggedTile();
      if (dragged === undefined || tile === tileOf(dragged)) return undefined;
      return { at: activeIn(tile), rect: tiles[tile]!, label: "swap" };
    }
    if (!drop?.accepts(e)) return undefined;
    if (n < maxTiles) {
      // A new thread unmaximizes the split, as Open side by side asks for.
      const next = [...ratios, evenRatio];
      const fits = fit(n + 1, next);
      return fits === n + 1
        ? { at: n, rect: tileLayout(n + 1, next).tiles[n]!, label: "beside" }
        : { at: n, rect: tileLayout(fits, next).tiles[fits - 1]!, label: "tab" };
    }
    const tile = tileUnder(e);
    return { at: activeIn(tile), rect: tiles[tile]!, label: "replace" };
  };
  const over = (e: DragEvent<HTMLElement>) => {
    const next = targetOf(e);
    setTarget(next);
    if (!next) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  // The cut a new tile makes: side by side after an odd count, top and bottom after an even one.
  const NewCut = n % 2 === 1 ? Columns2 : Rows2;

  return (
    <div
      ref={box}
      data-resizing={live ? "" : undefined}
      className="group/tiles relative min-h-0 min-w-0 flex-1"
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(undefined);
      }}
      onDrop={(e) => {
        const next = targetOf(e);
        setTarget(undefined);
        if (!next) return;
        e.preventDefault();
        if (next.label === "swap") onSwap(draggedTile()!, next.at);
        else drop!.onDrop(next.at, e);
      }}
    >
      {items.map(({ key, node }, i) => {
        const tile = tileOf(i);
        const active = activeIn(tile) === i;
        return (
          <div
            key={key}
            // A stacked thread behind its tile's tab stays mounted, out of sight and reach.
            inert={!active}
            style={placed(tiles[tile]!)}
            className={`absolute flex min-h-0 min-w-0 transition-[left,top,width,height,visibility] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none ${active ? "z-[1] bg-pane" : "invisible"} ${tiles[tile]!.left > 0 ? "border-l border-border" : ""} ${tiles[tile]!.top > 0 ? "border-t border-border" : ""}`}
          >
            {tiled && i === focused && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-0.5 bg-accent"
              />
            )}
            {node}
            {i === focused && details}
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
          const next = resize(i, clampRatio((shown[i] ?? evenRatio) + step * keyStep));
          if (next) onResize(next);
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
              const next = resize(i, ratioAt(cut, x, y));
              if (!next) return;
              drag.current.ratios = next;
              setLive(next);
            }}
            onPointerUp={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={() => {
              const next = resize(i, evenRatio);
              if (next) onResize(next);
            }}
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
          style={placed(target.rect, 8)}
          className="pointer-events-none absolute z-20 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-background/85 backdrop-blur-sm transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
        >
          <span className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-body font-medium text-accent-foreground [&_svg]:size-4">
            {target.label === "tab" ? (
              <PanelTop />
            ) : target.label === "swap" ? (
              <ArrowLeftRight />
            ) : (
              <NewCut />
            )}
            {target.label === "beside"
              ? "Open side by side"
              : target.label === "tab"
                ? "Open as a tab"
                : target.label === "swap"
                  ? "Swap"
                  : "Open here"}
          </span>
        </div>
      )}
    </div>
  );
}
