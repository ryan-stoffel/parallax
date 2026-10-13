import { readXml, unzip, writeXml, zip, type Parts } from "./ooxml";

/**
 * A .xlsx as the side panel edits it (PLX-755). Each sheet's XML is edited in place: a changed
 * cell keeps its style, and every other cell, sheet, chart, and part is written back as it was.
 * Formulas aren't calculated here, so saving tells Excel to recalculate on open and drops the
 * calculation chain, which a changed formula could leave stale.
 */
export interface Xlsx {
  parts: Parts;
  workbook: Document;
  sheets: Sheet[];
  shared: string[];
  styles: CellStyle[];
  /** Edited cells, as `Sheet!A1`, with their input when opened and now. */
  edits: Map<string, { before: string; after: string }>;
}

export interface Sheet {
  name: string;
  path: string;
  xml: Document;
  data: Element;
  cells: Map<string, Element>;
  rows: Map<number, Element>;
  /** Column widths in pixels, by zero-based column, where the sheet sets them. */
  widths: Map<number, number>;
  /** Row heights in pixels, by one-based row, where the sheet sets them. */
  heights: Map<number, number>;
  /** Merged ranges by their top-left cell, and the cells they cover. */
  merges: Map<string, { rows: number; cols: number }>;
  covered: Set<string>;
  edited: boolean;
  /** Each shared formula's first cell and formula, by its `si`, found on first use. */
  masters?: Map<string, { ref: string; formula: string }>;
}

interface CellStyle {
  format: string;
  css: string;
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const all = (el: Element | Document | undefined, name: string) =>
  el ? [...el.getElementsByTagNameNS(NS, name)] : [];
const first = (el: Element | Document | undefined, name: string) => all(el, name)[0];
const childOf = (el: Element, name: string) =>
  [...el.children].find((c) => c.localName === name && c.namespaceURI === NS);

/** A1-style references: column letters to a zero-based index and back. */
export const colIndex = (letters: string) => {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n - 1;
};
export const colName = (index: number): string =>
  index < 0 ? "" : colName(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));
export const splitRef = (ref: string) => {
  const [, letters = "A", digits = "1"] = /^([A-Z]+)(\d+)$/.exec(ref) ?? [];
  return { col: colIndex(letters), row: Number(digits) };
};

/** Opens a .xlsx's bytes. Throws when it has no readable workbook. */
export function openXlsx(bytes: Uint8Array): Xlsx {
  const parts = unzip(bytes);
  const workbook = readXml(parts, "xl/workbook.xml");
  if (!workbook) throw new Error("This file has no Excel workbook in it.");
  const relDoc = readXml(parts, "xl/_rels/workbook.xml.rels");
  const targets = new Map(
    [...(relDoc?.getElementsByTagName("Relationship") ?? [])].map((r) => [
      r.getAttribute("Id"),
      r.getAttribute("Target") ?? "",
    ]),
  );
  const shared = all(readXml(parts, "xl/sharedStrings.xml"), "si").map((si) =>
    all(si, "t")
      .filter((t) => t.parentElement?.localName !== "rPh")
      .map((t) => t.textContent ?? "")
      .join(""),
  );
  const sheets: Sheet[] = [];
  for (const entry of all(workbook, "sheet")) {
    const target = targets.get(
      entry.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      ),
    );
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const xml = readXml(parts, path);
    const data = first(xml, "sheetData");
    if (!xml || !data) continue;
    const cells = new Map(all(data, "c").map((c) => [c.getAttribute("r") ?? "", c]));
    const rows = new Map(all(data, "row").map((r) => [Number(r.getAttribute("r")), r]));
    const widths = new Map<number, number>();
    for (const col of all(first(xml, "cols"), "col")) {
      const width = Number(col.getAttribute("width"));
      for (
        let c = Number(col.getAttribute("min"));
        c <= Number(col.getAttribute("max")) && c <= 200;
        c++
      )
        if (width) widths.set(c - 1, Math.round(width * 7 + 5));
    }
    const heights = new Map<number, number>();
    for (const [r, row] of rows) {
      const ht = Number(row.getAttribute("ht"));
      if (ht) heights.set(r, Math.round((ht * 4) / 3));
    }
    const merges = new Map<string, { rows: number; cols: number }>();
    const covered = new Set<string>();
    for (const merge of all(xml, "mergeCell")) {
      const [from = "", to = from] = (merge.getAttribute("ref") ?? "").split(":");
      const a = splitRef(from);
      const b = splitRef(to);
      merges.set(from, { rows: b.row - a.row + 1, cols: b.col - a.col + 1 });
      for (let r = a.row; r <= b.row; r++)
        for (let c = a.col; c <= b.col; c++)
          if (r !== a.row || c !== a.col) covered.add(`${colName(c)}${r}`);
    }
    sheets.push({
      name: entry.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
      path,
      xml,
      data,
      cells,
      rows,
      widths,
      heights,
      merges,
      covered,
      edited: false,
    });
  }
  if (!sheets.length) throw new Error("This workbook has no sheets.");
  return { parts, workbook, sheets, shared, styles: stylesOf(parts), edits: new Map() };
}

