import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { drawPdfPage, openPdf } from "./documents";
import { readUpload } from "./uploads";

/** What a card shows of its file: a PDF's first page or an image, as a URL, or a text file's start. */
type Preview = { url: string; page?: boolean } | { text: string };

// The previews made for sent files, by host and path, so a card scrolled back into view doesn't
// fetch and draw its file again.
const drawn = new Map<string, Promise<Preview | undefined>>();

const imageTypes = new Set(["PNG", "JPG", "JPEG", "GIF", "WEBP"]);
const textTypes = new Set(
  "MD TXT CSV TSV JSON YAML YML TOML XML HTML CSS JS JSX TS TSX PY RS GO RB JAVA KT SWIFT C H CPP SH SQL TEX".split(
    " ",
  ),
);

/** A preview of a file of `type` from its `bytes`, or none for a type it can't show. */
async function previewOf(
  type: string,
  bytes: Promise<ArrayBuffer | Uint8Array>,
  width: number,
): Promise<Preview | undefined> {
  if (type === "PDF") return { url: await firstPage(bytes, width), page: true };
  if (imageTypes.has(type)) {
    const mime = type === "JPG" ? "image/jpeg" : `image/${type.toLowerCase()}`;
    return { url: URL.createObjectURL(new Blob([new Uint8Array(await bytes)], { type: mime })) };
  }
  // Its first lines; a card shows only a few.
  if (textTypes.has(type))
    return { text: new TextDecoder().decode(new Uint8Array(await bytes).slice(0, 800)) };
  return undefined;
}

/** The first page of the PDF `bytes` gives, `width` CSS pixels wide, as a data URL. */
async function firstPage(bytes: Promise<ArrayBuffer | Uint8Array>, width: number): Promise<string> {
  const pdf = await openPdf(new Uint8Array(await bytes));
  try {
    return (await drawPdfPage(pdf, 1, width)).toDataURL();
  } finally {
    // Frees its worker and memory: the card keeps only the picture.
    void pdf.loadingTask.destroy();
  }
}

/**
 * A file that isn't an image, as a card (PLX-779): a PDF's first page, an image, or a text file's
 * first lines (0090), or else its name, with its type in a badge. `file` is one attached in the composer, or the path on `hostId` of one sent,
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
  fill,
}: {
  file: File | string;
  hostId?: string;
  onRemove?: () => void;
  progress?: number;
  failed?: boolean;
  /**
   * As a page in a frame, its column's width, as in a Project's Files (0090): a PDF's first page or a
   * text file's first lines on a sheet that runs off the bottom, rather than a small square.
   */
  fill?: boolean;
}) {
  const name = typeof file === "string" ? (file.split(/[\\/]/).pop() ?? file) : file.name;
  const type = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? "FILE";
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => {
    const shows = type === "PDF" || imageTypes.has(type) || textTypes.has(type);
    if (!shows || (typeof file === "string" && !hostId)) return;
    let live = true;
    let drawing: Promise<Preview | undefined>;
    // A page in a frame is drawn wide enough to read its headings.
    const width = fill ? 240 : 84;
    if (typeof file === "string") {
      const key = `${hostId}\n${file}\n${width}`;
      drawing = drawn.get(key) ?? previewOf(type, readUpload(hostId!, file), width);
      drawn.set(key, drawing);
      // A host that's away now may answer later.
      drawing.catch(() => drawn.delete(key));
    } else drawing = previewOf(type, file.arrayBuffer(), width);
    drawing.then((made) => live && setPreview(made)).catch(() => {});
    return () => {
      live = false;
    };
  }, [file, hostId, type, fill]);
  return (
    <span
      className={`group relative shrink-0 overflow-hidden rounded-xl border border-border bg-surface ${fill ? "aspect-[4/5] w-full" : "size-28"}`}
    >
      {fill && !(preview && "url" in preview && !preview.page) ? (
        // A sheet of paper in a frame, cut off at the bottom as if it runs on.
        <span className="flex h-full bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] px-4 pt-4">
          <span className="block w-full overflow-hidden rounded-t-sm bg-white shadow-[0_2px_10px_rgb(0_0_0/0.35)] ring-1 ring-black/10">
            {preview && "url" in preview ? (
              <img src={preview.url} alt="" className="block w-full" />
            ) : (
              <span className="block p-3 font-mono text-micro leading-snug break-words whitespace-pre-wrap text-[#3d3d3d]">
                {preview ? preview.text : name}
              </span>
            )}
          </span>
        </span>
      ) : preview && "url" in preview ? (
        <img
          src={preview.url}
          alt=""
          className={
            preview.page ? "mx-auto h-full w-3/4 object-cover object-top" : "size-full object-cover"
          }
        />
      ) : preview ? (
        <span className="block h-full overflow-hidden p-2.5 font-mono text-micro leading-snug break-words whitespace-pre-wrap text-muted-foreground [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
          {preview.text}
        </span>
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
