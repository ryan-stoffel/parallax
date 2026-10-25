import { Download, File } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import {
  download,
  drawPdfPage,
  kinds,
  readPresented,
  readWorking,
  sizeOf,
  titleOf,
  typeOf,
  useDocument,
  useObjectUrl,
  workingSize,
  type DocRef,
  type Opened,
} from "./documents";
import { pagesOf } from "./docx";
import { Lightbox } from "./Lightbox";
import { useSaveWhole, useStreamUrl } from "./mediaUrl";
import { notify } from "./notifications";
import { isMedia, isVideo } from "./transcript";
import { renderSlide } from "./pptx";
import { cellAt, colName, type Xlsx } from "./xlsx";

/** Opens a presented file in the side panel (App.tsx), where the transcript's cards can reach it. */
export const OpenDocumentContext = createContext<((doc: DocRef) => void) | undefined>(undefined);

/**
 * The files an agent presented with `present_files` (PLX-755), as cards: a thumbnail of each
 * file's real first page, with its second fanning out behind it on hover, its title and type,
 * and Download. Clicking a card opens the file in the side panel. An image or video shows at
 * full width instead, with Download in its corner (PLX-785), an image opening in the Lightbox
 * when clicked (PLX-998), and a video its host streams plays while it loads (PLX-836). A file of
 * any other kind is a plain card with its name, size, and Download (PLX-834). `item` is the transcript row: when it's newer than any row already seen
 * for a file, the file is read from disk again.
 */
export function FileCards({
  hostId,
  item,
  files,
}: {
  hostId: string;
  item: string;
  files: DocRef[];
}) {
  const open = useContext(OpenDocumentContext);
  readPresented(hostId, item, files);
  return (
    <div className="flex flex-col gap-2">
      {files.map((doc) =>
        isMedia(doc.kind) ? (
          <MediaFile key={doc.path} hostId={hostId} doc={doc} />
        ) : (
          <FileCard key={doc.path} hostId={hostId} doc={doc} onOpen={open} />
        ),
      )}
    </div>
  );
}

