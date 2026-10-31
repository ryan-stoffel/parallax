// What the composer lab's concepts share: finding the real composer's box in the open thread,
// morphing its height on the 0092 tokens, and handing its contents to a layer of their own.
import { type RefObject, useLayoutEffect, useState } from "react";

import { animate, duration, easing, reducedMotion } from "../../src/renderer/motion";

/** The real composer's box: the form around its Attach button. */
export const composerBox = () =>
  document.querySelector('button[aria-label="Attach files"]')?.closest("form") ?? null;

/** The box's editor, where the concepts type as a person would. */
const editorOf = (box: HTMLElement) =>
  box.querySelector<HTMLElement>('[contenteditable="true"]') ?? undefined;

/** Resolves after `ms`, or rejects once `signal` aborts, so a script stops with its concept. */
export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** Types `text` into the box's editor a character at a time, as the editor's own input. */
export async function typeInto(box: HTMLElement, text: string, signal: AbortSignal, perChar = 22) {
  const editor = editorOf(box);
  editor?.focus();
  for (const char of text) {
    document.execCommand("insertText", false, char);
    if (perChar && !reducedMotion()) await sleep(perChar, signal);
  }
}

/** Puts `text` in the box at once. */
export function insertText(box: HTMLElement, text: string) {
  editorOf(box)?.focus();
  document.execCommand("insertText", false, text);
}

/** Empties the box's editor. */
export function clearEditor(box: HTMLElement) {
  editorOf(box)?.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
}

/** Drops `files` on the box, as the OS would, so the composer adds them its own way. */
export function dropFiles(box: HTMLElement, files: File[]) {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  box.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
}

/** A theme color, resolved to something a canvas can paint, read again on each frame. */
export function themeColor(name: string) {
  const probe = document.createElement("i");
  probe.style.color = `var(--${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** Eases `el`'s height from what it is now to `to`, on the spring token. */
export function easeHeight(el: HTMLElement, to: number) {
  const from = el.getBoundingClientRect().height;
  for (const a of el.getAnimations()) a.cancel();
  el.style.height = `${to}px`;
  return animate(el, [{ height: `${from}px` }, { height: `${to}px` }], {
    duration: duration.slow,
    easing: easing.spring,
  });
}

/** The height `el` takes from its own contents. */
function naturalHeight(el: HTMLElement) {
  const set = el.style.height;
  el.style.height = "";
  const height = el.getBoundingClientRect().height;
  el.style.height = set;
  return height;
}

export interface Cover {
  /** Where the concept draws, over the box's own contents. */
  layer: HTMLElement;
  /** Eases the box to fit `height` of the layer's content. */
  fit(height: number): void;
  /** Fades the layer out and eases the box back to its own contents. */
  release(): Promise<void>;
}

/**
 * Hands the box to a layer: the box's contents fade out, and it keeps its height until the
 * concept fits it to what it draws. Unmounting puts the box back at once.
 */
export function useCover(box: HTMLElement, content: RefObject<HTMLElement | null>) {
  const [cover, setCover] = useState<Cover>();
  useLayoutEffect(() => {
    const layer = document.createElement("div");
    layer.dataset["labLayer"] = "";
    layer.className = "absolute inset-0 overflow-hidden rounded-[inherit]";
    box.append(layer);
    box.dataset["lab"] = "cover";
    box.style.height = `${box.getBoundingClientRect().height}px`;
    animate(
      layer,
      [
        { opacity: 0, translate: "0 4px" },
        { opacity: 1, translate: "0 0" },
      ],
      {
        delay: duration.fast / 2,
        fill: "backwards",
      },
    );
    let height = 0;
    setCover({
      layer,
      fit(next) {
        // The box's border is outside the layer.
        if (next === height) return;
        height = next;
        easeHeight(box, next + 2);
      },
      async release() {
        await animate(layer, [{ opacity: 1 }, { opacity: 0 }], {
          duration: duration.fast,
          easing: easing.in,
          fill: "forwards",
        })?.finished;
        layer.style.visibility = "hidden";
        delete box.dataset["lab"];
        for (const child of box.children)
          if (child !== layer)
            animate(child, [{ opacity: 0 }, { opacity: 1 }], { duration: duration.base });
        await easeHeight(box, naturalHeight(box))?.finished;
        box.style.height = "";
      },
    });
    return () => {
      layer.remove();
      delete box.dataset["lab"];
      for (const a of box.getAnimations()) a.cancel();
      box.style.height = "";
    };
  }, [box]);

  // Fits the box to the content as it lays out and whenever it changes size.
  useLayoutEffect(() => {
    const el = content.current;
    if (!cover || !el) return;
    const observer = new ResizeObserver(() => cover.fit(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [cover, content]);
  return cover;
}

/** A host appended to the box for what a concept draws over it, removed as it unmounts. */
export function useHost(box: HTMLElement, className: string, first = false) {
  const [host, setHost] = useState<HTMLElement>();
  useLayoutEffect(() => {
    const el = document.createElement("div");
    el.dataset["labHost"] = "";
    el.className = className;
    if (first) box.prepend(el);
    else box.append(el);
    setHost(el);
    return () => el.remove();
  }, [box, className, first]);
  return host;
}

/** Calls `draw` on each frame until unmount; under reduced motion, a few times a second. */
export function useFrames(draw: (now: number) => void) {
  useLayoutEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (reducedMotion() && now - last < 250) return;
      last = now;
      draw(now);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });
}

/** Sizes a canvas to its CSS box at the screen's density, and returns its context and size. */
export function fitCanvas(canvas: HTMLCanvasElement) {
  const ratio = devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Smooth noise in [-1, 1]: a few sines at unrelated rates. */
export const wobble = (t: number, seed = 0) =>
  (Math.sin(t * 1.7 + seed) +
    Math.sin(t * 3.1 + seed * 2.3) * 0.6 +
    Math.sin(t * 7.3 + seed * 4.1) * 0.3) /
  1.9;

export interface ConceptProps {
  box: HTMLFormElement;
  signal: AbortSignal;
  /** Called once the concept's script ends, which unmounts it. */
  done: () => void;
}
