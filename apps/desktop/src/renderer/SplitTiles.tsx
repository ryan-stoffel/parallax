import { t } from "i18next";
import { PanelTop, X } from "lucide-react";
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { msg } from "../i18n";
import { ThreadTabs, type TabDrop, type TabItem } from "./ThreadTabs";
import {
  allCells,
  clampRatio,
  dividersOf,
  evenCuts,
  evenRatio,
  fits,
  rectOf,
  tilesOf,
  usedCuts,
  zoneAt,
  zoneCells,
  zoneNames,
  type Cells,
  type GridCuts,
  type Rect,
  type Tile,
  type Zone,
} from "./splitLayout";

/** The gap around a card in pixels, half of what shows between two. */
const gutter = 3;

/** The height of a card's row of tabs in pixels, `h-10`. */
const stripHeight = 40;

/** The height of a classic tile's header in pixels, `h-9`. */
const headerHeight = 36;

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
  cells: Cells;
  tabs: TabItem[];
  active: string;
  node: ReactNode;
}

/** Where a drag over the window would land: a new pane in a zone, or a tab in a pane. */
export type TileDrop = { zone: Zone } | { paneId: string };

/** A landing, and the box that previews it, with its label in English for `t`. */
type DropTarget = TileDrop & { rect: Rect; cells: Cells; label: string };

/**
 * The window's panes, as cards on a grid (splitLayout.ts) on the window's background. Each card has a
 * row of tabs above it. A card whose only tab has no `leading` before it is one shape with that tab,
 * from the card's left edge. With `hideTabs`, the card rises to the window's top, around the row.
 * `leading` starts the first card's row, and `controls` end the top right card's,
 * giving up their room to its tabs when it's narrow. Columns or rows with no room for `minTile` stack,
 * their panes in one tile, which shows the focused one, or the last one shown, and lists all their
 * tabs. `maximized` stacks them all. Views are siblings keyed by `key`, so a tile coming, going, or
 * stacking never remounts the others, and they glide to their places.
 *
 * With `tabs` off, the classic look: panes sit flush, split by lines, with no rows of tabs, and each
 * tile among several has a header naming its panes' views, each with a close button. `leading` and
 * `controls` are left to App's top bar. Stacked or maximized, a tile's header lists its panes.
 *
 * A divider on each line, showing a short grip under the pointer or keyboard focus, drags or arrow-keys
 * to resize and double-clicks back to even. A drag shows
 * its lines here and hands them up once it ends, so App doesn't render on every move. `details` sits
 * in the focused pane's card. It stays as it is until a press ends, so a press in another card doesn't
 * reflow what's under the pointer and lose its click. A tab or sidebar thread `drop` accepts, dragged over the window, previews
 * where it would land: the window's sides, top, bottom, and corners are zones (`zoneAt`), and its
 * middle adds a tab to the pane under the pointer.
 */
