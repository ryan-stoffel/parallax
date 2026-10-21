import { Globe, Hand, MousePointer2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
  type SVGProps,
} from "react";

import type { PreviewInput, PreviewTab } from "../protocol/generated/protocol";
import { addressBox, addressInput, shortUrl } from "./Browser";
import { browserFit, fitSize, PageFrame, ViewMenu, type Fit, type Size } from "./PageFrame";

/** The DevTools modifier bits of an event: Alt 1, Control 2, Meta 4, Shift 8. */
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const buttons = ["left", "middle", "right"] as const;

/** The agent driving a tab, as its tab shows it: its name and its provider's logo. */
export interface Driver {
  name: string;
  Logo?: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * An agent's browser tab (PLX-639), which runs in the host's headless browser: its screencast,
 * long-polled from plxd, and the user's mouse, wheel, and keys sent back, which take control from
 * the agent until Hand back. The address bar opens a page too. The page is a window in the panel,
 * as on a monitor (PageFrame), whose corner or size fields fix it at a size (PLX-810, PLX-888),
 * and a pill on it says whether the agent or the user is driving.
 */
export function AgentBrowser({
  hostId,
  runId,
  tab,
  driver,
}: {
  hostId: string;
  runId: string;
  tab: PreviewTab;
  driver: Driver;
}) {
  const [frame, setFrame] = useState<{ data: string; width: number; height: number }>();
  const [state, setState] = useState(tab);
  const [gone, setGone] = useState(false);
  const [address, setAddress] = useState<string>();
  const view = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLDivElement>(null);
  const lastMove = useRef(0);
  // Whether the view takes up any space: a hidden side panel or view has none. Hidden, it pulls
  // no frames, so plxd tells the agent nobody is watching, and the tab keeps its last size.
  const [shown, setShown] = useState(true);
  const seen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // The room the page last had, which the tab's viewport fits while the agent leaves it in fill
  // mode, as the user's fit says (PageFrame.tsx).
  const room = useRef<Size>(undefined);
  const fit = browserFit.use();
  // The fit as it is now, not as this render saw it, since a timer or a request may call it late.
  const viewport = () => {
    if (!room.current) return;
    const { width, height } = room.current;
    void request({ kind: "viewport", ...fitSize(width, height, browserFit.get()) });
  };
  // Another tab's switch changes the fit too.
  useEffect(() => {
    viewport();
  }, [fit]);
  // plxd runs requests at once, and a viewport that lands while the tab is still fixed only
  // notes the room, so the new fit's viewport follows Fill's answer.
  const refit = (next: Fit) => {
    browserFit.set(next);
    void size({ kind: "fill" }).then(viewport);
  };

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

  const request = (input: PreviewInput) =>
    window.parallax
      .request(hostId, "preview/input", { runId, tabId: tab.tabId, input })
      .catch(() => undefined);
  const send = (input: PreviewInput) => {
    void request(input);
    setState((s) => ({ ...s, human: input.kind !== "control" || input.take }));
  };
  // Sizing never takes control.
  const size = (input: Extract<PreviewInput, { kind: "fixed" | "fill" }>) => {
    setState((s) => ({ ...s, fixed: input.kind === "fixed" }));
    return request(input);
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
    } else keys.current?.focus();
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

  const { Logo } = driver;
  const logo = Logo ? <Logo aria-hidden className="size-3.5 shrink-0" /> : undefined;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <form
        className="flex items-center gap-1 border-b border-border px-2 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (address?.trim()) send({ kind: "navigate", url: address.trim() });
          setAddress(undefined);
        }}
      >
        <div className={addressBox}>
          {logo ?? <Globe aria-hidden />}
          <input
            aria-label="Agent's address"
            spellCheck={false}
            value={address ?? shortUrl(state.url)}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => setAddress(undefined)}
            className={addressInput}
          />
        </div>
        <button
          type="button"
          onClick={() => send({ kind: "control", take: !state.human })}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground hover:bg-hover"
        >
          {state.human ? (
            <MousePointer2 aria-hidden className="size-3.5" />
          ) : (
            <Hand aria-hidden className="size-3.5" />
          )}
          {state.human ? `Hand back to ${driver.name}` : "Take over"}
        </button>
        <ViewMenu
          fit={fit}
          fixed={!!state.fixed}
          size={frame && { width: frame.width, height: frame.height }}
          onFit={refit}
        />
      </form>
      <PageFrame
        size={frame && { width: frame.width, height: frame.height }}
        fixed={!!state.fixed}
        fit={fit}
        onResize={(next) => size({ kind: "fixed", ...next })}
        onFit={refit}
        onArea={(next) => {
          clearTimeout(timer.current);
          setShown(next.width > 0 && next.height > 0);
          if (next.width === 0 || next.height === 0) return;
          room.current = next;
          timer.current = setTimeout(viewport, 150);
        }}
        className={state.human ? "ring-2 ring-ring" : "ring-2 ring-ring/40"}
        overlay={
          <div className="pointer-events-none absolute -top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[11.5px] whitespace-nowrap shadow-sm ring-1 ring-border">
            {state.human ? (
              <>
                <MousePointer2 aria-hidden className="size-3.5" />
                You're browsing
              </>
            ) : (
              <>
                {logo}
                {driver.name} is {state.recording ? "recording" : "browsing"}
              </>
            )}
          </div>
        }
      >
        {(scale) =>
          frame && (
            <div
              ref={keys}
              tabIndex={0}
              aria-label="Agent's browser tab"
              onKeyDown={key(true)}
              onKeyUp={key(false)}
              onWheel={(e) => send({ kind: "wheel", ...at(e), deltaX: e.deltaX, deltaY: e.deltaY })}
              className="relative size-full outline-none"
            >
              {state.loading && (
                <div
                  role="progressbar"
                  aria-label="Loading"
                  className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-ring"
                />
              )}
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
                className="block select-none"
              />
            </div>
          )
        }
      </PageFrame>
      {(gone || !frame) && (
        <p className="absolute inset-0 top-10 grid place-items-center text-[12.5px] text-muted-foreground">
          {gone ? "This tab closed." : "Waiting for the page…"}
        </p>
      )}
    </div>
  );
}
