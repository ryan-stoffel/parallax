import { baseKeymap, splitBlockAs, toggleMark } from "@tiptap/pm/commands";
import { history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import type { MarkType } from "@tiptap/pm/model";
import { EditorState, type Command } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { Bold, Download, Italic, Underline } from "lucide-react";
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { changeSummary, endsStyle, openDocx, paragraphTexts, saveDocx, type Docx } from "./docx";
import {
  download,
  drawPdfPage,
  kinds,
  sendSaved,
  titleOf,
  useDocument,
  writeDocument,
  type DocRef,
} from "./documents";
import { drawPage, pageSize } from "./FileCards";
import {
  cellAt,
  colName,
  editSummary,
  openXlsx,
  saveXlsx,
  setCell,
  splitRef,
  type Xlsx,
} from "./xlsx";

/** What an editor hands Save: the file's new bytes, and what changed, for the agent. */
type Saver = () => { bytes: Uint8Array; changes: string[] };

/**
 * A presented file in the side panel (PLX-755): a .docx or .xlsx to edit and save, or a .pptx or
 * .pdf to read, with Download. Save writes the file in the thread's folder, then tells the file's
 * thread what changed.
 */
export function DocumentView({ hostId, doc }: { hostId: string; doc: DocRef }) {
  const { loaded, error } = useDocument(hostId, doc);
  // The editor's own copy, opened from the bytes, so edits a closed tab drops never reach the
  // cards' copy or the next tab.
  const own = useMemo(
    () =>
      loaded?.opened.kind === "docx"
        ? { docx: openDocx(loaded.bytes) }
        : loaded?.opened.kind === "xlsx"
          ? { xlsx: openXlsx(loaded.bytes) }
          : {},
    [loaded],
  );
  const saver = useRef<Saver>(undefined);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const editable = kinds[doc.kind].editable;
  // A reload after a save starts the editor over, clean.
  const [shown, setShown] = useState(loaded);
  if (loaded !== shown) {
    setShown(loaded);
    setDirty(false);
  }

  const save = async () => {
    if (!saver.current || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const { bytes, changes } = saver.current();
      const failed = await writeDocument(hostId, doc, bytes);
      if (failed) return setSaveError(failed);
      const unsent = await sendSaved(hostId, doc, changes);
      if (unsent) setSaveError(`saved, but the agent wasn't told: ${unsent}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  let body: ReactNode;
  if (error) body = <p className="p-6 text-[13px] text-muted-foreground">{error}</p>;
  else if (!loaded) body = <p className="p-6 text-[13px] text-muted-foreground">Opening…</p>;
  else {
    const { opened } = loaded;
    const editor = { saver, onDirty: setDirty, onSave: () => void saveRef.current() };
    body = own.docx ? (
      <DocxEditor docx={own.docx} {...editor} />
    ) : own.xlsx ? (
      <SheetGrid xlsx={own.xlsx} {...editor} />
    ) : opened.kind === "pptx" || opened.kind === "pdf" ? (
      <Pages count={opened.kind === "pptx" ? opened.pptx.slides.length : opened.pdf.numPages}>
        {(page, width) =>
          opened.kind === "pdf" ? (
            <Drawn draw={() => drawPdfPage(opened.pdf, page + 1, width)} />
          ) : (
            <Drawn
              draw={() =>
                drawPage(opened, page).then((node) => {
                  const scale = width / pageSize(opened).width;
                  const wrap = document.createElement("div");
                  wrap.style.width = `${width}px`;
                  wrap.style.height = `${pageSize(opened).height * scale}px`;
                  wrap.style.overflow = "hidden";
                  node.style.transform = `scale(${scale})`;
                  node.style.transformOrigin = "0 0";
                  wrap.append(node);
                  return wrap;
                })
              }
            />
          )
        }
      </Pages>
    ) : null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">
          {titleOf(doc.name)}
          <span className="text-muted-foreground"> · {doc.kind.toUpperCase()}</span>
        </p>
        {editable && (
          <button
            type="button"
            disabled={!dirty || saving || !loaded}
            onClick={() => void save()}
            title="Save and tell the agent (⌘S)"
            className="rounded-lg bg-primary px-3 py-1 text-[13px] text-primary-foreground disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button
          type="button"
          disabled={!loaded}
          onClick={() => loaded && download(doc.name, loaded.bytes)}
          className="flex items-center gap-1.5 rounded-lg bg-selected px-3 py-1 text-[13px] hover:bg-hover disabled:opacity-40 [&_svg]:size-3.5"
        >
          <Download aria-hidden />
          Download
        </button>
      </div>
      {saveError && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-[12.5px] text-danger">
          Couldn't save: {saveError}
        </p>
      )}
      {body}
    </div>
  );
}

interface EditorProps {
  saver: RefObject<Saver | undefined>;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
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

/** Each page or slide, as wide as the panel, one under another. */
function Pages({
  count,
  children,
}: {
  count: number;
  children: (page: number, width: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = Math.max(0, useWidth(ref) - 32);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto bg-selected">
      <div className="flex flex-col items-center gap-4 p-4">
        {!!width &&
          Array.from({ length: count }, (_, page) => (
            <div key={`${page}:${width}`} className="bg-white shadow-sm" style={{ width }}>
              {children(page, width)}
            </div>
          ))}
      </div>
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

const toolbarButton =
  "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground [&_svg]:size-4";

/** A .docx on a page as wide as its own, zoomed to fit, with paragraph styles and B, I, U. */
function DocxEditor({ docx, saver, onDirty, onSave }: { docx: Docx } & EditorProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView>();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const handlers = useRef({ onDirty, onSave });
  handlers.current = { onDirty, onSave };
  const width = useWidth(scroll);
  const zoom = width ? Math.min(1, (width - 32) / docx.page.width) : 1;

  useEffect(() => {
    const { schema } = docx;
    // Enter splits a paragraph keeping its style, except after a heading, as Word does, and
    // the new paragraph's text keeps the formatting the cursor had.
    const enter: Command = (state, dispatch) => {
      const marks = state.storedMarks ?? state.selection.$from.marks();
      return splitBlockAs((node, atEnd) =>
        atEnd && endsStyle(node.attrs["style"])
          ? { type: schema.nodes.paragraph }
          : { type: node.type, attrs: node.attrs },
      )(state, dispatch && ((tr) => dispatch(tr.ensureMarks(marks))));
    };
    const editor = new EditorView(mount.current!, {
      state: EditorState.create({
        doc: docx.doc,
        plugins: [
          history(),
          keymap({
            "Mod-z": undo,
            "Shift-Mod-z": redo,
            "Mod-y": redo,
            "Mod-b": toggleMark(schema.marks.bold),
            "Mod-i": toggleMark(schema.marks.italic),
            "Mod-u": toggleMark(schema.marks.underline),
            "Mod-s": () => {
              handlers.current.onSave();
              return true;
            },
            Enter: enter,
          }),
          keymap(baseKeymap),
        ],
      }),
      attributes: {
        class: `${docx.scope} outline-none`,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Document",
      },
      dispatchTransaction(tr) {
        const next = editor.state.apply(tr);
        editor.updateState(next);
        if (tr.docChanged) handlers.current.onDirty(!next.doc.eq(docx.doc));
        refresh();
      },
    });
    saver.current = () => ({
      bytes: saveDocx(docx, editor.state.doc),
      changes: changeSummary(docx.texts, paragraphTexts(docx, editor.state.doc)),
    });
    setView(editor);
    return () => {
      saver.current = undefined;
      editor.destroy();
    };
  }, [docx, saver]);

  const markOn = (type: MarkType | undefined) => {
    if (!view || !type) return false;
    const { from, $from, to, empty } = view.state.selection;
    return empty
      ? !!type.isInSet(view.state.storedMarks ?? $from.marks())
      : view.state.doc.rangeHasMark(from, to, type);
  };
  const mark = (type: MarkType | undefined) => {
    if (!view || !type) return;
    toggleMark(type)(view.state, view.dispatch);
    view.focus();
  };
  const current = view?.state.selection.$from.parent.attrs["style"] as string | null | undefined;
  const defaultStyle = docx.styles[0]?.id ?? "";
  const setStyle = (style: string) => {
    if (!view) return;
    const { from, to } = view.state.selection;
    const tr = view.state.tr;
    view.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type !== docx.schema.nodes.paragraph) return;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, style: style || null });
      return false;
    });
    view.dispatch(tr);
    view.focus();
  };
  const { bold, italic, underline } = docx.schema.marks;

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {docx.styles.length > 0 && (
          <select
            aria-label="Paragraph style"
            value={current ?? defaultStyle}
            onChange={(e) => setStyle(e.target.value)}
            className="mr-1 rounded-md bg-selected px-2 py-1 text-[12.5px]"
          >
            {current && !docx.styles.some((s) => s.id === current) && (
              <option value={current}>{current}</option>
            )}
            {docx.styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-label="Bold"
          title="Bold (⌘B)"
          aria-pressed={markOn(bold)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => mark(bold)}
          className={toolbarButton}
        >
          <Bold />
        </button>
        <button
          type="button"
          aria-label="Italic"
          title="Italic (⌘I)"
          aria-pressed={markOn(italic)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => mark(italic)}
          className={toolbarButton}
        >
          <Italic />
        </button>
        <button
          type="button"
          aria-label="Underline"
          title="Underline (⌘U)"
          aria-pressed={markOn(underline)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => mark(underline)}
          className={toolbarButton}
        >
          <Underline />
        </button>
      </div>
      <div ref={scroll} className="min-h-0 flex-1 overflow-auto bg-selected p-4">
        <style>{`.${docx.scope}{${docx.base};white-space:pre-wrap;caret-color:#000}\n${docx.css}`}</style>
        <div
          className="mx-auto bg-white text-black shadow-sm"
          style={{
            zoom,
            width: docx.page.width,
            minHeight: docx.page.height,
            padding: `${docx.page.top}px ${docx.page.right}px ${docx.page.bottom}px ${docx.page.left}px`,
            boxSizing: "border-box",
          }}
        >
          <div ref={mount} />
        </div>
      </div>
    </>
  );
}

/**
 * A workbook's sheets as grids. Select a cell to see its formula or value; type, Enter, F2, or
 * double-click to edit it in place; Enter or Tab keeps the edit and moves on, Escape drops it.
 * ponytail: draws at most 1,000 rows and 60 columns without virtualizing; add a virtual grid for
 * bigger sheets.
 */
function SheetGrid({ xlsx, saver, onDirty, onSave }: { xlsx: Xlsx } & EditorProps) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState("A1");
  const [draft, setDraft] = useState<string>();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const grid = useRef<HTMLDivElement>(null);
  const sheet = xlsx.sheets[index]!;
  useEffect(() => {
    saver.current = () => ({ bytes: saveXlsx(xlsx), changes: editSummary(xlsx) });
    return () => {
      saver.current = undefined;
    };
  }, [xlsx, saver]);

  let rows = 30;
  let cols = 10;
  for (const ref of sheet.cells.keys()) {
    const { row, col } = splitRef(ref);
    rows = Math.max(rows, row + 5);
    cols = Math.max(cols, col + 3);
  }
  rows = Math.min(rows, 1000);
  cols = Math.min(cols, 60);

  const move = (dRow: number, dCol: number) => {
    const { row, col } = splitRef(selected);
    setSelected(
      `${colName(Math.min(cols - 1, Math.max(0, col + dCol)))}${Math.min(rows, Math.max(1, row + dRow))}`,
    );
  };
  const commit = (text: string) => {
    setCell(xlsx, sheet, selected, text);
    setDraft(undefined);
    onDirty(xlsx.edits.size > 0);
    refresh();
  };
  const onGridKey = (e: KeyboardEvent) => {
    if (draft !== undefined) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      return onSave();
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    const step = arrows[e.key];
    if (step) {
      e.preventDefault();
      move(...step);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      setDraft(cellAt(xlsx, sheet, selected).input);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      commit("");
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setDraft(e.key);
    }
  };
  const selectedCell = cellAt(xlsx, sheet, selected);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[12.5px]">
        <span className="w-12 font-mono text-muted-foreground">{selected}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{selectedCell.input}</span>
      </div>
      <div
        ref={grid}
        tabIndex={0}
        role="grid"
        aria-label={sheet.name}
        onKeyDown={onGridKey}
        className="min-h-0 flex-1 overflow-auto bg-white text-[13px] text-black outline-none"
      >
        <table
          className="border-collapse"
          style={{ fontFamily: "Calibri, Carlito, Arial, sans-serif" }}
        >
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 border border-[#d4d4d4] bg-[#f3f3f3]" />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 border border-[#d4d4d4] bg-[#f3f3f3] px-1 font-normal text-[#555]"
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
                  <th className="sticky left-0 z-10 border border-[#d4d4d4] bg-[#f3f3f3] px-1.5 font-normal text-[#555]">
                    {row}
                  </th>
                  {Array.from({ length: cols }, (_, col) => {
                    const ref = `${colName(col)}${row}`;
                    if (sheet.covered.has(ref)) return null;
                    const merge = sheet.merges.get(ref);
                    const cell = cellAt(xlsx, sheet, ref);
                    const isSelected = ref === selected;
                    return (
                      <td
                        key={ref}
                        role="gridcell"
                        aria-selected={isSelected}
                        rowSpan={merge?.rows}
                        colSpan={merge?.cols}
                        onMouseDown={() => {
                          if (draft !== undefined && !isSelected) commit(draft);
                          setSelected(ref);
                        }}
                        onDoubleClick={() => setDraft(cell.input)}
                        className={`relative overflow-hidden border border-[#e1e1e1] px-1 whitespace-nowrap ${isSelected ? "outline-2 -outline-offset-1 outline-[#1a73e8]" : ""}`}
                        style={{
                          maxWidth: (sheet.widths.get(col) ?? 64) * (merge?.cols ?? 1),
                          textAlign: cell.number ? "right" : undefined,
                          ...cssObject(cell.css),
                        }}
                      >
                        {isSelected && draft !== undefined ? (
                          <input
                            autoFocus
                            aria-label={`Edit ${ref}`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "Tab") {
                                e.preventDefault();
                                commit(draft);
                                move(e.key === "Enter" ? 1 : 0, e.key === "Tab" ? 1 : 0);
                                grid.current?.focus();
                              } else if (e.key === "Escape") {
                                setDraft(undefined);
                                grid.current?.focus();
                              }
                            }}
                            className="absolute inset-0 w-full bg-white px-1 outline-none"
                          />
                        ) : (
                          cell.text
                        )}
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
              key={s.path}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => {
                setIndex(i);
                setSelected("A1");
                setDraft(undefined);
              }}
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
