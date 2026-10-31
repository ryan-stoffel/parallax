// Queue: a message sent while the agent works doesn't vanish. Its line lifts out of the box,
// narrows into a pill, and docks on the Queued tab, whose count lands one higher, so the user
// sees where it went and how many wait.
import { useEffect } from "react";

import { animate, duration, easing, reducedMotion } from "../../src/renderer/motion";
import { type ConceptProps, clearEditor, sleep, typeInto } from "./morph";

const message = "Then export a 32 px favicon from the same glyph.";

/** The Queued tab's button and its count, in the tabs over the box. */
function queueTab() {
  const button = [
    ...document.querySelectorAll<HTMLElement>('[aria-label="Composer tabs"] button'),
  ].find((b) => b.textContent?.startsWith("Queued"));
  return { button, count: button?.querySelector<HTMLElement>("span") ?? undefined };
}

export function Queue({ box, signal, done }: ConceptProps) {
  useEffect(() => {
    const { count } = queueTab();
    const was = count?.textContent;
    let ghost: HTMLElement | undefined;
    void (async () => {
      await sleep(400, signal);
      await typeInto(box, message, signal);
      await sleep(600, signal);
      const line = box.querySelector<HTMLElement>('[contenteditable="true"] p');
      const { button } = queueTab();
      if (!line || !button || !count) return done();
      // The line's text, where it sits, lifted out of the box as the box empties.
      const from = line.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(line);
      const text = range.getBoundingClientRect();
      ghost = document.createElement("div");
      ghost.textContent = message;
      ghost.className =
        "pointer-events-none fixed z-popover overflow-hidden whitespace-nowrap text-ellipsis text-foreground";
      Object.assign(ghost.style, {
        left: `${from.left}px`,
        top: `${from.top}px`,
        width: `${text.width + 2}px`,
        height: `${from.height}px`,
        lineHeight: `${from.height}px`,
        fontSize: getComputedStyle(line).fontSize,
      });
      document.body.append(ghost);
      clearEditor(box);
      (document.activeElement as HTMLElement | null)?.blur();
      const to = button.getBoundingClientRect();
      // To the tab's middle, narrowing into a pill as it goes.
      const travel = animate(
        ghost,
        [
          {
            left: `${from.left}px`,
            top: `${from.top}px`,
            width: `${text.width + 2}px`,
            height: `${from.height}px`,
            lineHeight: `${from.height}px`,
            fontSize: "14px",
            padding: "0px",
            borderRadius: "6px",
            backgroundColor: "transparent",
            opacity: 1,
          },
          { offset: 0.7, opacity: 1 },
          {
            left: `${to.left}px`,
            top: `${to.top}px`,
            width: `${to.width}px`,
            height: `${to.height}px`,
            lineHeight: `${to.height}px`,
            fontSize: "12px",
            padding: "0px 8px",
            borderRadius: "8px",
            backgroundColor: "var(--hover)",
            opacity: 0,
          },
        ],
        { duration: duration.slow * 2, easing: easing.inOut, fill: "forwards" },
      );
      await travel?.finished;
      ghost.remove();
      // The count lands one higher.
      count.textContent = String(Number(count.textContent) + 1);
      if (!reducedMotion())
        animate(count, [{ scale: 0.6 }, { scale: 1 }], {
          duration: duration.slow,
          easing: easing.spring,
        });
      animate(button, [{ backgroundColor: "var(--hover)" }, { backgroundColor: "transparent" }], {
        duration: duration.slow * 3,
      });
      await sleep(1800, signal);
      done();
    })().catch(() => {});
    return () => {
      ghost?.remove();
      if (count && was) count.textContent = was;
    };
  }, [box, signal, done]);
  return null;
}
