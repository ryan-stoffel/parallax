import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { stored } from "./stored";
import { DesktopWindows, MoreVert, Resize, RightPanelOpen } from "./symbols";
import { IconButton, Menu, menuHeading, MenuOption } from "./ui";

/** A page's size in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** The monitor a page lays out on until the panel is at least as big (PLX-888). */
export const MONITOR: Size = { width: 1280, height: 800 };

/** How a page fits the panel when the user hasn't sized it: as on a monitor, or at the panel's size. */
export type Fit = "monitor" | "panel";

/** The fit every browser tab uses, kept on this computer. */
export const browserFit = stored<Fit>("parallax.browserFit", "monitor", (raw, fallback) =>
  raw === "monitor" || raw === "panel" ? raw : fallback,
);

/**
 * The size a page fits to in a `width` by `height` area. A panel fit is the area itself. A monitor
 * fit is the area once a monitor fits in it whole, or else the monitor, which the frame scales down.
 */
export const fitSize = (width: number, height: number, fit: Fit = "monitor"): Size =>
  fit === "panel" || (width >= MONITOR.width && height >= MONITOR.height)
    ? { width, height }
    : MONITOR;

/** The height of the size fields under the window. */
const FIELDS = 36;

/** A page side plxd accepts, and the user's browser keeps to: 200 to 4096 CSS pixels. */
const clampSide = (n: number) => Math.min(4096, Math.max(200, Math.round(n)));

/**
 * A browser page as a window in the panel, as on a monitor (PLX-888): laid out at `size`, scaled
 * down to fit the area, centered with blank space around it. Its bottom-right corner drags to a
 * new size, and double-clicks back to the fitted one; the size under it can be typed too. With
 * the panel fit and no size of the user's, the page simply fills the panel, as in a browser, in a
 * frame with rounded corners and a thin inset, as Helium draws it (PLX-966). Nothing animates its
 * size, so resizing the panel stays snappy.
 * `children` draws the page at the scale it's given. `onArea` hears the room the page has, 0 by 0
 * while hidden.
 */
