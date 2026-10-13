import { DOMSerializer } from "@tiptap/pm/model";
import { Download } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";

import {
  download,
  drawPdfPage,
  kinds,
  titleOf,
  useDocument,
  type DocRef,
  type Opened,
} from "./documents";
import { renderSlide } from "./pptx";
import { cellAt, colName, type Xlsx } from "./xlsx";

/** Opens a presented file in the side panel (App.tsx), where the transcript's cards can reach it. */
export const OpenDocumentContext = createContext<((doc: DocRef) => void) | undefined>(undefined);

/**
 * The files an agent presented with `present_files` (PLX-755), as cards: a thumbnail of each
 * file's real first page, with its second fanning out behind it on hover, its title and type,
 * and Download. Clicking a card opens the file in the side panel.
 */
export function FileCards({ hostId, files }: { hostId: string; files: DocRef[] }) {
  const open = useContext(OpenDocumentContext);
  return (
    <div className="flex max-w-xl flex-col gap-2">
      {files.map((doc) => (
        <FileCard key={doc.path} hostId={hostId} doc={doc} onOpen={open} />
      ))}
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
  const { loaded, error } = useDocument(hostId, doc);
  const width = doc.kind === "pptx" ? 100 : 72;
  return (
    <div className="group relative flex h-[88px] items-center gap-4 overflow-hidden rounded-2xl border border-border bg-surface pr-4 pl-5 hover:bg-hover">
      <button
        type="button"
        aria-label={`Open ${doc.name}`}
        title={doc.name}
        disabled={!onOpen}
        onClick={() => onOpen?.(doc)}
        className="absolute inset-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div aria-hidden className="pointer-events-none relative h-full shrink-0" style={{ width }}>
        {loaded && (
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
        {!loaded && (
          <div className="absolute top-4 left-0 h-24 rounded-[3px] bg-selected" style={{ width }} />
        )}
      </div>
      <div className="pointer-events-none min-w-0 flex-1">
        <p className="truncate text-[15px] text-foreground">{titleOf(doc.name)}</p>
        <p className="truncate text-[13px] text-muted-foreground">
          {error ?? `${kinds[doc.kind].label} · ${doc.kind.toUpperCase()}`}
        </p>
      </div>
      <button
        type="button"
        disabled={!loaded}
        onClick={() => loaded && download(doc.name, loaded.bytes)}
        className="relative flex shrink-0 items-center gap-1.5 rounded-lg bg-selected px-3 py-1.5 text-[13px] text-foreground hover:bg-hover disabled:opacity-50 [&_svg]:size-3.5"
      >
        <Download aria-hidden />
        Download
      </button>
    </div>
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
    case "docx": {
      const { docx } = opened;
      const { top, right, bottom, left } = docx.page;
      sheet.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
      const style = document.createElement("style");
      style.textContent = `.${docx.scope}{${docx.base};white-space:pre-wrap}\n${docx.css}`;
      const clip = document.createElement("div");
      clip.style.height = "100%";
      clip.style.overflow = "hidden";
      const flow = document.createElement("div");
      flow.className = docx.scope;
      flow.style.transform = `translateY(-${page * (height - top - bottom)}px)`;
      flow.append(DOMSerializer.fromSchema(docx.schema).serializeFragment(docx.doc.content));
      clip.append(flow);
      sheet.append(style, clip);
      return sheet;
    }
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
      className={`overflow-hidden rounded-[3px] bg-white shadow-sm ring-1 ring-black/10 ${className}`}
    />
  );
}
