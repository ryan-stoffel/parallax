// Send trace: while a message's files upload, the box's own outline is the progress. It draws
// clockwise from the top's middle as host/upload takes each piece, so the box itself says how
// far the send has got, and it closes the loop as the message goes.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { animate, duration, easing, reducedMotion } from "../../src/renderer/motion";
import { type ConceptProps, dropFiles, sleep, typeInto, useFrames, useHost } from "./morph";

/** A rounded rectangle's outline, from the middle of its top edge, clockwise. */
function outline(w: number, h: number, r: number) {
  const i = 0.75;
  return [
    `M ${w / 2} ${i}`,
    `H ${w - r}`,
    `A ${r - i} ${r - i} 0 0 1 ${w - i} ${r}`,
    `V ${h - r}`,
    `A ${r - i} ${r - i} 0 0 1 ${w - r} ${h - i}`,
    `H ${r}`,
    `A ${r - i} ${r - i} 0 0 1 ${i} ${h - r}`,
    `V ${r}`,
    `A ${r - i} ${r - i} 0 0 1 ${r} ${i}`,
    "Z",
  ].join(" ");
}

/** A 2.4 MB log, as host/upload takes it: eight pieces, at an uneven pace. */
const pieces = [260, 180, 420, 220, 160, 540, 240, 200];

export function SendTrace({ box, signal, done }: ConceptProps) {
  const host = useHost(box, "pointer-events-none absolute -inset-px z-10");
  const [size, setSize] = useState({ w: 0, h: 0 });
  const path = useRef<SVGPathElement>(null);
  // What host/upload has taken, and what's drawn, which follows it as a spring would.
  const target = useRef(0);
  const shown = useRef(0);
  const speed = useRef(0);
  const last = useRef(performance.now());
  const [on, setOn] = useState(false);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => setSize({ w: box.offsetWidth, h: box.offsetHeight }));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  useFrames((now) => {
    const dt = Math.min(0.05, (now - last.current) / 1000);
    last.current = now;
    if (reducedMotion()) shown.current = target.current;
    else {
      // A stiff, critically damped spring toward what's been taken.
      const stiffness = 180;
      const damping = 2 * Math.sqrt(stiffness);
      speed.current +=
        (stiffness * (target.current - shown.current) - damping * speed.current) * dt;
      shown.current += speed.current * dt;
    }
    path.current?.setAttribute("stroke-dasharray", `${Math.max(0, shown.current)} 1`);
  });

  useEffect(() => {
    void (async () => {
      await sleep(400, signal);
      await typeInto(box, "Here's the crash log from last night's nightly.", signal);
      dropFiles(box, [
        new File([new Uint8Array(2_400_000)], "nightly-crash.log", { type: "text/plain" }),
      ]);
      // Off the text, so the box's border is its resting gray under the trace.
      (document.activeElement as HTMLElement | null)?.blur();
      await sleep(900, signal);
      setOn(true);
      for (const [i, ms] of pieces.entries()) {
        await sleep(ms, signal);
        target.current = (i + 1) / pieces.length;
      }
      await sleep(350, signal);
      // The composer's own Send, which plxd's mock answers, emptying the box.
      box.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click();
      if (path.current)
        await animate(path.current, [{ opacity: 1 }, { opacity: 0 }], {
          duration: duration.base,
          easing: easing.in,
          delay: duration.slow,
          fill: "forwards",
        })?.finished;
      await sleep(1200, signal);
      done();
    })().catch(() => {});
  }, [box, signal, done]);

  return (
    host &&
    on &&
    createPortal(
      <svg width={size.w} height={size.h} className="block overflow-visible" aria-hidden>
        <path
          ref={path}
          d={outline(size.w, size.h, 16)}
          pathLength={1}
          fill="none"
          stroke="var(--send)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="0 1"
        />
      </svg>,
      host,
    )
  );
}