export function PageFrame({
  size,
  fixed,
  fit,
  onResize,
  onFit,
  onArea,
  className = "",
  overlay,
  children,
}: {
  size?: Size;
  fixed: boolean;
  fit: Fit;
  onResize: (size: Size) => void;
  onFit: (fit: Fit) => void;
  onArea?: (area: Size) => void;
  /** The window's ring, such as who controls the page. */
  className?: string;
  /** Drawn over the window's top edge, such as who's browsing. */
  overlay?: ReactNode;
  children: (scale: number) => ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Size>({ width: 0, height: 0 });
  // The page fills the panel, with no window, pill, corner, or size fields.
  const bare = !fixed && fit === "panel";
  const fields = useRef(0);
  fields.current = bare ? 0 : FIELDS;
  const latest = useRef(onArea);
  latest.current = onArea;
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    // The page's room: the content box, inside the padding that keeps the pill and corner clear
    // of the panel's edges, less the size fields. A hidden view has none, and keeps its last room,
    // so its window, and a webview in it, stay as they were.
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect;
      const next = {
        width: Math.round(box.width),
        height: Math.max(0, Math.round(box.height) - fields.current),
      };
      if (next.width > 0 && next.height > 0) setRoom(next);
      latest.current?.(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The corner drag: where it started, in client and page pixels, and the size it has reached.
  const [drag, setDrag] = useState<{ x: number; y: number; start: Size; size: Size }>();
  // The size fields' text while the user edits them.
  const [draft, setDraft] = useState<{ width: string; height: string }>();
  const shown = drag?.size ?? size;
  const scale = size ? Math.min(1, room.width / size.width, room.height / size.height) : 1;

  return (
    <div
      ref={area}
      // One tree for both looks, so switching never remounts the page, a webview included.
      className={`flex min-h-0 flex-1 flex-col items-center justify-center ${bare ? "px-1.5 pb-1.5" : "px-3 pt-5 pb-1"}`}
    >
      {size && (
        <div
          style={{ width: size.width * scale, height: size.height * scale }}
          className={`group relative shrink-0 bg-background ${bare ? "rounded-lg ring-1 ring-border" : `rounded-md shadow-lg ring-1 ring-border ${className}`}`}
        >
          <div className={`size-full overflow-hidden ${bare ? "rounded-lg" : "rounded-md"}`}>
            {children(scale)}
          </div>
          {!bare && overlay}
          {drag && (
            <div
              aria-hidden
              style={{ width: drag.size.width * scale, height: drag.size.height * scale }}
              className="pointer-events-none absolute top-0 left-0 rounded-md border-2 border-dashed border-ring bg-ring/10"
            />
          )}
          <div
            hidden={bare}
            role="separator"
            aria-label="Resize page"
            title="Drag to resize the page. Double-click to fit it."
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ x: e.clientX, y: e.clientY, start: size, size });
            }}
            onPointerMove={(e) =>
              drag &&
              setDrag({
                ...drag,
                size: {
                  width: clampSide(drag.start.width + (e.clientX - drag.x) / scale),
                  height: clampSide(drag.start.height + (e.clientY - drag.y) / scale),
                },
              })
            }
            // Releasing the button, or a cancel, ends the capture, and with it the drag.
            onLostPointerCapture={() => {
              if (!drag) return;
              setDrag(undefined);
              const { size: reached, start } = drag;
              if (reached.width !== start.width || reached.height !== start.height)
                onResize(reached);
            }}
            onDoubleClick={() => onFit(fit)}
            className={`absolute -right-1.5 -bottom-1.5 size-5 cursor-nwse-resize touch-none transition-opacity ${drag ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          >
            <svg viewBox="0 0 20 20" aria-hidden className="size-full text-muted-foreground">
              <path
                d="M17 7 7 17M17 12l-5 5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
      )}
      {size && !bare && (
        <form
          aria-label="Page size"
          style={{ height: FIELDS }}
          className="flex shrink-0 items-center justify-center gap-1.5 text-meta text-muted-foreground"
          onSubmit={(e) => {
            e.preventDefault();
            const [width, height] = [Number(draft?.width), Number(draft?.height)];
            if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)
              onResize({ width: clampSide(width), height: clampSide(height) });
            setDraft(undefined);
          }}
        >
          {(["width", "height"] as const).map((side, i) => (
            <label key={side} className="flex items-center gap-1.5">
              {i > 0 && <span>×</span>}
              <input
                aria-label={`Page ${side}`}
                inputMode="numeric"
                value={draft?.[side] ?? String(shown?.[side] ?? "")}
                // The first keystroke starts a draft from the page's size, so the other field keeps it.
                onChange={(e) =>
                  setDraft((d) => ({
                    ...(d ?? {
                      width: String(size?.width ?? ""),
                      height: String(size?.height ?? ""),
                    }),
                    [side]: e.target.value,
                  }))
                }
                // A form with two fields and no submit button doesn't submit on Enter by itself.
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.form?.requestSubmit()}
                onBlur={(e) => {
                  if (!e.currentTarget.form?.contains(e.relatedTarget)) setDraft(undefined);
                }}
                className="w-11 rounded-sm bg-transparent px-1 py-0.5 text-center text-foreground tabular-nums hover:bg-hover focus-visible:bg-selected focus-visible:outline-2 focus-visible:outline-ring"
              />
            </label>
          ))}
          <span className="tabular-nums">· {Math.round(scale * 100)}%</span>
          {fixed && (
            <button
              type="button"
              onClick={() => onFit(fit)}
              className="ml-1 rounded-sm px-1.5 py-0.5 text-foreground hover:bg-hover"
            >
              Fit
            </button>
          )}
        </form>
      )}
    </div>
  );
}

/**
 * The toolbar's ⋮ menu, as Chrome's: its View section, Desktop (the monitor fit) or Panel (the
 * panel fit), with the user's own size as Custom while there is one.
 */
export function ViewMenu({
  fit,
  size,
  fixed,
  onFit,
}: {
  fit: Fit;
  size?: Size;
  fixed: boolean;
  onFit: (fit: Fit) => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const choose = (next: Fit) => {
    onFit(next);
    menu.current?.hidePopover();
  };
  return (
    <>
      <IconButton label="More" popoverTarget={id} aria-haspopup="menu">
        <MoreVert />
      </IconButton>
      <Menu ref={menu} id={id} label="More" align="end" className="w-68 p-1">
        <p className={menuHeading}>View</p>
        <MenuOption
          option={{
            value: "monitor",
            label: "Desktop",
            icon: <DesktopWindows aria-hidden />,
            hint: `${MONITOR.width} × ${MONITOR.height}`,
            description: "The site as on a monitor, scaled to fit the panel",
          }}
          checked={!fixed && fit === "monitor"}
          onClick={() => choose("monitor")}
        />
        <MenuOption
          option={{
            value: "panel",
            label: "Panel",
            icon: <RightPanelOpen aria-hidden />,
            description: "The site at the panel's size, like a normal browser",
          }}
          checked={!fixed && fit === "panel"}
          onClick={() => choose("panel")}
        />
        {fixed && size && (
          <MenuOption
            option={{
              value: "custom",
              label: "Custom",
              icon: <Resize aria-hidden />,
              hint: `${size.width} × ${size.height}`,
              description: "Drag the window's corner or type a size under it",
            }}
            checked
            onClick={() => menu.current?.hidePopover()}
          />
        )}
      </Menu>
    </>
  );
}
