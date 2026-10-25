import { X } from "./icons";
import { useEffect, useState } from "react";

import { drawPdfPage, openPdf } from "./documents";
import { readUpload } from "./uploads";

// The first pages drawn for sent files, by host and path, so a card scrolled back into view
// doesn't fetch and draw its file again.
const drawn = new Map<string, Promise<string>>();

/** The first page of the PDF `bytes` gives, as a data URL. */
async function firstPage(bytes: Promise<ArrayBuffer | Uint8Array>): Promise<string> {
  const pdf = await openPdf(new Uint8Array(await bytes));
  try {
    return (await drawPdfPage(pdf, 1, 84)).toDataURL();
  } finally {
    // Frees its worker and memory: the card keeps only the picture.
    void pdf.loadingTask.destroy();
  }
}

/**
 * A file that isn't an image, as a card (PLX-779): a PDF's first page, or else its name, with its
 * type in a badge. `file` is one attached in the composer, or the path on `hostId` of one sent,
 * which `host/readUpload` reads. With `onRemove`, hovering shows a remove button. With
 * `progress`, the share of it sent so far shows as a bar along its bottom (PLX-835), red once
 * `failed`.
 */
export function FileCard({
  file,
  hostId,
  onRemove,
  progress,
  failed,
}: {
  file: File | string;
  hostId?: string;
  onRemove?: () => void;
  progress?: number;
  failed?: boolean;
}) {
  const name = typeof file === "string" ? (file.split(/[\\/]/).pop() ?? file) : file.name;
  const type = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? "FILE";
  const [page, setPage] = useState<string>();
  useEffect(() => {
    if (type !== "PDF" || (typeof file === "string" && !hostId)) return;
    let live = true;
    let drawing: Promise<string>;
    if (typeof file === "string") {
      const key = `${hostId}\n${file}`;
      drawing = drawn.get(key) ?? firstPage(readUpload(hostId!, file));
      drawn.set(key, drawing);
      // A host that's away now may answer later.
      drawing.catch(() => drawn.delete(key));
    } else drawing = firstPage(file.arrayBuffer());
    drawing.then((url) => live && setPage(url)).catch(() => {});
    return () => {
      live = false;
    };
  }, [file, hostId, type]);
  return (
    <span className="group relative size-28 shrink-0 overflow-hidden rounded-xl border border-border bg-surface">
      {page ? (
        <img src={page} alt="" className="mx-auto h-full w-3/4 object-cover object-top" />
      ) : (
        <span className="line-clamp-4 p-2.5 text-meta leading-snug break-all text-muted-foreground">
          {name}
        </span>
      )}
      <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-caption font-medium text-white">
        {type}
      </span>
      {progress !== undefined && (
        <span
          role="progressbar"
          aria-label={failed ? `${name} couldn't be sent` : `Sending ${name}`}
          aria-valuenow={Math.round(progress * 100)}
          className="absolute inset-x-0 bottom-0 h-1 bg-selected"
        >
          <span
            className={`block h-full transition-[width] ${failed ? "bg-danger" : "bg-accent"}`}
            style={{ width: `${progress * 100}%` }}
          />
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          title={name}
          onClick={onRemove}
          className="absolute top-1 right-1 grid size-5 place-items-center rounded-full border border-border bg-surface text-muted-foreground opacity-0 shadow-sm group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 disabled:hidden"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
