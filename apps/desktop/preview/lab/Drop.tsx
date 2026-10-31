// File drop: while files are dragged over it, the box opens a place for each, shaped as what it
// will hold (a thumbnail for an image, a card for a file) and labelled with its kind, which a
// drag says before the drop. Let go, and the composer's own chips take those places.
//
// The scripted demo draws the drag itself, as the OS would, and drops real Files on the box.
// A real drag from Finder works too while this concept is on.
import { FileCode, FileText, Image } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { animate, duration, easing } from "../../src/renderer/motion";
import { type ConceptProps, dropFiles, easeHeight, sleep, useHost } from "./morph";

interface Kind {
  image: boolean;
  label: string;
}

const kindOf = (type: string): Kind =>
  type.startsWith("image/")
    ? { image: true, label: type.slice(6).toUpperCase() }
    : {
        image: false,
        label: type === "application/pdf" ? "PDF" : type.includes("typescript") ? "TS" : "File",
      };

const iconOf = (kind: Kind) => (kind.image ? Image : kind.label === "PDF" ? FileText : FileCode);

/** Three real files: an image drawn here, a PDF, and a source file. */
async function demoFiles() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2b5cff";
  ctx.beginPath();
  ctx.roundRect(8, 8, 112, 112, 28);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(64, 64, 26, 0, Math.PI * 2);
  ctx.fill();
  const png = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  return [
    new File([png], "glyph-32.png", { type: "image/png" }),
    new File(["%PDF-1.4\n% icon guidelines\n"], "icon-guidelines.pdf", { type: "application/pdf" }),
    new File(["export const sizes = [16, 32, 128];\n"], "sizes.ts", { type: "text/typescript" }),
  ];
}

export function Drop({ box, signal, done }: ConceptProps) {
  // Where the composer puts its own chips: first in the box.
  const host = useHost(box, "h-0 overflow-hidden", true);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const row = useRef<HTMLDivElement>(null);

  // Opens to the row's height as places arrive, and closes when they go.
  useEffect(() => {
    if (!host) return;
    easeHeight(host, kinds.length ? (row.current?.offsetHeight ?? 0) : 0);
    box.style.borderColor = kinds.length ? "var(--ring)" : "";
  }, [host, kinds, box]);

  // A real drag over the box: its kinds are known before the drop.
  useEffect(() => {
    const over = (e: DragEvent) => {
      const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === "file");
      if (items.length)
        setKinds((now) => (now.length === items.length ? now : items.map((i) => kindOf(i.type))));
    };
    const leave = (e: DragEvent) => {
      if (!box.contains(e.relatedTarget as Node | null)) setKinds([]);
    };
    const drop = () => setKinds([]);
    box.addEventListener("dragover", over);
    box.addEventListener("dragleave", leave);
    box.addEventListener("drop", drop);
    return () => {
      box.removeEventListener("dragover", over);
      box.removeEventListener("dragleave", leave);
      box.removeEventListener("drop", drop);
      box.style.borderColor = "";
    };
  }, [box]);

  // The scripted drag: a stack of three files from above, onto the box, and let go.
  useEffect(() => {
    let drag: HTMLElement | undefined;
    void (async () => {
      const files = await demoFiles();
      await sleep(500, signal);
      const target = box.getBoundingClientRect();
      drag = document.createElement("div");
      drag.className = "pointer-events-none fixed top-0 left-0 z-popover";
      drag.innerHTML =
        files
          .map(
            (_, i) =>
              `<div class="absolute size-10 rounded-lg border border-border bg-surface shadow-composer" style="left:${i * 4}px;top:${i * -4}px"></div>`,
          )
          .join("") +
        `<span class="absolute -top-3 left-9 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-caption font-medium text-accent-foreground">${files.length}</span>`;
      document.body.append(drag);
      const start = { x: target.right - 140, y: target.top - 220 };
      const end = { x: target.left + target.width * 0.55, y: target.top + target.height * 0.45 };
      const path = [
        { translate: `${start.x}px ${start.y}px`, opacity: 0 },
        { translate: `${start.x - 10}px ${start.y + 20}px`, opacity: 1, offset: 0.15 },
        { translate: `${end.x}px ${end.y}px`, opacity: 1 },
      ];
      const travel = animate(drag, path, {
        duration: 1100,
        easing: easing.inOut,
        fill: "forwards",
      });
      // The box opens as the drag crosses its edge.
      await sleep(travel ? 820 : 0, signal);
      setKinds(files.map((f) => kindOf(f.type)));
      await travel?.finished;
      await sleep(1300, signal);
      // Let go: the stack sinks into the places, and the composer adds the files itself.
      await animate(
        drag,
        [
          { opacity: 1, scale: 1 },
          { opacity: 0, scale: 0.9 },
        ],
        {
          duration: duration.fast,
          easing: easing.in,
          fill: "forwards",
        },
      )?.finished;
      drag.remove();
      setKinds([]);
      const opened = box.querySelector<HTMLElement>("[data-lab-host]");
      if (opened) opened.style.height = "0px";
      dropFiles(box, files);
      await sleep(2000, signal);
      done();
    })().catch(() => {});
    return () => drag?.remove();
  }, [box, signal, done]);

  return (
    host &&
    createPortal(
      <div ref={row} className="flex flex-wrap items-center gap-2 px-4 pt-3.5">
        {kinds.map((kind, i) => {
          const Icon = iconOf(kind);
          return (
            <div
              key={i}
              style={{ animationDelay: `${i * 40}ms` }}
              // The shapes the composer's own chips take: a thumbnail, or a file's card.
              className={`lab-place flex rounded-xl border border-border bg-hover text-faint-foreground ${kind.image ? "size-14 items-center justify-center" : "size-28 flex-col justify-between p-2.5"}`}
            >
              <Icon className="size-5 shrink-0" />
              {!kind.image && (
                <span className="truncate text-caption font-medium">{kind.label}</span>
              )}
            </div>
          );
        })}
      </div>,
      host,
    )
  );
}
