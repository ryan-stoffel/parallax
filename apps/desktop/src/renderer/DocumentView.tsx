import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { pagesOf, type Docx } from "./docx";
import { download, drawPdfPage, titleOf, useDocument, type DocRef } from "./documents";
import { drawPage, pageSize } from "./FileCards";
import { cellAt, colName, splitRef, type Xlsx } from "./xlsx";

/**
 * A presented file in the side panel (PLX-755), view-only, as Claude shows one: its title and
 * type and Download over its pages, which sit on a gray backdrop with the page in view counted at
 * the bottom right. The panel's own button takes it full screen. A spreadsheet shows as its
 * sheets' grids instead.
 */
export function DocumentView({ hostId, doc }: { hostId: string; doc: DocRef }) {
  const { loaded, error } = useDocument(hostId, doc);
  const type = doc.kind.toUpperCase();

  let body: ReactNode;
  if (error) body = <p className="p-6 text-[13px] text-muted-foreground">{error}</p>;
  else if (!loaded) body = <p className="p-6 text-[13px] text-muted-foreground">Opening…</p>;
  else {
    const { opened } = loaded;
    body =
      opened.kind === "docx" ? (
        <DocxPages docx={opened.docx} />
      ) : opened.kind === "xlsx" ? (
        <SheetView xlsx={opened.xlsx} />
      ) : opened.kind === "pdf" ? (
        <Paged count={opened.pdf.numPages} ratio={opened.ratio}>
          {(page, width) => <Drawn draw={() => drawPdfPage(opened.pdf, page + 1, width)} />}
        </Paged>
      ) : (
        <Paged count={opened.pptx.slides.length} ratio={opened.pptx.height / opened.pptx.width}>
          {(page, width) => (
            <Drawn
              draw={() =>
                drawPage(opened, page).then((node) => scaled(node, pageSize(opened), width))
              }
            />
          )}
        </Paged>
      );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">
          {titleOf(doc.name)}
          <span className="text-muted-foreground"> · {type}</span>
        </p>
        <button
          type="button"
          disabled={!loaded}
          onClick={() => loaded && download(doc.name, loaded.bytes)}
          className="rounded-lg bg-selected px-3 py-1 text-[13px] text-foreground hover:bg-hover disabled:opacity-40"
        >
          Download as {type}
        </button>
      </div>
      {body}
    </div>
  );
}

/** The width a scroll area's content has, as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** `node`, drawn at `natural` size, scaled to `width` in a box that clips it. */
function scaled(node: HTMLElement, natural: { width: number; height: number }, width: number) {
  const scale = width / natural.width;
  const box = document.createElement("div");
  box.style.width = `${width}px`;
  box.style.height = `${natural.height * scale}px`;
  box.style.overflow = "hidden";
  node.style.transform = `scale(${scale})`;
  node.style.transformOrigin = "0 0";
  box.append(node);
  return box;
}

/**
 * `count` pages, each as wide as the panel less its margins, one under another on a gray
 * backdrop, with "Page n / count" for the page at the middle of the view. `ratio` is a page's
 * height over its width, which holds each page's place before it draws.
 */
function Paged({
  count,
  ratio,
  children,
}: {
  count: number;
  ratio: number;
  children: (page: number, width: number) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const width = Math.min(1100, Math.max(0, useWidth(scroll) - 48));
  const [current, setCurrent] = useState(1);
  const track = () => {
    const el = scroll.current;
    if (!el) return;
    const middle = el.getBoundingClientRect().top + el.clientHeight / 2;
    const pages = [...el.querySelectorAll<HTMLElement>("[data-page]")];
    const at = pages.findLast((page) => page.getBoundingClientRect().top <= middle);
    setCurrent(Number(at?.dataset["page"] ?? 1));
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroll} onScroll={track} className="min-h-0 flex-1 overflow-y-auto bg-selected">
        <div className="flex flex-col items-center gap-5 px-6 py-6">
          {!!width &&
            Array.from({ length: count }, (_, page) => (
              <div
                key={`${page}:${width}`}
                data-page={page + 1}
                className="overflow-hidden bg-white shadow-sm"
                style={{ width, minHeight: width * ratio }}
              >
                {children(page, width)}
              </div>
            ))}
        </div>
      </div>
      {count > 0 && (
        <span className="pointer-events-none absolute right-5 bottom-4 rounded-lg bg-black/55 px-2.5 py-1 text-[13px] text-white tabular-nums">
          Page {current} / {count}
        </span>
      )}
    </div>
  );
}

