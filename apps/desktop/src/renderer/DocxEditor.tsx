import { baseKeymap, splitBlockAs, toggleMark } from "@tiptap/pm/commands";
import { history, redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import type { Attrs, MarkType, Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Command } from "@tiptap/pm/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  tableEditing,
} from "@tiptap/pm/tables";
import { EditorView } from "@tiptap/pm/view";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  SeparatorHorizontal,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Underline,
  Undo2,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState, type RefObject } from "react";

import {
  changeSummary,
  endsStyle,
  HIGHLIGHTS,
  isBulleted,
  listNumId,
  newLink,
  newTable,
  pageBreak,
  paragraphTexts,
  saveDocx,
  type Docx,
  type Num,
} from "./docx";

/** What an editor hands Save: the file's new bytes, and what changed, for the agent. */
export type Saver = () => { bytes: Uint8Array; changes: string[] };

export interface EditorProps {
  saver: RefObject<Saver | undefined>;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
}

/** The width a scroll area's content has, as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>) {
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

// Font sizes, in Word's half-points.
const SIZES = [16, 18, 20, 21, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 144];
const SPACINGS: [string, string][] = [
  ["240", "1.0"],
  ["276", "1.15"],
  ["360", "1.5"],
  ["480", "2.0"],
];
// The marks Clear formatting removes; links stay, as in Word.
const FORMATTING = [
  "font",
  "bold",
  "italic",
  "strike",
  "color",
  "size",
  "highlight",
  "underline",
  "vertAlign",
] as const;

const button =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40 aria-pressed:bg-selected aria-pressed:text-foreground [&_svg]:size-4";
const select = "h-7 rounded-md bg-selected px-1.5 text-[12.5px]";

/** Sets attributes of every paragraph the selection touches, tables' cells included. */
const setParagraphs =
  (change: (attrs: Attrs) => Attrs): Command =>
  (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type !== state.schema.nodes["paragraph"]) return true;
      tr.setNodeMarkup(pos, undefined, change(node.attrs));
      return false;
    });
    if (!tr.docChanged) return false;
    dispatch?.(tr);
    return true;
  };

/** Every paragraph the selection touches. */
function selectedParagraphs(state: EditorState): PMNode[] {
  const found: PMNode[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (node.type !== state.schema.nodes["paragraph"]) return true;
    found.push(node);
    return false;
  });
  return found;
}

/** Puts mark `type` with `attrs` on the selection, or takes it off with `null`. */
const setMark =
  (type: MarkType, attrs: Attrs | null): Command =>
  (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    if (empty) {
      if (attrs) tr.addStoredMark(type.create(attrs));
      else tr.removeStoredMark(type);
    } else if (attrs) tr.addMark(from, to, type.create(attrs));
    else tr.removeMark(from, to, type);
    dispatch?.(tr);
    return true;
  };

/** A list's level changed by `by`, or for a plain paragraph its indent by half an inch. */
const indent =
  (by: number): Command =>
  (state, dispatch) =>
    setParagraphs((attrs) => {
      const num = attrs["num"] as Num | null;
      if (num)
        return {
          ...attrs,
          num: { ...num, ilvl: String(Math.min(8, Math.max(0, Number(num.ilvl) + by))) },
        };
      const ind = { ...(attrs["ind"] as Record<string, string> | null) };
      const left = Math.max(0, Number(ind["w:left"] ?? ind["w:start"] ?? 0) + by * 720);
      delete ind["w:start"];
      if (left) ind["w:left"] = String(left);
      else delete ind["w:left"];
      return { ...attrs, ind: Object.keys(ind).length ? ind : null };
    })(state, dispatch);

/**
 * A .docx on a page as wide as its own, zoomed to fit, with Word's Home tab: undo and redo,
 * paragraph style, font, size, bold, italic, underline, strike, super- and subscript, color,
 * highlight, clear formatting, alignment, line spacing, lists, indent, links, tables, and page
 * breaks. Tab moves between table cells and changes a list's level.
 */