export function SplitTiles({
  items,
  focused,
  cuts,
  onResize,
  maximized,
  leading,
  leadingClass = "",
  controls,
  controlsClass = "",
  closable,
  hideTabs,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onDropOnTabs,
  drop,
  details,
  tabs,
}: {
  items: TileItem[];
  focused: number;
  cuts: GridCuts;
  onResize: (cuts: GridCuts) => void;
  maximized: boolean;
  leading?: ReactNode;
  leadingClass?: string;
  controls?: ReactNode;
  controlsClass?: string;
  closable: boolean;
  /** No tabs and no plus, for the window's only tab on plain New thread, whose page says what it is. */
  hideTabs: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: (paneId: string) => void;
  onDropOnTabs: (drop: TabDrop, paneId: string, before?: string) => void;
  drop?: {
    accepts: (e: DragEvent) => boolean;
    onDrop: (target: TileDrop, e: DragEvent) => void;
  };
  details?: ReactNode;
  /** Settings › Beta's Tabs (tabState.ts). */
  tabs: boolean;
}) {
  // `details` as it was when a press began, and the pane it was in, kept until the press ends. A
  // press may never report its release, as when it opens a native menu, which on a Mac Control-click
  // does with the primary button. So a menu or the window losing focus ends it too, and another
  // button never starts one.
  const [held, setHeld] = useState<{ pane: string; details: ReactNode }>();
  const latest = useRef({ pane: items[focused]?.paneId, details });
  latest.current = { pane: items[focused]?.paneId, details };
  const several = items.length > 1;
  useEffect(() => {
    if (!several) return;
    // Captured, so it's read before the press moves focus.
    const press = (e: PointerEvent) => {
      const { pane, details } = latest.current;
      if (e.button === 0 && pane) setHeld({ pane, details });
    };
    // After the click that follows the release.
    const release = () => window.setTimeout(() => setHeld(undefined));
    const ends = ["pointerup", "pointercancel", "contextmenu"];
    window.addEventListener("pointerdown", press, true);
    for (const end of ends) window.addEventListener(end, release, true);
    // Not captured, so it's the window's own and not focus moving inside the page, which a press
    // on a button does.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      for (const end of ends) window.removeEventListener(end, release, true);
      window.removeEventListener("blur", release);
      setHeld(undefined);
    };
  }, [several]);
  // A held pane that closed during the press gives way to the focused one.
  const holding =
    several && held && items.some((item) => item.paneId === held.pane) ? held : undefined;
  const detailsPane = holding?.pane ?? items[focused]?.paneId;
  const shownDetails = holding ? holding.details : details;
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
  const [live, setLive] = useState<GridCuts>();
  // The line being dragged and the latest cuts, read by pointer events that may land before a render.
  const drag = useRef<{ vertical: boolean; cuts: GridCuts }>(undefined);
  const shown = live ?? cuts;
  const endDrag = () => {
    if (!drag.current) return;
    onResize(drag.current.cuts);
    drag.current = undefined;
    setLive(undefined);
  };

  const room = fits(shown, size.width, size.height);
  const tiles: Tile[] = maximized
    ? [{ cells: allCells, panes: items.map((_, i) => i) }]
    : tilesOf(
        items.map((item) => item.cells),
        room,
      );
  const dividers = dividersOf(tiles, shown);
  // Around each card, and above each view: its row of tabs, or its header among several tiles.
  const inset = tabs ? gutter : 0;
  const top = tabs ? (hideTabs ? 0 : stripHeight) : several ? headerHeight : 0;
  // Each stack's shown pane: the focused one when it's there, else the one shown last.
  const stackShown = useRef(new Map<Cells, string>());
  const tileOf = (i: number) => tiles.findIndex((tile) => tile.panes.includes(i));
  // Linux's tabs have no curves to make room for (index.css), so its first tab is always flush.
  const flushOf = (tile: Tile, at: number) =>
    (window.parallax.platform === "linux" ||
      tile.panes.flatMap((i) => items[i]!.tabs).length === 1) &&
    !(at === 0 && leading);
  const activeIn = (tile: Tile) => {
    if (tile.panes.includes(focused)) {
      stackShown.current.set(tile.cells, items[focused]!.paneId);
      return focused;
    }
    const remembered = stackShown.current.get(tile.cells);
    return tile.panes.find((i) => items[i]!.paneId === remembered) ?? tile.panes[0]!;
  };

  // `shown` with a line at `ratio`, or undefined when that would stack tiles that show now, taking
  // away the divider that could bring them back.
  const resize = (vertical: boolean, ratio: number) => {
    const next = vertical ? { ...shown, x: ratio } : { ...shown, y: ratio };
    const after = fits(next, size.width, size.height);
    return (room.columns && !after.columns) || (room.rows && !after.rows) ? undefined : next;
  };

  const [target, setTarget] = useState<DropTarget>();
  const targetOf = (e: DragEvent<HTMLElement>): DropTarget | undefined => {
    // The row of tabs takes its own drops.
    if (!drop?.accepts(e) || (e.target as Element).closest(".titlebar")) return undefined;
    const r = box.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    // The lines the drop would land on, so what's previewed is what it does.
    const landing = usedCuts(
      items.map((item) => item.cells),
      shown,
    );
    const zone = zoneAt(x, y, fits(landing, size.width, size.height));
    if (zone) {
      const cells = zoneCells[zone];
      return { zone, cells, rect: rectOf(cells, landing), label: zoneNames[zone] };
    }
    const under = tiles.find((tile) => {
      const t = rectOf(tile.cells, shown);
      return x >= t.left && x < t.left + t.width && y >= t.top && y < t.top + t.height;
    });
    const tile = under ?? tiles[0]!;
    return {
      paneId: items[activeIn(tile)]!.paneId,
      cells: tile.cells,
      rect: rectOf(tile.cells, shown),
      label: msg("Add as a tab"),
    };
  };
  const over = (e: DragEvent<HTMLElement>) => {
    const next = targetOf(e);
    setTarget(next);
    if (!next) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

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
        drop!.onDrop("zone" in next ? { zone: next.zone } : { paneId: next.paneId }, e);
      }}
    >
      {!tabs &&
        several &&
        tiles.map((tile) => (
          <TileHeader
            key={`header-${tile.cells}`}
            rect={rectOf(tile.cells, shown)}
            panes={tile.panes.map((i) => items[i]!)}
            shown={items[activeIn(tile)]!.paneId}
            focused={items[focused]?.paneId}
            onSelect={onSelectTab}
            onClose={onCloseTab}
          />
        ))}
      {tabs &&
        tiles.map((tile, at) => {
          const group = tile.panes;
          const rect = rectOf(tile.cells, shown);
          const shownPane = items[activeIn(tile)]!;
          const flush = flushOf(tile, at);
          // The top right card.
          const corner = !!(tile.cells & zoneCells.upperRight);
          return (
            <div
              key={`frame-${tile.cells}`}
              // Into the card, for the shown tab's foot to cover the card's top edge at any display scale.
              style={{ ...placed(rect, gutter), height: stripHeight + 2 }}
              className={`titlebar @container absolute z-[2] flex items-stretch transition-[left,top,width] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none`}
            >
              <div
                className={`flex min-w-40 shrink items-center gap-1 pr-1 ${flush ? "" : "-ml-1.5"} ${at === 0 && leading ? `pl-3 ${leadingClass}` : flush ? "" : "pl-[22px]"}`}
              >
                {at === 0 && leading}
                {!hideTabs && (
                  <ThreadTabs
                    tabs={group.flatMap((i) => items[i]!.tabs)}
                    active={shownPane.active}
                    focused={group.includes(focused)}
                    marked={group.includes(focused) && tiles.length > 1}
                    onSelect={onSelectTab}
                    onClose={onCloseTab}
                    onNew={() => onNewTab(shownPane.paneId)}
                    onDrop={(tabDrop, before) => {
                      // Among stacked panes, the one holding the tab it lands before, or the last.
                      const holder = group.find((i) => items[i]!.tabs.some((t) => t.id === before));
                      onDropOnTabs(tabDrop, items[holder ?? group.at(-1)!]!.paneId, before);
                    }}
                    closable={closable}
                    flush={flush}
                  />
                )}
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
      {items.map(({ key, paneId, node }, i) => {
        const tile = tiles[tileOf(i)]!;
        const active = activeIn(tile) === i;
        return (
          <div
            key={key}
            // A stacked pane's view stays mounted, out of sight and reach.
            inert={!active}
            style={{
              ...placed(rectOf(tile.cells, shown), inset, top),
              paddingTop: tabs && hideTabs ? stripHeight : 0,
            }}
            data-marked={tiles.length > 1 && i === focused ? "" : undefined}
            className={`absolute flex min-h-0 min-w-0 transition-[left,top,width,height,padding,visibility] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none ${tabs ? `pane-edge pane-card overflow-clip rounded-prompt ${flushOf(tile, tileOf(i)) && !hideTabs ? "rounded-tl-none" : ""}` : rectOf(tile.cells, shown).left > 0 ? "border-l border-border" : ""} ${active ? "z-[1] bg-pane" : "invisible"}`}
          >
            <div className="relative flex min-h-0 min-w-0 flex-1">
              {/* Content scrolled up fades out rather than butting into the card's top edge. */}
              {tabs && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-4 bg-linear-to-b from-pane to-transparent"
                />
              )}
              {node}
              {paneId === detailsPane && shownDetails}
            </div>
          </div>
        );
      })}
      {dividers.map(({ vertical, from, to }) => {
        const at = vertical ? shown.x : shown.y;
        // A strip 9px across centered on the line, along what it divides. The horizontal one starts
        // clear of a vertical one it meets, which keeps the corner they share.
        const clear = !vertical && from > 0 ? 5 : 0;
        const style: CSSProperties = vertical
          ? {
              left: `calc(${at * 100}% - 4px)`,
              top: `${from * 100}%`,
              width: 9,
              height: `${(to - from) * 100}%`,
            }
          : {
              top: `calc(${at * 100}% - 4px)`,
              left: `calc(${from * 100}% + ${clear}px)`,
              height: 9,
              width: `calc(${(to - from) * 100}% - ${clear}px)`,
            };
        const keyed = (e: KeyboardEvent) => {
          const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
          if (step === undefined) return;
          e.preventDefault();
          const next = resize(vertical, clampRatio(at + step * keyStep));
          if (next) onResize(next);
        };
        return (
          <div
            key={vertical ? "cut-x" : "cut-y"}
            role="separator"
            tabIndex={0}
            aria-label={t("Resize threads")}
            aria-orientation={vertical ? "vertical" : "horizontal"}
            aria-valuenow={Math.round(at * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            title={t("Drag to resize, double-click to even out")}
            style={style}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { vertical, cuts: shown };
              setLive(shown);
            }}
            onPointerMove={(e) => {
              if (drag.current?.vertical !== vertical) return;
              const r = box.current!.getBoundingClientRect();
              const ratio = vertical
                ? (e.clientX - r.left) / r.width
                : (e.clientY - r.top) / r.height;
              const next = resize(vertical, clampRatio(ratio));
              if (!next) return;
              drag.current.cuts = next;
              setLive(next);
            }}
            onPointerUp={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={() => {
              const next = resize(vertical, evenRatio);
              if (next) onResize(next);
            }}
            onKeyDown={keyed}
            className={`group/cut absolute z-10 flex items-center justify-center outline-none ${vertical ? "cursor-col-resize" : "cursor-row-resize"}`}
          >
            <span
              aria-hidden
              className={`rounded-full opacity-0 transition-[opacity,background-color] duration-150 group-hover/cut:opacity-100 group-focus-visible/cut:opacity-100 group-active/cut:opacity-100 ${tabs ? `bg-foreground/25 group-active/cut:bg-foreground/50 ${vertical ? "h-9 w-1" : "h-1 w-9"}` : `bg-accent ${vertical ? "h-full w-0.5" : "h-0.5 w-full"}`}`}
            />
          </div>
        );
      })}
      {target && (
        <div
          aria-hidden
          style={placed(target.rect, tabs ? gutter : 8, tabs ? stripHeight : 0)}
          className="pointer-events-none absolute z-20 grid place-items-center rounded-prompt border border-foreground/35 bg-foreground/[0.07] backdrop-blur-[2px] transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
        >
          <span className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-body font-medium text-foreground shadow-composer [&_svg]:size-4">
            {"zone" in target ? <ZoneGlyph cells={target.cells} /> : <PanelTop />}
            {tabs || "zone" in target ? t(target.label) : t("Open here")}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A classic tile's header (`tabs` off): each of its panes' views, the shown one in full and the
 * focused one underlined in the accent, with a button that closes it.
 */
function TileHeader({
  rect,
  panes,
  shown,
  focused,
  onSelect,
  onClose,
}: {
  rect: Rect;
  panes: TileItem[];
  shown: string;
  focused?: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  const stacked = panes.length > 1;
  return (
    <div
      style={{ ...placed(rect), height: headerHeight }}
      className={`absolute z-[2] flex items-stretch border-b border-border bg-pane transition-[left,top,width] duration-200 ease-out group-data-resizing/tiles:transition-none motion-reduce:transition-none ${rect.left > 0 ? "border-l" : ""} ${rect.top > 0 ? "border-t" : ""}`}
    >
      <div role="tablist" aria-label={t("Threads")} className="flex min-w-0 flex-1 items-stretch">
        {panes.map((pane) => {
          const tab = pane.tabs.find((t) => t.id === pane.active)!;
          const isShown = pane.paneId === shown;
          const isFocused = pane.paneId === focused;
          return (
            <div
              key={pane.paneId}
              className={`group/tab relative flex min-w-0 items-center ${stacked ? `max-w-64 border-r border-border last:border-r-0 ${isShown ? "flex-[3]" : "flex-1"}` : "flex-1"} ${isShown ? "" : "hover:bg-hover"}`}
            >
              {isFocused && (
                <span aria-hidden className="absolute inset-x-0 -bottom-px z-[1] h-0.5 bg-accent" />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={isShown}
                title={tab.title}
                onClick={() => onSelect(tab.id)}
                className={`flex h-full min-w-0 flex-1 items-center gap-2 pl-3 text-left text-body transition-colors ${isFocused ? "text-foreground" : isShown ? "text-muted-foreground" : "text-faint-foreground"}`}
              >
                <span className={`flex shrink-0 [&_svg]:size-4 ${isFocused ? "" : "opacity-60"}`}>
                  {tab.icon}
                </span>
                <span className={`min-w-0 flex-1 truncate ${isShown ? "font-medium" : ""}`}>
                  {tab.title}
                </span>
              </button>
              <button
                type="button"
                aria-label={t("Close {{title}}", { title: tab.title })}
                title={t("Close this tile")}
                onClick={() => onClose(tab.id)}
                className={`grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5 ${stacked && !isShown ? "absolute right-1 bg-pane opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100" : "mx-1"}`}
              >
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A small map of the grid, with `cells` filled. */
function ZoneGlyph({ cells }: { cells: Cells }) {
  const r = rectOf(cells, evenCuts);
  // 16 by 12, inside a 1px frame.
  return (
    <svg aria-hidden viewBox="0 0 16 12" className="h-3 w-4 shrink-0">
      <rect
        x={0.5}
        y={0.5}
        width={15}
        height={11}
        rx={2}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
      />
      <rect
        x={2 + r.left * 12}
        y={2 + r.top * 8}
        width={r.width * 12}
        height={r.height * 8}
        rx={0.75}
        fill="currentColor"
      />
    </svg>
  );
}
