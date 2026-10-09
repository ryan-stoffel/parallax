import { Hand, MousePointer2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { PreviewInput, PreviewTab } from "../protocol/generated/protocol";
import { shortUrl } from "./Browser";

/** The DevTools modifier bits of an event: Alt 1, Control 2, Meta 4, Shift 8. */
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const buttons = ["left", "middle", "right"] as const;

/**
 * An agent's browser tab (PLX-639), which runs in the host's headless browser: its screencast,
 * long-polled from plxd, and the user's mouse, wheel, and keys sent back, which take control from
 * the agent until Hand back. The address bar opens a page too.
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
  const view = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
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
      if (width === 0 || height === 0) return;
      timer = setTimeout(() => {
        const input: PreviewInput = { kind: "viewport", width, height };
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
  // A point on the image, in the page's CSS pixels.
  const at = (e: { clientX: number; clientY: number }) => {
    const box = view.current!.getBoundingClientRect();
    const scale = (frame?.width ?? box.width) / box.width;
    return { x: (e.clientX - box.left) * scale, y: (e.clientY - box.top) * scale };
  };
  const pointer = (event: "down" | "up" | "move") => (e: PointerEvent) => {
    if (!frame) return;
    if (event === "move") {
      // Moves only while a button is down or the user already has control, at most every 50 ms.
      if ((!e.buttons && !state.human) || e.timeStamp - lastMove.current < 50) return;
      lastMove.current = e.timeStamp;
    } else e.currentTarget.parentElement?.focus();
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
      <div
        ref={area}
        tabIndex={0}
        aria-label="Agent's browser tab"
        onKeyDown={key(true)}
        onKeyUp={key(false)}
        onWheel={(e) =>
          frame && send({ kind: "wheel", ...at(e), deltaX: e.deltaX, deltaY: e.deltaY })
        }
        className={`relative min-h-0 flex-1 overflow-auto bg-background outline-none ${state.human ? "ring-2 ring-ring ring-inset" : ""}`}
      >
        {frame && (
          <img
            ref={view}
            alt={state.title || "The agent's page"}
            src={`data:image/jpeg;base64,${frame.data}`}
            draggable={false}
            onPointerDown={pointer("down")}
            onPointerUp={pointer("up")}
            onPointerMove={pointer("move")}
            onContextMenu={(e) => e.preventDefault()}
            className="block w-full select-none"
          />
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
