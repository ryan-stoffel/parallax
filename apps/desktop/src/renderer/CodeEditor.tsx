import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { Annotation, Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Panel,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import type { OpenFile, OpenFiles } from "./openFiles";
import { appShortcut } from "./ui";

/** Where the cursor is, for the status line. */
export type Cursor = { line: number; column: number; selected: number; language?: string };

/** Marks a change that came from disk, which isn't an edit to save. */
const fromDisk = Annotation.define<boolean>();

/** Colors from the app's variables, so the appearance and any VS Code theme apply. */
const colors = HighlightStyle.define([
  {
    tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword],
    color: "var(--syntax-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.url], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
    ],
    color: "var(--syntax-title)",
  },
  { tag: [t.heading, t.strong], color: "var(--syntax-title)", fontWeight: "600" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syntax-type)" },
  { tag: [t.comment, t.meta, t.quote], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** The editor drawn with the app's own surfaces and type. */
const look = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-meta, 12px)",
    lineHeight: "20px",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--foreground)", padding: "6px 0 24px" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--faint-foreground)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "40px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px 0 0" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in oklab, var(--accent) 30%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--accent) 16%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--accent) 24%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--syntax-string) 28%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--syntax-string) 55%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--hover)",
    border: "none",
    color: "var(--muted-foreground)",
    padding: "0 6px",
    borderRadius: "4px",
  },
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--foreground)",
    fontFamily: "var(--font-sans)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-find": { display: "flex", flexDirection: "column", gap: "4px", padding: "4px 6px" },
  ".cm-find-row": { display: "flex", alignItems: "center", gap: "2px" },
  ".cm-find-row[hidden]": { display: "none" },
  ".cm-find-field": {
    flex: "1 1 0",
    minWidth: "60px",
    height: "24px",
    backgroundColor: "var(--hover)",
    border: "1px solid transparent",
    borderRadius: "6px",
    color: "var(--foreground)",
    fontSize: "12px",
    outline: "none",
    padding: "0 6px",
  },
  ".cm-find-field:focus": { borderColor: "var(--ring)" },
  ".cm-find-count": {
    color: "var(--faint-foreground)",
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    padding: "0 4px",
    whiteSpace: "nowrap",
  },
  ".cm-find-button": {
    height: "24px",
    minWidth: "24px",
    padding: "0 4px",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "6px",
    color: "var(--muted-foreground)",
    cursor: "default",
    fontSize: "12px",
  },
  ".cm-find-button:hover": { backgroundColor: "var(--hover)", color: "var(--foreground)" },
  ".cm-find-button[aria-pressed=true]": {
    backgroundColor: "var(--selected)",
    color: "var(--foreground)",
  },
});

/** How many matches the find bar counts before it says "999+". */
const MAX_COUNTED = 999;

/** The find bar: one compact row, with a second for replacing when it's asked for. */
function findBar(view: EditorView): Panel {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  };
  const field = (label: string) => {
    const input = make("input", "cm-find-field");
    input.setAttribute("aria-label", label);
    input.placeholder = label;
    input.spellcheck = false;
    return input;
  };
  const button = (text: string, label: string, run: () => void) => {
    const element = make("button", "cm-find-button");
    element.type = "button";
    element.textContent = text;
    element.title = label;
    element.setAttribute("aria-label", label);
    element.onclick = run;
    return element;
  };
  const toggle = (text: string, label: string, on: boolean) => {
    const element = button(text, label, () => {
      element.setAttribute("aria-pressed", String(element.getAttribute("aria-pressed") !== "true"));
      commit();
    });
    element.setAttribute("aria-pressed", String(on));
    return element;
  };
  const start = getSearchQuery(view.state);
  const find = field("Find");
  find.value = start.search;
  find.setAttribute("main-field", "true");
  const replace = field("Replace");
  replace.value = start.replace;
  const pressed = (element: HTMLElement) => element.getAttribute("aria-pressed") === "true";
  const matchCase = toggle("Aa", "Match case", start.caseSensitive);
  const word = toggle("ab", "Whole word", start.wholeWord);
  const regexp = toggle(".*", "Regular expression", start.regexp);
  const commit = () =>
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: find.value,
          replace: replace.value,
          caseSensitive: pressed(matchCase),
          wholeWord: pressed(word),
          regexp: pressed(regexp),
        }),
      ),
    });
  const count = make("span", "cm-find-count");
  const recount = () => {
    const query = getSearchQuery(view.state);
    if (!query.search || !query.valid) {
      count.textContent = query.search ? "Invalid" : "";
      return;
    }
    const cursor = query.getCursor(view.state);
    let found = 0;
    while (found <= MAX_COUNTED && !cursor.next().done) found++;
    count.textContent = found > MAX_COUNTED ? `${MAX_COUNTED}+` : String(found);
  };
  find.oninput = commit;
  replace.oninput = commit;
  find.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) findPrevious(view);
    else findNext(view);
  };
  replace.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    replaceNext(view);
  };
  const dom = make("div", "cm-find");
  dom.onkeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    closeSearchPanel(view);
    view.focus();
  };
  const replacing = make("div", "cm-find-row");
  replacing.hidden = true;
  replacing.append(
    replace,
    button("Replace", "Replace", () => replaceNext(view)),
    button("All", "Replace all", () => replaceAll(view)),
  );
  const showReplace = button("⇄", "Replace", () => {
    replacing.hidden = !replacing.hidden;
    showReplace.setAttribute("aria-pressed", String(!replacing.hidden));
  });
  const row = make("div", "cm-find-row");
  row.append(
    find,
    count,
    matchCase,
    word,
    regexp,
    button("↑", "Previous match", () => findPrevious(view)),
    button("↓", "Next match", () => findNext(view)),
    showReplace,
    button("×", "Close", () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );
  dom.append(row, replacing);
  recount();
  return {
    dom,
    top: true,
    mount: () => {
      find.focus();
      find.select();
    },
    update: (update) => {
      if (
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))
      )
        recount();
    },
  };
}