/**
 * `formula` moved by `rows` and `cols`, as Excel fills it down or across: relative references
 * shift, `$` ones stay, and text in quotes, quoted sheet names, function names, and sheet names
 * don't move.
 */
export function shiftFormula(formula: string, rows: number, cols: number): string {
  const col = (fixed = "", letters = "") =>
    fixed + (fixed ? letters : colName(colIndex(letters) + cols));
  const row = (fixed = "", digits = "") => fixed + (fixed ? digits : String(Number(digits) + rows));
  // Quoted text and sheet names stay; then a whole-column range such as B:B, a whole-row range
  // such as 3:3, or one cell.
  const reference =
    /("(?:[^"]|"")*"|'(?:[^']|'')*'!)|(?<c1f>\$?)(?<c1>[A-Z]{1,3}):(?<c2f>\$?)(?<c2>[A-Z]{1,3})(?![\w(!])|(?<r1f>\$?)(?<r1>\d+):(?<r2f>\$?)(?<r2>\d+)(?![\w(!])|(?<cf>\$?)(?<c>[A-Z]{1,3})(?<rf>\$?)(?<r>\d+)(?![\w(!])/g;
  return formula.replace(reference, (...args: unknown[]) => {
    const [match, quoted] = args as [string, string | undefined];
    const at = args.at(-3) as number;
    const g = args.at(-1) as Record<string, string | undefined>;
    if (quoted || /[\w.$]/.test(formula[at - 1] ?? "")) return match;
    if (g["c1"]) return `${col(g["c1f"], g["c1"])}:${col(g["c2f"], g["c2"])}`;
    if (g["r1"]) return `${row(g["r1f"], g["r1"])}:${row(g["r2f"], g["r2"])}`;
    return col(g["cf"], g["c"]) + row(g["rf"], g["r"]);
  });
}

/**
 * A cell's formula. A cell of a shared formula, one Excel filled down or across, holds only its
 * group's `si`, and its formula is the group's first cell's, moved.
 */
function formulaOf(sheet: Sheet, ref: string, f: Element | undefined): string | undefined {
  if (!f) return undefined;
  const si = f.getAttribute("si");
  if (f.getAttribute("t") !== "shared" || f.textContent || si === null) return f.textContent ?? "";
  if (!sheet.masters) {
    sheet.masters = new Map();
    for (const [cellRef, c] of sheet.cells) {
      const master = childOf(c, "f");
      const id = master?.getAttribute("si");
      if (master?.getAttribute("t") === "shared" && master.textContent && id != null)
        sheet.masters.set(id, { ref: cellRef, formula: master.textContent });
    }
  }
  const master = sheet.masters.get(si);
  if (!master) return undefined;
  const from = splitRef(master.ref);
  const to = splitRef(ref);
  return shiftFormula(master.formula, to.row - from.row, to.col - from.col);
}

/** What a cell shows, and what editing it starts from: its formula with `=`, or its value. */
export function cellAt(x: Xlsx, sheet: Sheet, ref: string) {
  const c = sheet.cells.get(ref);
  if (!c) return { text: "", input: "", css: "", number: false };
  const type = c.getAttribute("t");
  const v = childOf(c, "v")?.textContent ?? "";
  const formula = formulaOf(sheet, ref, childOf(c, "f"));
  const style = x.styles[Number(c.getAttribute("s") ?? 0)];
  let text: string;
  let number = false;
  if (type === "s") text = x.shared[Number(v)] ?? "";
  else if (type === "inlineStr")
    text = all(c, "t")
      .map((t) => t.textContent ?? "")
      .join("");
  else if (type === "b") text = v === "1" ? "TRUE" : "FALSE";
  // A formula no app has calculated yet, as libraries such as openpyxl write them, shows itself.
  else if (v === "" && formula != null) text = `=${formula}`;
  else if (type === "str" || type === "e" || v === "") text = v;
  else {
    text = formatNumber(Number(v), style?.format ?? "General");
    number = true;
  }
  return { text, input: formula != null ? `=${formula}` : text, css: style?.css ?? "", number };
}

