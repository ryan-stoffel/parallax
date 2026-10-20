import { Hand, MousePointer2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { PreviewInput, PreviewTab } from "../protocol/generated/protocol";
import { shortUrl } from "./Browser";

/** The DevTools modifier bits of an event: Alt 1, Control 2, Meta 4, Shift 8. */
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const buttons = ["left", "middle", "right"] as const;

/** The narrowest viewport fill mode gives a page, so a site shows its desktop layout. */
export const DESKTOP_WIDTH = 1280;

/**
 * The viewport fill mode asks for in a `width` by `height` panel: the panel's own shape, at least
 * {@link DESKTOP_WIDTH} wide, which the view then scales down to the panel's width.
 */
export function fillViewport(width: number, height: number) {
  const wide = Math.max(width, DESKTOP_WIDTH);
  return { width: wide, height: Math.round((height * wide) / width) };
}

/** A page side plxd accepts, 200 to 4096 CSS pixels. */
const clampSide = (n: number) => Math.min(4096, Math.max(200, Math.round(n)));

/**
 * An agent's browser tab (PLX-639), which runs in the host's headless browser: its screencast,
 * long-polled from plxd, and the user's mouse, wheel, and keys sent back, which take control from
 * the agent until Hand back. The address bar opens a page too. Fill lays the page out at desktop
 * width in the panel's shape (PLX-888), and the size bar or the page's bottom-right corner fixes
 * it at a size (PLX-810). Either way the page scales down to the panel's width, and a page taller
 * than the panel scrolls.
 */
export function AgentBrowser({
  hostId,
  runId,
  tab,
}: {
  hostId: string;
  runId: string;
  tab: PreviewTab;
}) {
  const [frame, setFrame] = useState<{ data: string; width: number; height: number }>();
  const [state, setState] = useState(tab);
  const [gone, setGone] = useState(false);
  const [address, setAddress] = useState<string>();
  // The size bar's text while the user edits it.
  const [draft, setDraft] = useState<{ width: string; height: string }>();
  // The view's size in CSS pixels, which a fixed size scales down to fit.
  const [panel, setPanel] = useState({ width: 0, height: 0 });
  const view = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  // The corner drag: where it started, in client and page pixels, and the size it has reached.
  const [drag, setDrag] = useState<{
    x: number;
    y: number;
    start: { width: number; height: number };
    size: { width: number; height: number };
  }>();
  // Whether the view takes up any space: a hidden side panel or view has none. Hidden, it pulls
  // no frames, so plxd tells the agent nobody is watching, and the tab keeps its last size.
  const [shown, setShown] = useState(true);
  const seen = useRef(0);

  useEffect(() => {
    if (!shown) return;
    let live = true;
    void (async () => {
      while (live) {
        const after = seen.current;
        const answer = await window.parallax
          .request(hostId, "preview/frame", { runId, tabId: tab.tabId, after })
          .catch(() => undefined);
        if (!live) return;
        if (!answer || "error" in answer) {
          setGone(true);
          return;
        }
        const { seq, data, width, height, tab: now } = answer.result;
        setState(now);
        if (seq > after && data) setFrame({ data, width, height });
        seen.current = seq;
      }
    })();
    return () => {
      live = false;
    };
  }, [hostId, runId, tab.tabId, shown]);

  // The tab's viewport follows the space it has here, while the agent leaves it in fill mode.
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      const [width, height] = [Math.round(el.clientWidth), Math.round(el.clientHeight)];
      setShown(width > 0 && height > 0);
      setPanel({ width, height });
      if (width === 0 || height === 0) return;
      timer = setTimeout(() => {
        const input: PreviewInput = { kind: "viewport", ...fillViewport(width, height) };
        void window.parallax.request(hostId, "preview/input", { runId, tabId: tab.tabId, input });
      }, 150);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [hostId, runId, tab.tabId]);

  const send = (input: PreviewInput) => {
    void window.parallax.request(hostId, "preview/input", { runId, tabId: tab.tabId, input });
    setState((s) => ({ ...s, human: input.kind !== "control" || input.take }));
  };
  // The size bar's inputs, which never take control.
  const size = (input: Extract<PreviewInput, { kind: "fixed" | "fill" }>) => {
    void window.parallax.request(hostId, "preview/input", { runId, tabId: tab.tabId, input });
    setState((s) => ({ ...s, fixed: input.kind === "fixed" }));
    setDraft(undefined);
  };
  // The page fits the panel's width, and scrolls when it's taller. Fill's page has the panel's
  // shape, so it never scrolls, and a rounding pixel can't add a scrollbar that resizes it.
  const scale = frame ? Math.min(1, panel.width / frame.width) : 1;
  // A point on the image, in the page's CSS pixels.
  const at = (e: { clientX: number; clientY: number }) => {
    const box = view.current!.getBoundingClientRect();
    const scale = (frame?.width ?? box.width) / box.width;
    return { x: (e.clientX - box.left) * scale, y: (e.clientY - box.top) * scale };
  };

  // The wheel scrolls the view while the page is taller than it and it can go that way, and
  // scrolls the page otherwise. React's wheel listener is passive, so it can't keep the view still.
  useEffect(() => {
    const el = area.current;
    if (!el || !frame) return;
    const wheel = (e: WheelEvent) => {
      const room =
        e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight;
      if (e.deltaY !== 0 && room) return;
      e.preventDefault();
      send({ kind: "wheel", ...at(e), deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  // The corner's drag fixes the page at the size it reaches, in page pixels at the scale it began.
  const resize = {
    onPointerDown(e: PointerEvent) {
      if (!frame || e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = { width: frame.width, height: frame.height };
      setDrag({ x: e.clientX, y: e.clientY, start, size: start });
    },
    onPointerMove(e: PointerEvent) {
      if (!drag) return;
      setDrag({
        ...drag,
        size: {
          width: clampSide(drag.start.width + (e.clientX - drag.x) / scale),
          height: clampSide(drag.start.height + (e.clientY - drag.y) / scale),
        },
      });
    },
    // Releasing the button, or a cancel, ends the capture, and with it the drag.
    onLostPointerCapture() {
      if (!drag) return;
      const { size: reached, start } = drag;
      setDrag(undefined);
      if (reached.width !== start.width || reached.height !== start.height)
        size({ kind: "fixed", ...reached });
    },
  };
  const pointer = (event: "down" | "up" | "move") => (e: PointerEvent) => {
    if (!frame) return;
    if (event === "move") {
      // Moves only while a button is down or the user already has control, at most every 50 ms.
      if ((!e.buttons && !state.human) || e.timeStamp - lastMove.current < 50) return;
      lastMove.current = e.timeStamp;
    } else area.current?.focus();
    send({
      kind: "mouse",
      event,
      ...at(e),
      ...(event !== "move" && { button: buttons[e.button] ?? "left", clickCount: e.detail || 1 }),
      modifiers: modifiers(e),
    });
  };
  const key = (down: boolean) => (e: KeyboardEvent) => {
    e.preventDefault();
    send({
      kind: "key",
      down,
      key: e.key,
      code: e.code,
      ...(down && e.key.length === 1 && !e.metaKey && !e.ctrlKey && { text: e.key }),
      ...(down && e.key === "Enter" && { text: "\r" }),
      modifiers: modifiers(e),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex items-center gap-1.5 border-b border-border px-2 pb-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (address?.trim()) send({ kind: "navigate", url: address.trim() });
          setAddress(undefined);
        }}
      >
        <input
          aria-label="Agent's address"
          spellCheck={false}
          value={address ?? shortUrl(state.url)}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => setAddress(undefined)}
          className="min-w-0 flex-1 rounded-md bg-selected px-2 py-1 text-[12.5px] focus-visible:outline-2 focus-visible:outline-ring"
        />
        {state.human ? (
          <button
            type="button"
            onClick={() => send({ kind: "control", take: false })}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-foreground hover:bg-hover"
          >
            <MousePointer2 aria-hidden className="size-3.5" />
            Hand back
          </button>
        ) : (
          <span className="flex shrink-0 items-center gap-1 px-1 text-[12px] text-muted-foreground">
            <Hand aria-hidden className="size-3.5" />
            {state.recording ? "Agent is recording" : "Click to take over"}
          </span>
        )}
      </form>
      <form
        className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          const [width, height] = [Number(draft?.width), Number(draft?.height)];
          if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)
            size({ kind: "fixed", width, height });
        }}
      >
        <button
          type="button"
          aria-pressed={!state.fixed}
          onClick={() => size({ kind: "fill" })}
          className={`rounded-md px-2 py-0.5 hover:bg-hover ${state.fixed ? "text-muted-foreground" : "bg-selected text-foreground"}`}
        >
          Fill
        </button>
        {(["width", "height"] as const).map((side, i) => (
          <label key={side} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted-foreground">×</span>}
            <input
              aria-label={`Page ${side}`}
              inputMode="numeric"
              value={draft?.[side] ?? String(drag?.size[side] ?? frame?.[side] ?? "")}
              // The first keystroke starts a draft from the page's size, so the other field keeps it.
              onChange={(e) =>
                setDraft((d) => ({
                  ...(d ?? {
                    width: String(frame?.width ?? ""),
                    height: String(frame?.height ?? ""),
                  }),
                  [side]: e.target.value,
                }))
              }
              // A form with two fields and no submit button doesn't submit on Enter by itself.
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.form?.requestSubmit()}
              onBlur={(e) => {
                if (!e.currentTarget.form?.contains(e.relatedTarget)) setDraft(undefined);
              }}
              className="w-14 rounded-md bg-selected px-1.5 py-0.5 tabular-nums focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
        ))}
        {frame && scale < 1 && (
          <span className="ml-auto text-muted-foreground tabular-nums">
            {Math.round(scale * 100)}%
          </span>
        )}
      </form>
      <div
        ref={area}
        tabIndex={0}
        aria-label="Agent's browser tab"
        onKeyDown={key(true)}
        onKeyUp={key(false)}
        className={`relative flex min-h-0 flex-1 bg-background ${state.fixed ? "overflow-auto" : "overflow-hidden"} outline-none ${state.human ? "ring-2 ring-ring ring-inset" : ""}`}
      >
        {frame && (
          // Auto margins center a page smaller than the view and let a taller one scroll from its top.
          <div className="group relative m-auto shrink-0">
            <img
              ref={view}
              alt={state.title || "The agent's page"}
              src={`data:image/jpeg;base64,${frame.data}`}
              draggable={false}
              onPointerDown={pointer("down")}
              onPointerUp={pointer("up")}
              onPointerMove={pointer("move")}
              onContextMenu={(e) => e.preventDefault()}
              style={{ width: frame.width * scale, height: frame.height * scale }}
              className={`block select-none ${state.fixed ? "shadow-md ring-1 ring-border" : ""}`}
            />
            {drag && (
              <div
                aria-hidden
                style={{ width: drag.size.width * scale, height: drag.size.height * scale }}
                className="pointer-events-none absolute top-0 left-0 rounded-sm border-2 border-dashed border-ring bg-ring/10"
              >
                <span className="absolute right-1 bottom-1 rounded bg-foreground px-1.5 py-0.5 text-[11px] text-background tabular-nums">
                  {drag.size.width} × {drag.size.height}
                </span>
              </div>
            )}
            <div
              role="separator"
              aria-label="Resize page"
              title="Drag to resize the page. Double-click to fill the panel."
              {...resize}
              onDoubleClick={() => size({ kind: "fill" })}
              className={`absolute right-0 bottom-0 size-5 cursor-nwse-resize touch-none transition-opacity ${drag ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            >
              <svg
                viewBox="0 0 20 20"
                aria-hidden
                className="size-full text-muted-foreground drop-shadow"
              >
                <path
                  d="M18 8 8 18M18 13l-5 5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>
        )}
        {(gone || !frame) && (
          <p className="absolute inset-0 grid place-items-center text-[12.5px] text-muted-foreground">
            {gone ? "This tab closed." : "Waiting for the page…"}
          </p>
        )}
      </div>
    </div>
  );
}