const language = new Compartment();
const wrapping = new Compartment();
const editing = new Compartment();

const wrapped = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);
const editable = (on: boolean): Extension => [
  EditorState.readOnly.of(!on),
  EditorView.editable.of(on),
];

/** The first line and column of the main selection, for the status line. */
function cursorOf(state: EditorState): Cursor {
  const { main } = state.selection;
  const line = state.doc.lineAt(main.head);
  return { line: line.number, column: main.head - line.from + 1, selected: main.to - main.from };
}

/**
 * One tab's text in CodeMirror. One view serves every tab: switching swaps its state, so each keeps
 * its edits, cursor, undo, and scroll. Its changes go to `store`, which saves them.
 */
export default function CodeEditor({
  store,
  file,
  wrap,
  onCursor,
}: {
  store: OpenFiles;
  file: OpenFile;
  wrap: boolean;
  onCursor: (cursor: Cursor) => void;
}) {
  const body = file.body.kind === "text" ? file.body : undefined;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const shown = useRef<number | undefined>(undefined);
  // The latest of what the extensions, made once, read.
  const latest = useRef({ store, onCursor, id: file.id });
  latest.current = { store, onCursor, id: file.id };
  const lang = useRef<string | undefined>(undefined);

  const stateFor = (text: string, canEdit: boolean) =>
    EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        rectangularSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        search({ top: true, createPanel: findBar }),
        // The app's shortcuts stay the app's, and its Find finds in this file.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (e, editor) => {
              const command = appShortcut(e);
              if (command !== "find") return command !== undefined;
              e.preventDefault();
              openSearchPanel(editor);
              return true;
            },
          }),
        ),
        syntaxHighlighting(colors),
        look,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void latest.current.store.save(latest.current.id);
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        language.of([]),
        wrapping.of(wrapped(wrap)),
        editing.of(editable(canEdit)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromDisk))) {
            const { state } = update;
            latest.current.store.edited(latest.current.id, () => state.doc.toString());
          }
          if (update.docChanged || update.selectionSet)
            latest.current.onCursor({
              ...cursorOf(update.state),
              ...(lang.current && { language: lang.current }),
            });
        }),
      ],
    });

  // The view, for as long as a text tab is on screen.
  useEffect(() => {
    const created = new EditorView({ parent: host.current! });
    view.current = created;
    return () => {
      if (shown.current !== undefined) store.keep(shown.current, created.state);
      shown.current = undefined;
      view.current = undefined;
      created.destroy();
    };
  }, [store]);

  /** Makes the view show what's on disk, changing only what differs so the cursor stays put. */
  const takeFromDisk = (current: EditorView, after: string) => {
    const before = current.state.doc.toString();
    if (before === after) return;
    let from = 0;
    const shortest = Math.min(before.length, after.length);
    while (from < shortest && before[from] === after[from]) from++;
    let end = 0;
    while (
      end < shortest - from &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    current.dispatch({
      changes: { from, to: before.length - end, insert: after.slice(from, after.length - end) },
      annotations: fromDisk.of(true),
    });
  };

  // The state of the tab on screen, kept for the one left.
  const canEdit = !!body && !body.readOnly;
  useEffect(() => {
    const current = view.current;
    if (!current || !body || shown.current === file.id) return;
    if (shown.current !== undefined) store.keep(shown.current, current.state);
    shown.current = file.id;
    current.setState(
      (store.kept(file.id) as EditorState | undefined) ?? stateFor(body.text, canEdit),
    );
    current.dispatch({
      effects: [wrapping.reconfigure(wrapped(wrap)), editing.reconfigure(editable(canEdit))],
    });
    // A reload while another tab was on screen.
    if (!store.unsaved(file.id)) takeFromDisk(current, body.text);
    lang.current = undefined;
    onCursor(cursorOf(current.state));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- on another tab only; the next effects keep it current
  }, [file.id, !!body]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [wrapping.reconfigure(wrapped(wrap)), editing.reconfigure(editable(canEdit))],
    });
  }, [wrap, canEdit]);

  // Its language, loaded on first use.
  useEffect(() => {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const description = LanguageDescription.matchFilename(languages, name);
    if (!description) return;
    lang.current = description.name;
    let stopped = false;
    void description.load().then((support) => {
      if (stopped || !view.current) return;
      view.current.dispatch({ effects: language.reconfigure(support) });
      onCursor({ ...cursorOf(view.current.state), language: description.name });
    });
    return () => {
      stopped = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- by file; onCursor is the latest anyway
  }, [file.id, file.path, !!body]);

  // A reload from disk.
  const reloads = body?.reloads ?? 0;
  useEffect(() => {
    if (view.current && body && shown.current === file.id) takeFromDisk(view.current, body.text);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only a reload replaces the text
  }, [reloads]);

  return <div ref={host} aria-label={file.path} className="min-h-0 flex-1 overflow-hidden" />;
}