export function DocxEditor({ docx, saver, onDirty, onSave }: { docx: Docx } & EditorProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView>();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [linkDraft, setLinkDraft] = useState<string>();
  const handlers = useRef({ onDirty, onSave });
  handlers.current = { onDirty, onSave };
  const width = useWidth(scroll);
  const zoom = width ? Math.min(1, (width - 32) / docx.page.width) : 1;
  const { schema } = docx;

  useEffect(() => {
    // Enter splits a paragraph keeping its look, except after a heading, as Word does, and the
    // new paragraph's text keeps the formatting the cursor had.
    const enter: Command = (state, dispatch) => {
      const marks = state.storedMarks ?? state.selection.$from.marks();
      return splitBlockAs((node, atEnd) =>
        atEnd && endsStyle(node.attrs["style"])
          ? { type: schema.nodes.paragraph }
          : { type: node.type, attrs: node.attrs },
      )(state, dispatch && ((tr) => dispatch(tr.ensureMarks(marks))));
    };
    const inList = (state: EditorState) => selectedParagraphs(state).some((p) => p.attrs["num"]);
    const tab =
      (dir: 1 | -1): Command =>
      (state, dispatch) => {
        if (isInTable(state)) return goToNextCell(dir)(state, dispatch);
        if (inList(state)) return indent(dir)(state, dispatch);
        if (dir === 1) dispatch?.(state.tr.insertText("\t"));
        return true;
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
            Tab: tab(1),
            "Shift-Tab": tab(-1),
          }),
          keymap(baseKeymap),
          tableEditing(),
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
  }, [docx, saver, schema]);

  const run = (command: Command) => {
    if (!view) return;
    command(view.state, view.dispatch);
    view.focus();
  };
  const state = view?.state;
  // The controls show the formatting at the cursor, or of a selection's first character.
  const marks = !state
    ? []
    : state.selection.empty
      ? (state.storedMarks ?? state.selection.$from.marks())
      : (state.doc.nodeAt(state.selection.from)?.marks ?? state.selection.$from.marks());
  const markAttr = (type: MarkType, attr: string) =>
    marks.find((m) => m.type === type)?.attrs[attr] as string | undefined;
  const markOn = (type: MarkType) => {
    if (!state) return false;
    const { from, to, empty } = state.selection;
    return empty ? !!type.isInSet(marks) : state.doc.rangeHasMark(from, to, type);
  };
  const paragraph = state?.selection.$from.parent;
  const attr = (name: string) => paragraph?.attrs[name] as unknown;
  const num = attr("num") as Num | null | undefined;
  const listKind = num ? (isBulleted(docx, num.numId) ? "bullet" : "number") : undefined;
  const align = (attr("align") as string | null) ?? "left";
  const spacing = (attr("spacing") as Record<string, string> | null)?.["w:line"] ?? "";
  const style = (attr("style") as string | null) ?? docx.styles[0]?.id ?? "";
  const inTable = !!state && isInTable(state);

  const toggleList = (kind: "bullet" | "number") => {
    if (!view) return;
    const all = selectedParagraphs(view.state);
    const off = all.every((p) => {
      const n = p.attrs["num"] as Num | null;
      return n && isBulleted(docx, n.numId) === (kind === "bullet");
    });
    const numId = off ? undefined : listNumId(docx, kind);
    run(
      setParagraphs((a) => ({
        ...a,
        num: numId ? { numId, ilvl: (a["num"] as Num | null)?.ilvl ?? "0" } : null,
      })),
    );
  };
  const applyLink = (url: string) => {
    setLinkDraft(undefined);
    if (!view || !url.trim()) return;
    const link = schema.marks.link.create({ id: newLink(docx, url.trim()) });
    const { from, to, empty } = view.state.selection;
    const tr = empty
      ? view.state.tr.insertText(url.trim(), from).addMark(from, from + url.trim().length, link)
      : view.state.tr.addMark(from, to, link);
    view.dispatch(tr);
    view.focus();
  };
  const unlink: Command = (s, dispatch) => {
    const { $from, from, to, empty } = s.selection;
    if (!empty) {
      dispatch?.(s.tr.removeMark(from, to, schema.marks.link));
      return true;
    }
    // The whole link around the cursor.
    const link = $from.marks().find((m) => m.type === schema.marks.link);
    if (!link) return false;
    let start = $from.pos;
    let end = $from.pos;
    const parentStart = $from.start();
    $from.parent.forEach((child, offset) => {
      const at = parentStart + offset;
      if (!link.isInSet(child.marks)) return;
      if (at <= $from.pos && at + child.nodeSize >= $from.pos) {
        start = Math.min(start, at);
        end = Math.max(end, at + child.nodeSize);
      }
    });
    dispatch?.(s.tr.removeMark(start, end, schema.marks.link));
    return true;
  };
  const clearFormatting: Command = (s, dispatch) => {
    const { from, to, empty } = s.selection;
    const plain = schema.marks.run.create({ rPr: null });
    if (empty) {
      dispatch?.(s.tr.setStoredMarks([plain]));
      return true;
    }
    const tr = s.tr;
    for (const name of FORMATTING) tr.removeMark(from, to, schema.marks[name]);
    tr.addMark(from, to, plain);
    dispatch?.(tr);
    return true;
  };
  // Built when run: a new table's properties and a page break's run join the document's elements.
  const insert =
    (node: () => PMNode): Command =>
    (s, dispatch) => {
      dispatch?.(s.tr.replaceSelectionWith(node()).scrollIntoView());
      return true;
    };

  const toggle = (label: string, icon: LucideIcon, type: MarkType, keys?: string) => {
    const Icon = icon;
    return (
      <button
        type="button"
        aria-label={label}
        title={keys ? `${label} (${keys})` : label}
        aria-pressed={markOn(type)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(toggleMark(type))}
        className={button}
      >
        <Icon />
      </button>
    );
  };
  const action = (
    label: string,
    icon: LucideIcon,
    command: Command,
    pressed?: boolean,
    disabled?: boolean,
  ) => {
    const Icon = icon;
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={pressed}
        disabled={disabled || !view}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(command)}
        className={button}
      >
        <Icon />
      </button>
    );
  };
  const divider = <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />;
  const color = markAttr(schema.marks.color, "val");
  const vertAlign = markAttr(schema.marks.vertAlign, "val");

  return (
    <>
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1"
      >
        {action("Undo", Undo2, undo, undefined, !state || !undoDepth(state))}
        {action("Redo", Redo2, redo, undefined, !state || !redoDepth(state))}
        {divider}
        {docx.styles.length > 0 && (
          <select
            aria-label="Paragraph style"
            value={style}
            onChange={(e) => run(setParagraphs((a) => ({ ...a, style: e.target.value || null })))}
            className={`${select} max-w-28`}
          >
            {!docx.styles.some((s) => s.id === style) && <option value={style}>{style}</option>}
            {docx.styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Font"
          value={markAttr(schema.marks.font, "name") ?? ""}
          onChange={(e) =>
            run(setMark(schema.marks.font, e.target.value ? { name: e.target.value } : null))
          }
          className={`${select} max-w-28`}
        >
          <option value="">Default font</option>
          {docx.fonts.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
        <select
          aria-label="Font size"
          value={markAttr(schema.marks.size, "half") ?? ""}
          onChange={(e) =>
            run(setMark(schema.marks.size, e.target.value ? { half: e.target.value } : null))
          }
          className={select}
        >
          <option value="">Size</option>
          {[...new Set([...SIZES.map(String), markAttr(schema.marks.size, "half") ?? ""])]
            .filter(Boolean)
            .sort((a, b) => Number(a) - Number(b))
            .map((half) => (
              <option key={half} value={half}>
                {Number(half) / 2}
              </option>
            ))}
        </select>
        {divider}
        {toggle("Bold", Bold, schema.marks.bold, "⌘B")}
        {toggle("Italic", Italic, schema.marks.italic, "⌘I")}
        {toggle("Underline", Underline, schema.marks.underline, "⌘U")}
        {toggle("Strikethrough", Strikethrough, schema.marks.strike)}
        {action(
          "Superscript",
          Superscript,
          setMark(
            schema.marks.vertAlign,
            vertAlign === "superscript" ? null : { val: "superscript" },
          ),
          vertAlign === "superscript",
        )}
        {action(
          "Subscript",
          Subscript,
          setMark(schema.marks.vertAlign, vertAlign === "subscript" ? null : { val: "subscript" }),
          vertAlign === "subscript",
        )}
        <label title="Text color" className={`${button} relative cursor-pointer`}>
          <span
            aria-hidden
            className="text-[13px] font-semibold underline decoration-[3px] underline-offset-2"
            style={{ textDecorationColor: color ? `#${color}` : "currentColor" }}
          >
            A
          </span>
          <input
            type="color"
            aria-label="Text color"
            value={color ? `#${color}` : "#000000"}
            onChange={(e) =>
              run(setMark(schema.marks.color, { val: e.target.value.slice(1).toUpperCase() }))
            }
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <select
          aria-label="Highlight"
          value={markAttr(schema.marks.highlight, "val") ?? ""}
          onChange={(e) =>
            run(setMark(schema.marks.highlight, e.target.value ? { val: e.target.value } : null))
          }
          className={select}
        >
          <option value="">No highlight</option>
          {Object.keys(HIGHLIGHTS).map((name) => (
            <option key={name} value={name}>
              {name.replace(/([A-Z])/g, " $1").toLowerCase()}
            </option>
          ))}
        </select>
        {action("Clear formatting", RemoveFormatting, clearFormatting)}
        {divider}
        {action(
          "Align left",
          AlignLeft,
          setParagraphs((a) => ({ ...a, align: "left" })),
          align === "left" || align === "start",
        )}
        {action(
          "Center",
          AlignCenter,
          setParagraphs((a) => ({ ...a, align: "center" })),
          align === "center",
        )}
        {action(
          "Align right",
          AlignRight,
          setParagraphs((a) => ({ ...a, align: "right" })),
          align === "right" || align === "end",
        )}
        {action(
          "Justify",
          AlignJustify,
          setParagraphs((a) => ({ ...a, align: "both" })),
          align === "both",
        )}
        <select
          aria-label="Line spacing"
          value={SPACINGS.some(([v]) => v === spacing) ? spacing : ""}
          onChange={(e) =>
            run(
              setParagraphs((a) => ({
                ...a,
                spacing: {
                  ...(a["spacing"] as Record<string, string> | null),
                  "w:line": e.target.value,
                  "w:lineRule": "auto",
                },
              })),
            )
          }
          className={select}
        >
          <option value="" disabled>
            Spacing
          </option>
          {SPACINGS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Bulleted list"
          title="Bulleted list"
          aria-pressed={listKind === "bullet"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleList("bullet")}
          className={button}
        >
          <List />
        </button>
        <button
          type="button"
          aria-label="Numbered list"
          title="Numbered list"
          aria-pressed={listKind === "number"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleList("number")}
          className={button}
        >
          <ListOrdered />
        </button>
        {action("Decrease indent", IndentDecrease, indent(-1))}
        {action("Increase indent", IndentIncrease, indent(1))}
        {divider}
        <button
          type="button"
          aria-label="Link"
          title="Link"
          aria-pressed={linkDraft !== undefined || markOn(schema.marks.link)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setLinkDraft(linkDraft === undefined ? "https://" : undefined)}
          className={button}
        >
          <Link />
        </button>
        {action("Remove link", Unlink, unlink, undefined, !markOn(schema.marks.link))}
        {action(
          "Insert table",
          Table,
          insert(() => newTable(docx, 3, 3)),
        )}
        {action(
          "Page break",
          SeparatorHorizontal,
          insert(() => pageBreak(docx)),
        )}
        {inTable && (
          <>
            {divider}
            {(
              [
                ["Row above", addRowBefore],
                ["Row below", addRowAfter],
                ["Column left", addColumnBefore],
                ["Column right", addColumnAfter],
                ["Delete row", deleteRow],
                ["Delete column", deleteColumn],
                ["Delete table", deleteTable],
              ] as const
            ).map(([label, command]) => (
              <button
                key={label}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(command)}
                className="h-7 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                {label}
              </button>
            ))}
          </>
        )}
        {linkDraft !== undefined && (
          <form
            className="flex w-full items-center gap-1 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              applyLink(linkDraft);
            }}
          >
            <input
              autoFocus
              aria-label="Link address"
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setLinkDraft(undefined)}
              className="h-7 min-w-0 flex-1 rounded-md bg-selected px-2 text-[12.5px] outline-none"
            />
            <button
              type="submit"
              className="h-7 rounded-md bg-primary px-2.5 text-[12.5px] text-primary-foreground"
            >
              Apply
            </button>
          </form>
        )}
      </div>
      <div ref={scroll} className="min-h-0 flex-1 overflow-auto bg-selected p-4">
        <style>{`.${docx.scope}{${docx.base};white-space:pre-wrap;caret-color:#000}\n.${docx.scope} .selectedCell{background:rgb(37 99 235 / 15%)}\n${docx.css()}`}</style>
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
