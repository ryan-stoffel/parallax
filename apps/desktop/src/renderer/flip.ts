import { useCallback, useLayoutEffect, useRef } from "react";

type Place = { top: number; viewTop: number; scroller: Element | null };

/**
 * Slides rows to their new places when a list's rows change (FLIP, PLX-789): before each paint
 * where the `[data-flip]` rows under `root` changed order or came and went, each one that moved
 * animates from where it was, for about 300 ms, and each new one fades in. A row's place is
 * measured within its `[data-flip-scroll]` container, so scrolling between renders doesn't count
 * as moving. Returns `quiet`, which keeps the next render still, for changes that aren't moves,
 * such as switching areas or typing a search. Nothing moves under reduced motion.
 */
export function useFlip(root: string) {
  const last = useRef<{ order: string; places: Map<string, Place> }>(undefined);
  const hushed = useRef(false);
  useLayoutEffect(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(`${root} [data-flip]`)];
    const places = new Map<string, Place>();
    for (const el of rows) {
      const scroller = el.closest("[data-flip-scroll]");
      const rect = el.getBoundingClientRect();
      const base = scroller ? scroller.getBoundingClientRect().top - scroller.scrollTop : 0;
      places.set(el.dataset["flip"]!, { top: rect.top - base, viewTop: rect.top, scroller });
    }
    const order = [...places.keys()].join("\n");
    const before = last.current;
    last.current = { order, places };
    const still =
      hushed.current ||
      !before ||
      before.order === order ||
      document.documentElement.classList.contains("reduce-motion");
    hushed.current = false;
    if (still) return;
    for (const el of rows) {
      if (typeof el.animate !== "function") return;
      const now = places.get(el.dataset["flip"]!)!;
      const was = before.places.get(el.dataset["flip"]!);
      if (!was) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 220, easing: "ease-out" },
        );
        continue;
      }
      // A row that changed containers, as from Working to Threads, is measured on screen.
      const dy = was.scroller === now.scroller ? was.top - now.top : was.viewTop - now.viewTop;
      if (Math.abs(dy) > 2)
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
          duration: 300,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
    }
  });
  return useCallback(() => {
    hushed.current = true;
  }, []);
}