/** Sets a cell from what the user typed: a formula with `=`, a number, or text. Keeps its style. */
export function setCell(x: Xlsx, sheet: Sheet, ref: string, input: string) {
  const before = cellAt(x, sheet, ref).input;
  if (before === input) return;
  const doc = sheet.xml;
  const make = (name: string) => doc.createElementNS(NS, name);
  let c = sheet.cells.get(ref);
  if (!c) {
    const { row, col } = splitRef(ref);
    let r = sheet.rows.get(row);
    if (!r) {
      r = make("row");
      r.setAttribute("r", String(row));
      const after = [...sheet.rows.keys()].filter((n) => n > row).sort((a, b) => a - b)[0];
      sheet.data.insertBefore(r, after === undefined ? null : sheet.rows.get(after)!);
      sheet.rows.set(row, r);
    }
    c = make("c");
    c.setAttribute("r", ref);
    const next = [...r.children].find((other) => splitRef(other.getAttribute("r") ?? "").col > col);
    r.insertBefore(c, next ?? null);
    sheet.cells.set(ref, c);
  }
  // A shared formula's first cell holds the group's formula: each other cell takes its own
  // before this one changes.
  const shared = childOf(c, "f");
  const si = shared?.getAttribute("si");
  if (shared?.getAttribute("t") === "shared" && shared.textContent && si != null)
    for (const [otherRef, other] of sheet.cells) {
      const f = childOf(other, "f");
      if (other === c || f?.getAttribute("t") !== "shared" || f.getAttribute("si") !== si) continue;
      f.textContent = formulaOf(sheet, otherRef, f) ?? "";
      for (const name of ["t", "si", "ref"]) f.removeAttribute(name);
    }
  for (const name of ["f", "v", "is"]) childOf(c, name)?.remove();
  sheet.masters = undefined;
  c.removeAttribute("t");
  if (input.startsWith("=") && input.length > 1) {
    const f = make("f");
    f.textContent = input.slice(1);
    c.append(f);
  } else if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(input.trim())) {
    const v = make("v");
    v.textContent = String(Number(input));
    c.append(v);
  } else if (input) {
    c.setAttribute("t", "inlineStr");
    const is = make("is");
    const t = make("t");
    t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
    t.textContent = input;
    is.append(t);
    c.append(is);
  }
  sheet.edited = true;
  const key = `${sheet.name}!${ref}`;
  const opened = x.edits.get(key)?.before ?? before;
  if (opened === input) x.edits.delete(key);
  else x.edits.set(key, { before: opened, after: input });
}

