import { useEffect, useRef, useState } from "react";

/**
 * A thin scroll thumb that floats over `target`'s right edge, since the app hides native
 * scrollbars (index.css). It shows only while `target` overflows, and only while the pointer is
 * over its parent, it scrolls, or the thumb is dragged. Place it in a positioned parent that holds
 * `target`.
 */
export function ScrollThumb({ target }: { target: () => HTMLElement | null | undefined }) {
  const [geometry, setGeometry] = useState<{ top: number; height: number; left: number }>();
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; scrollTop: number }>(undefined);
  // Inset from the target's top and bottom edges.
  const inset = 6;

  useEffect(() => {
    const el = target();
    if (!el) return;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const { scrollHeight, clientHeight, scrollTop, offsetTop, offsetLeft, offsetWidth } = el;
      if (scrollHeight <= clientHeight + 1) return setGeometry(undefined);
      const track = clientHeight - inset * 2;
      const height = Math.max(28, (clientHeight / scrollHeight) * track);
      const top = (scrollTop / (scrollHeight - clientHeight)) * (track - height);
      setGeometry({ top: offsetTop + inset + top, height, left: offsetLeft + offsetWidth - 10 });
    };
    const onScroll = () => {
      measure();
      setScrolling(true);
      clearTimeout(idle);
      idle = setTimeout(() => setScrolling(false), 900);
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    // Typing changes the height it scrolls through without changing its own size.
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    const resizes = new ResizeObserver(measure);
    resizes.observe(el);
    return () => {
      clearTimeout(idle);
      el.removeEventListener("scroll", onScroll);
      mutations.disconnect();
      resizes.disconnect();
    };
  }, [target]);

  if (!geometry) return null;
  return (
    <div
      aria-hidden
      onPointerDown={(e) => {
        const el = target();
        if (!el) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, scrollTop: el.scrollTop };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const el = target();
        if (!drag.current || !el) return;
        const track = el.clientHeight - inset * 2 - geometry.height;
        const ratio = (el.scrollHeight - el.clientHeight) / Math.max(1, track);
        el.scrollTop = drag.current.scrollTop + (e.clientY - drag.current.y) * ratio;
      }}
      onPointerUp={() => {
        drag.current = undefined;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDragging(false);
      }}
      data-scroll-thumb
      style={{ top: geometry.top, height: geometry.height, left: geometry.left }}
      className={`group/thumb absolute z-10 flex w-2.5 cursor-default justify-center transition-opacity duration-200 group-hover/scroll:opacity-100 ${scrolling || dragging ? "opacity-100" : "opacity-0"}`}
    >
      <span
        className={`h-full rounded-full transition-[width,background-color] duration-150 group-hover/thumb:w-1.5 group-hover/thumb:bg-foreground/35 ${dragging ? "w-1.5 bg-foreground/40" : "w-1 bg-foreground/20"}`}
      />
    </div>
  );
}
