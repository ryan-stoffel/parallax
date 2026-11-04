import { Columns2, PanelTop, Rows2 } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ThreadTabs, type TabDrop, type TabItem } from "./ThreadTabs";
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

/** The gap around a card in pixels, half of what shows between two. */
const gutter = 3;

/** The height of a card's row of tabs in pixels, `h-10`. */
const stripHeight = 40;

/** How far an arrow key moves a focused divider. */
const keyStep = 0.05;

/** A rect as CSS, inset by `inset` pixels on every side and `top` more from its top. */
const placed = (r: Rect, inset = 0, top = 0): CSSProperties => ({
  left: `calc(${r.left * 100}% + ${inset}px)`,
  top: `calc(${r.top * 100}% + ${inset + top}px)`,
  width: `calc(${r.width * 100}% - ${inset * 2}px)`,
  height: `calc(${r.height * 100}% - ${inset * 2 + top}px)`,
});

/** One pane: its tabs, the one it shows, and that tab's view. */
export interface TileItem {
  /** The shown tab's view, so another tab starts from a fresh one. */
  key: string;
  paneId: string;
  tabs: TabItem[];
  active: string;
  node: ReactNode;
}

/** Where a thread dragged over the split would open, and the box that previews it. */
interface DropTarget {
  at: number;
  rect: Rect;
  label: "beside" | "tab" | "here";
}

/**
 * The window's panes, as cards in their Fibonacci layout (splitLayout.ts) on the window's background.
 * Each card has a row of tabs above it, on the window's background. `leading` starts the first card's
 * row, and `controls` end the top right card's, giving up their room to its tabs when it's narrow. As
 * many panes tile as keep `minTile`: the rest stack in the
 * last tile, which shows the focused one, or the last one shown, and lists all their tabs. `maximized`
 * stacks them all in one tile. Views are siblings keyed by `key`, so a tile coming, going, or stacking
 * never remounts the others, and they glide to their places.
 *
 * A divider on each cut drags or arrow-keys to resize and double-clicks back to even. A drag shows
 * its ratios here and hands them up once it ends, so App doesn't render on every move. `details`
 * floats over the focused pane's card. A tab or sidebar thread `drop` accepts, dragged over a card,
 * previews where it would open: a new pane while there's room, else a tab in the pane under the
 * pointer, or the last pane when a new one wouldn't fit.
 */
export function SplitTiles({
  items,
  focused,
  ratios,
  onResize,
  maximized,
  leading,
  leadingClass = "",
  controls,
  controlsClass = "",
  closable,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onDropOnTabs,
  details,
  drop,
}: {
  items: TileItem[];
  focused: number;
  ratios: number[];
  onResize: (ratios: number[]) => void;
  maximized: boolean;
  leading?: ReactNode;
  leadingClass?: string;
  controls?: ReactNode;
  controlsClass?: string;
  closable: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: (paneId: string) => void;
  onDropOnTabs: (drop: TabDrop, paneId: string, before?: string) => void;
  details?: ReactNode;
  drop?: {
    accepts: (e: DragEvent) => boolean;
    /** With the pane the drop goes in, or undefined for a new one. */
    onDrop: (paneId: string | undefined, e: DragEvent) => void;
  };
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
  const visible = maximized ? 1 : fit(n, shown);
  const last = visible - 1;
  const { tiles, cuts } = tileLayout(visible, shown);
  // The stack's shown thread: the focused one when it's there, else the one shown last.
  const stackShown = useRef<string>(undefined);
  if (focused >= last) stackShown.current = items[focused]?.paneId;
  const remembered = items.findIndex((item, i) => i >= last && item.paneId === stackShown.current);
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
    // The row of tabs takes its own drops.
    if (!drop?.accepts(e) || (e.target as Element).closest(".titlebar")) return undefined;
    if (n < maxTiles) {
      const next = [...ratios, evenRatio];
      const fits = fit(n + 1, next);
      return fits === n + 1
        ? { at: n, rect: tileLayout(n + 1, next).tiles[n]!, label: "beside" }
        : { at: activeIn(last), rect: tiles[last]!, label: "tab" };
    }
    const tile = tileUnder(e);
    return { at: activeIn(tile), rect: tiles[tile]!, label: "here" };
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
        drop!.onDrop(next.label === "beside" ? undefined : items[next.at]!.paneId, e);
      }}
    >
      {tiles.map((rect, tile) => {
        const group = tile === last ? items.map((_, i) => i).slice(last) : [tile];
        const shownPane = items[activeIn(tile)]!;
        // The top right card.
        const corner = tile === Math.min(1, last);
        return (
          <div
            key={`frame-${tile}`}
            // A pixel into the card, for the shown tab's foot to cover the card's top edge.
            style={{ ...placed(rect, gutter), height: stripHeight + 1 }}
            className={`titlebar @container absolute z-[2] flex items-stretch transition-[left,top,width] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none`}
          >
            <div
              className={`-ml-1.5 flex min-w-40 shrink items-center gap-1 pr-1 ${tile === 0 && leading ? `pl-3 ${leadingClass}` : "pl-3.5"}`}
            >
              {tile === 0 && leading}
              <ThreadTabs
                tabs={group.flatMap((i) => items[i]!.tabs)}
                active={shownPane.active}
                focused={group.includes(focused)}
                marked={group.includes(focused) && visible > 1}
                onSelect={onSelectTab}
                onClose={onCloseTab}
                onNew={() => onNewTab(shownPane.paneId)}
                onDrop={(tabDrop, before) => {
                  // Among stacked panes, the one holding the tab it lands before, or the last.
                  const holder = group.find((i) => items[i]!.tabs.some((t) => t.id === before));
                  onDropOnTabs(tabDrop, items[holder ?? group.at(-1)!]!.paneId, before);
                }}
                closable={closable}
              />
            </div>
            <div className="min-w-3 flex-1" />
            {corner && controls && (
              <div
                className={`flex min-w-0 shrink items-center justify-end gap-2 overflow-clip pr-1.5 pb-px pl-3 ${controlsClass}`}
              >
                {controls}
              </div>
            )}
          </div>
        );
      })}
      {items.map(({ key, node }, i) => {
        const tile = tileOf(i);
        const active = activeIn(tile) === i;
        return (
          <div
            key={key}
            // A stacked pane's view stays mounted, out of sight and reach.
            inert={!active}
            style={placed(tiles[tile]!, gutter, stripHeight)}
            data-marked={visible > 1 && i === focused ? "" : undefined}
            className={`pane-edge pane-card absolute flex min-h-0 min-w-0 overflow-clip rounded-xl transition-[left,top,width,height,visibility] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none ${active ? "z-[1] bg-pane" : "invisible"}`}
          >
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
          className="pointer-events-none absolute z-20 grid place-items-center rounded-xl border-2 border-accent bg-background/85 backdrop-blur-sm transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
        >
          <span className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-body font-medium text-accent-foreground [&_svg]:size-4">
            {target.label === "beside" ? <NewCut /> : <PanelTop />}
            {target.label === "beside"
              ? "Open side by side"
              : target.label === "tab"
                ? "Open as a tab"
                : "Open here"}
          </span>
        </div>
      )}
    </div>
  );
}