/** A DOM node `draw` makes, once. */
function Drawn({ draw }: { draw: () => Promise<HTMLElement> }) {
  const ref = useRef<HTMLDivElement>(null);
  const drawRef = useRef(draw);
  useEffect(() => {
    let live = true;
    void drawRef.current().then((node) => live && ref.current?.replaceChildren(node));
    return () => {
      live = false;
    };
  }, []);
  return <div ref={ref} />;
}

/** A .docx on its pages, each zoomed to the panel's width, so a page that grows keeps its height. */
function DocxPages({ docx }: { docx: Docx }) {
  const [pages, setPages] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => setPages(pagesOf(docx)), [docx]);
  return (
    <Paged count={pages.length} ratio={docx.page.height / docx.page.width}>
      {(index, width) => <Zoomed node={pages[index]!} zoom={width / docx.page.width} />}
    </Paged>
  );
}

/** An existing node, zoomed. */
function Zoomed({ node, zoom }: { node: HTMLElement; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    node.style.zoom = String(zoom);
    ref.current?.replaceChildren(node);
  }, [node, zoom]);
  return <div ref={ref} />;
}

/**
 * A workbook's sheets as grids, with tabs for each sheet. ponytail: draws at most 1,000 rows and
 * 60 columns without virtualizing; add a virtual grid for bigger sheets.
 */
function SheetView({ xlsx }: { xlsx: Xlsx }) {
  const [index, setIndex] = useState(0);
  const sheet = xlsx.sheets[index]!;
  let rows = 30;
  let cols = 10;
  for (const ref of sheet.cells.keys()) {
    const { row, col } = splitRef(ref);
    rows = Math.max(rows, row + 5);
    cols = Math.max(cols, col + 3);
  }
  rows = Math.min(rows, 1000);
  cols = Math.min(cols, 60);
  const head = "border border-[#d4d4d4] bg-[#f3f3f3] px-1.5 font-normal text-[#555]";

  return (
    <>
      <div
        role="grid"
        aria-label={sheet.name}
        className="min-h-0 flex-1 overflow-auto bg-white text-[13px] text-black"
      >
        <table
          className="border-collapse"
          style={{ fontFamily: "Calibri, Carlito, Arial, sans-serif" }}
        >
          <thead>
            <tr>
              <th className={`sticky top-0 left-0 z-20 ${head}`} />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={c}
                  className={`sticky top-0 z-10 ${head}`}
                  style={{ minWidth: sheet.widths.get(c) ?? 64 }}
                >
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => {
              const row = i + 1;
              return (
                <tr key={row} style={{ height: sheet.heights.get(row) ?? 20 }}>
                  <th className={`sticky left-0 z-10 ${head}`}>{row}</th>
                  {Array.from({ length: cols }, (_, col) => {
                    const ref = `${colName(col)}${row}`;
                    if (sheet.covered.has(ref)) return null;
                    const merge = sheet.merges.get(ref);
                    const cell = cellAt(xlsx, sheet, ref);
                    return (
                      <td
                        key={ref}
                        role="gridcell"
                        rowSpan={merge?.rows}
                        colSpan={merge?.cols}
                        className="overflow-hidden border border-[#e1e1e1] px-1 whitespace-nowrap"
                        style={{
                          maxWidth: (sheet.widths.get(col) ?? 64) * (merge?.cols ?? 1),
                          textAlign: cell.number ? "right" : undefined,
                          ...cssObject(cell.css),
                        }}
                      >
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {xlsx.sheets.length > 1 && (
        <div
          role="tablist"
          aria-label="Sheets"
          className="flex gap-0.5 overflow-x-auto border-t border-border px-2 py-1"
        >
          {xlsx.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => setIndex(i)}
              className="rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover aria-selected:bg-selected aria-selected:text-foreground"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** `a:b;c:d` as a React style object. */
function cssObject(css: string): Record<string, string> {
  return Object.fromEntries(
    css
      .split(";")
      .filter(Boolean)
      .map((rule) => {
        const [key = "", value = ""] = rule.split(":");
        return [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value];
      }),
  );
}