function FileCard({
  hostId,
  doc,
  onOpen,
}: {
  hostId: string;
  doc: DocRef;
  onOpen?: (doc: DocRef) => void;
}) {
  const plain = doc.kind === "file";
  // A plain file shows only its size, and is read when Download is clicked (PLX-835).
  const { loaded, error: loadError, progress } = useDocument(hostId, doc, !plain);
  const [file, setFile] = useState<{ size?: number; share?: number; error?: string }>({});
  useEffect(() => {
    if (!plain) return;
    let live = true;
    void workingSize(hostId, doc.runId, doc.path).then(
      (size) => live && setFile({ size }),
      (error: unknown) =>
        live && setFile({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [hostId, plain, doc.runId, doc.path]);
  const save = () => {
    if (!plain) return loaded && download(doc.name, loaded.bytes);
    setFile((f) => ({ size: f.size, share: 0 }));
    readWorking(hostId, doc.runId, doc.path, (share) => setFile((f) => ({ ...f, share }))).then(
      (bytes) => {
        download(doc.name, bytes);
        setFile((f) => ({ size: f.size }));
      },
      (error: unknown) => {
        setFile((f) => ({ size: f.size }));
        downloadFailed(doc.name, error);
      },
    );
  };
  const error = plain ? file.error : loadError;
  const reading = plain ? file.share : progress;
  const width = doc.kind === "pptx" ? 100 : 72;
  const what = isMedia(doc.kind)
    ? ""
    : reading !== undefined
      ? `Reading ${Math.round(reading * 100)}%`
      : plain && file.size !== undefined
        ? sizeOf(file.size)
        : kinds[doc.kind];
  return (
    <div className="group relative flex h-[88px] max-w-xl items-center gap-4 overflow-hidden rounded-xl border border-border bg-surface pr-4 pl-5 hover:bg-hover">
      <button
        type="button"
        aria-label={`Open ${doc.name}`}
        title={doc.name}
        disabled={!onOpen}
        onClick={() => onOpen?.(doc)}
        className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div aria-hidden className="pointer-events-none relative h-full shrink-0" style={{ width }}>
        {plain && (
          <div
            className="absolute top-4 left-0 grid h-24 place-items-start justify-center rounded-sm bg-selected pt-6 text-muted-foreground"
            style={{ width }}
          >
            <File className="size-6" />
          </div>
        )}
        {loaded && !plain && (
          <>
            <Thumb
              opened={loaded.opened}
              page={1}
              width={width}
              className="absolute top-4 left-0 origin-bottom opacity-0 transition duration-200 group-hover:-translate-x-2 group-hover:-rotate-[8deg] group-hover:opacity-100"
            />
            <Thumb
              opened={loaded.opened}
              page={0}
              width={width}
              className="absolute top-4 left-0 origin-bottom transition duration-200 group-hover:translate-x-1 group-hover:rotate-[3deg]"
            />
          </>
        )}
        {!loaded && !plain && (
          <div className="absolute top-4 left-0 h-24 rounded-sm bg-selected" style={{ width }} />
        )}
      </div>
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate text-reading text-foreground">{titleOf(doc.name)}</p>
        <p className="truncate text-body text-muted-foreground">
          {error ?? `${what} · ${typeOf(doc)}`}
        </p>
      </div>
      <button
        type="button"
        disabled={plain ? file.share !== undefined : !loaded}
        onClick={save}
        className="relative flex shrink-0 items-center gap-1.5 rounded-lg bg-selected px-3 py-1.5 text-body text-foreground hover:bg-hover disabled:opacity-50 [&_svg]:size-3.5"
      >
        <Download aria-hidden />
        Download
      </button>
    </div>
  );
}

/**
 * An image or video at the transcript's width, with Download on top: a video its host streams
 * (PLX-836) from main's scheme, anything else from its bytes.
 */
function MediaFile({ hostId, doc }: { hostId: string; doc: DocRef }) {
  const src = useStreamUrl(hostId, doc);
  return src === null ? (
    <ReadMedia hostId={hostId} doc={doc} />
  ) : (
    <StreamedMedia hostId={hostId} doc={doc} src={src} />
  );
}

/** An image or video read whole, as a blob: URL. */
function ReadMedia({ hostId, doc }: { hostId: string; doc: DocRef }) {
  const { loaded, error } = useDocument(hostId, doc);
  const url = useObjectUrl(loaded?.bytes);
  if (error)
    return (
      <p className="rounded-xl border border-border bg-surface px-5 py-4 text-body text-muted-foreground">
        {doc.name} · {error}
      </p>
    );
  return (
    <MediaFrame
      doc={doc}
      url={url}
      disabled={!loaded}
      onDownload={() => loaded && download(doc.name, loaded.bytes)}
    />
  );
}

/** A streamed video, whose Download reads it whole only when clicked. */
function StreamedMedia({ hostId, doc, src }: { hostId: string; doc: DocRef; src?: string }) {
  const { busy, error, save } = useSaveWhole(hostId, doc);
  useEffect(() => {
    if (error) downloadFailed(doc.name, error);
  }, [error, doc.name]);
  return <MediaFrame doc={doc} url={src} disabled={!src || busy} onDownload={save} />;
}

/**
 * `url`'s image or video, or a placeholder until it has one, with Download in its corner. Clicking
 * the image opens it in the Lightbox, with Download there too.
 */
function MediaFrame({
  doc,
  url,
  disabled,
  onDownload,
}: {
  doc: DocRef;
  url?: string;
  disabled: boolean;
  onDownload: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-black">
      {!url ? (
        <div aria-label={`Loading ${doc.name}`} className="aspect-video w-full bg-selected" />
      ) : isVideo(doc.kind) ? (
        <video controls src={url} aria-label={doc.name} className="block max-h-[80vh] w-full" />
      ) : (
        <button
          type="button"
          aria-label={`Open ${doc.name}`}
          onClick={() => setShown(true)}
          className="block w-full cursor-zoom-in"
        >
          <img src={url} alt={doc.name} className="block max-h-[80vh] w-full object-contain" />
        </button>
      )}
      {shown && url && (
        <Lightbox
          images={[{ src: url, name: doc.name }]}
          index={0}
          onIndex={() => {}}
          onClose={() => setShown(false)}
          onDownload={onDownload}
        />
      )}
      <button
        type="button"
        aria-label={`Download ${doc.name}`}
        title="Download"
        disabled={disabled}
        onClick={onDownload}
        className="absolute top-2 right-2 grid size-8 place-items-center rounded-lg bg-black/60 text-white backdrop-blur hover:bg-black/80 disabled:opacity-50 [&_svg]:size-4"
      >
        <Download aria-hidden />
      </button>
    </div>
  );
}

/** Says in a notification why `name` couldn't be downloaded. */
export const downloadFailed = (name: string, error: unknown) =>
  notify({
    tone: "error",
    title: `Couldn't download ${name}`,
    body: error instanceof Error ? error.message : String(error),
  });

/**
 * Download for bytes read only when it's clicked, such as a recording's (PLX-834): saves what
 * `read` gives as `name`, or says why it couldn't in a notification.
 */
export function DownloadButton({ name, read }: { name: string; read: () => Promise<Uint8Array> }) {
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    read()
      .then(
        (bytes) => download(name, bytes),
        (error: unknown) => downloadFailed(name, error),
      )
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={save}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5"
      >
        <Download aria-hidden />
        Download
      </button>
    </span>
  );
}

/** A page's size in CSS pixels as `drawPage` draws it. */
export function pageSize(opened: Opened): { width: number; height: number } {
  switch (opened.kind) {
    case "docx":
      return opened.docx.page;
    case "pptx":
      return opened.pptx;
    default:
      // A Letter page, for a sheet's grid and a PDF's thumbnail.
      return { width: 816, height: 1056 };
  }
}

/**
 * Page `page` of a file, counted from 0, drawn at `pageSize`: a document's paragraphs shifted up
 * by the pages before it, a sheet's grid likewise, a slide, or a PDF's page. Past the last page,
 * a blank one.
 */
export async function drawPage(opened: Opened, page: number): Promise<HTMLElement> {
  const { width, height } = pageSize(opened);
  const sheet = document.createElement("div");
  sheet.setAttribute(
    "style",
    `width:${width}px;height:${height}px;background:#fff;overflow:hidden;box-sizing:border-box;color:#000`,
  );
  switch (opened.kind) {
    case "docx":
      // The same pages the side panel shows.
      return pagesOf(opened.docx)[page] ?? sheet;
    case "xlsx": {
      sheet.style.padding = "24px";
      const flow = gridPreview(opened.xlsx);
      flow.style.transform = `translateY(-${page * (height - 48)}px)`;
      sheet.append(flow);
      return sheet;
    }
    case "pptx":
      return page < opened.pptx.slides.length ? renderSlide(opened.pptx, page) : sheet;
    case "pdf": {
      if (page >= opened.pdf.numPages) return sheet;
      sheet.append(await drawPdfPage(opened.pdf, page + 1, width));
      return sheet;
    }
    case "media":
    case "file":
      return sheet;
  }
}

/** A sheet's first rows as a static grid, for thumbnails. */
function gridPreview(xlsx: Xlsx): HTMLElement {
  const first = xlsx.sheets[0]!;
  const table = document.createElement("table");
  table.setAttribute(
    "style",
    "border-collapse:collapse;font:11pt Calibri,Carlito,Arial,sans-serif",
  );
  for (let r = 1; r <= 80; r++) {
    const row = document.createElement("tr");
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("td");
      const { text, css, number } = cellAt(xlsx, first, `${colName(c)}${r}`);
      cell.setAttribute(
        "style",
        `border:1px solid #e1e1e1;height:20px;min-width:${first.widths.get(c) ?? 64}px;padding:0 4px;white-space:nowrap;${number ? "text-align:right;" : ""}${css}`,
      );
      cell.textContent = text;
      row.append(cell);
    }
    table.append(row);
  }
  return table;
}

/** Page `page` of a file, scaled to `width` CSS pixels, as a sheet of paper. */
export function Thumb({
  opened,
  page,
  width,
  className = "",
}: {
  opened: Opened;
  page: number;
  width: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const size = pageSize(opened);
  const scale = width / size.width;
  useEffect(() => {
    let live = true;
    void drawPage(opened, page).then((node) => {
      if (!live || !ref.current) return;
      node.style.transform = `scale(${scale})`;
      node.style.transformOrigin = "0 0";
      ref.current.replaceChildren(node);
    });
    return () => {
      live = false;
    };
  }, [opened, page, scale]);
  return (
    <div
      ref={ref}
      style={{ width, height: size.height * scale }}
      className={`overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/10 ${className}`}
    />
  );
}
