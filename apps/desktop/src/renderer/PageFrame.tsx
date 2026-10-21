import { useEffect, useRef, useState, type ReactNode } from "react";

/** A page's size in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** The monitor a page lays out on until the panel is at least as big (PLX-888). */
export const MONITOR: Size = { width: 1280, height: 800 };

/**
 * The size a page fits to in a `width` by `height` area: the area itself once a monitor fits in it
 * whole, or else the monitor, which the frame scales down to fit.
 */
export const fitSize = (width: number, height: number): Size =>
  width >= MONITOR.width && height >= MONITOR.height ? { width, height } : MONITOR;

/** The height of the size fields under the window. */
const FIELDS = 36;

/** A page side plxd accepts, and the user's browser keeps to: 200 to 4096 CSS pixels. */
const clampSide = (n: number) => Math.min(4096, Math.max(200, Math.round(n)));

/**
 * A browser page as a window in the panel, as on a monitor (PLX-888): laid out at `size`, scaled
 * down to fit the area, centered with blank space around it. Its bottom-right corner drags to a
 * new size, and double-clicks back to the fitted one; the size under it can be typed too.
 * `children` draws the page at the scale it's given. `onArea` hears the space the page has.
 */
export function PageFrame({
  size,
  fixed,
  onResize,
  onFit,
  onArea,
  className = "",
  overlay,
  children,
}: {
  size?: Size;
  fixed: boolean;
  onResize: (size: Size) => void;
  onFit: () => void;
  onArea?: (area: Size) => void;
  /** The window's ring, such as who controls the page. */
  className?: string;
  /** Drawn over the window's top edge, such as who's browsing. */
  overlay?: ReactNode;
  children: (scale: number) => ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Size>({ width: 0, height: 0 });
  const latest = useRef(onArea);
  latest.current = onArea;
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    // The content box, inside the padding that keeps the pill and corner clear of the panel's edges.
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect;
      const next = { width: Math.round(box.width), height: Math.round(box.height) };
      setRoom(next);
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
  // The window fits above the size fields, which sit just under it.
  const scale = size
    ? Math.max(0, Math.min(1, room.width / size.width, (room.height - FIELDS) / size.height))
    : 1;

  return (
    <div
      ref={area}
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 pt-5 pb-1"
    >
      {size && room.width > 0 && (
        <div
          style={{ width: size.width * scale, height: size.height * scale }}
          className={`group relative shrink-0 rounded-md bg-background shadow-lg ring-1 ring-border ${className}`}
        >
          <div className="size-full overflow-hidden rounded-md">{children(scale)}</div>
          {overlay}
          {drag && (
            <div
              aria-hidden
              style={{ width: drag.size.width * scale, height: drag.size.height * scale }}
              className="pointer-events-none absolute top-0 left-0 rounded-md border-2 border-dashed border-ring bg-ring/10"
            />
          )}
          <div
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
            onDoubleClick={onFit}
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
      <form
        aria-label="Page size"
        style={{ height: FIELDS }}
        className="flex shrink-0 items-center justify-center gap-1.5 text-[12px] text-muted-foreground"
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
              className="w-11 rounded bg-transparent px-1 py-0.5 text-center text-foreground tabular-nums hover:bg-hover focus-visible:bg-selected focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
        ))}
        {size && <span className="tabular-nums">· {Math.round(scale * 100)}%</span>}
        {fixed && (
          <button
            type="button"
            onClick={onFit}
            className="ml-1 rounded px-1.5 py-0.5 text-foreground hover:bg-hover"
          >
            Fit
          </button>
        )}
      </form>
    </div>
  );
}