/** Each edit, for the agent, such as `Budget!B4: "10" to "12"`. */
export const editSummary = (x: Xlsx, max = 20) => {
  const lines = [...x.edits].map(
    ([key, { before, after }]) => `${key}: ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
  );
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines;
};

/** The workbook with its edits, set to recalculate when Excel opens it. */
export function saveXlsx(x: Xlsx): Uint8Array {
  const parts: Parts = { ...x.parts };
  for (const sheet of x.sheets) if (sheet.edited) parts[sheet.path] = writeXml(sheet.xml);
  let calcPr = first(x.workbook, "calcPr");
  if (!calcPr) {
    calcPr = x.workbook.createElementNS(NS, "calcPr");
    // CT_Workbook's order: calcPr comes after these, and before everything else.
    const root = x.workbook.documentElement;
    const before = [
      "fileVersion",
      "fileSharing",
      "workbookPr",
      "workbookProtection",
      "bookViews",
      "sheets",
      "functionGroups",
      "externalReferences",
      "definedNames",
    ];
    const last = [...root.children].filter((c) => before.includes(c.localName)).at(-1);
    root.insertBefore(calcPr, last?.nextSibling ?? null);
  }
  calcPr.setAttribute("fullCalcOnLoad", "1");
  parts["xl/workbook.xml"] = writeXml(x.workbook);
  if (parts["xl/calcChain.xml"]) {
    delete parts["xl/calcChain.xml"];
    const drop = (path: string, test: (el: Element) => boolean, tag: string) => {
      const doc = readXml(parts, path);
      if (!doc) return;
      // A copy, since the live collection shrinks as elements go.
      for (const el of Array.from(doc.getElementsByTagName(tag))) if (test(el)) el.remove();
      parts[path] = writeXml(doc);
    };
    drop(
      "xl/_rels/workbook.xml.rels",
      (r) => (r.getAttribute("Type") ?? "").endsWith("/calcChain"),
      "Relationship",
    );
    drop(
      "[Content_Types].xml",
      (o) => o.getAttribute("PartName") === "/xl/calcChain.xml",
      "Override",
    );
  }
  return zip(parts);
}

const builtInFormats: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  49: "@",
};

/**
 * A number as its format shows it, for the common formats: dates, percents, decimals, grouping,
 * and a currency sign. ponytail: not Excel's full format language; add sections and conditions
 * when sheets need them.
 */
export function formatNumber(value: number, format: string): string {
  if (!Number.isFinite(value)) return String(value);
  const negative = format.split(";")[1];
  const section = (value < 0 && negative ? negative : (format.split(";")[0] ?? ""))
    .replace(/"[^"]*"|\[[^\]]*\]|\\./g, (m) => (m.startsWith('"') ? m.slice(1, -1) : ""))
    .trim();
  if (!section || /^general$/i.test(section) || section === "@")
    return String(Number(value.toPrecision(11)));
  if (/[dy]|m{3}|h/i.test(section)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86_400_000));
    const time = /h/i.test(section);
    const day = /[dy]|m{3}/i.test(section);
    const opts = { timeZone: "UTC" } as const;
    return [
      day && date.toLocaleDateString(undefined, opts),
      time && date.toLocaleTimeString(undefined, { ...opts, hour: "numeric", minute: "2-digit" }),
    ]
      .filter(Boolean)
      .join(" ");
  }
  const decimals = /\.([0#]+)/.exec(section)?.[1]?.length ?? 0;
  const percent = section.includes("%");
  const shown = Math.abs(percent ? value * 100 : value);
  let text = shown.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: section.includes(","),
  });
  if (percent) text += "%";
  const currency = /[$€£¥]/.exec(section)?.[0];
  if (currency) text = currency + text;
  const parenthesized = value < 0 && negative?.includes("(");
  return value < 0 ? (parenthesized ? `(${text})` : negative ? text : `-${text}`) : text;
}

/** Each cell style's number format and look, by the index a cell's `s` names. */
function stylesOf(parts: Parts): CellStyle[] {
  const doc = readXml(parts, "xl/styles.xml");
  if (!doc) return [];
  const formats = new Map(
    all(doc, "numFmt").map((f) => [
      Number(f.getAttribute("numFmtId")),
      f.getAttribute("formatCode") ?? "",
    ]),
  );
  const color = (el: Element | undefined) => {
    const rgb = el?.getAttribute("rgb");
    return rgb && rgb.length >= 6 ? `#${rgb.slice(-6)}` : undefined;
  };
  const fonts = all(first(doc, "fonts"), "font").map((font) => {
    const css: string[] = [];
    if (childOf(font, "b")) css.push("font-weight:700");
    if (childOf(font, "i")) css.push("font-style:italic");
    if (childOf(font, "u")) css.push("text-decoration:underline");
    const fg = color(childOf(font, "color"));
    if (fg) css.push(`color:${fg}`);
    const sz = Number(childOf(font, "sz")?.getAttribute("val"));
    if (sz && sz !== 11) css.push(`font-size:${sz}pt`);
    return css.join(";");
  });
  const fills = all(first(doc, "fills"), "fill").map((fill) => {
    const pattern = first(fill, "patternFill");
    const bg =
      pattern?.getAttribute("patternType") === "solid"
        ? color(first(pattern, "fgColor"))
        : undefined;
    return bg ? `background:${bg}` : "";
  });
  return all(first(doc, "cellXfs"), "xf").map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    const align = first(xf, "alignment");
    const horizontal = align?.getAttribute("horizontal");
    const css = [
      fonts[Number(xf.getAttribute("fontId") ?? 0)],
      fills[Number(xf.getAttribute("fillId") ?? 0)],
      horizontal && ["left", "center", "right"].includes(horizontal) && `text-align:${horizontal}`,
      align?.getAttribute("wrapText") === "1" && "white-space:pre-wrap",
    ]
      .filter(Boolean)
      .join(";");
    return { format: formats.get(id) ?? builtInFormats[id] ?? "General", css };
  });
}
