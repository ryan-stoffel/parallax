import { readXml, unzip, type Parts } from "./ooxml";

/**
 * A .xlsx as the side panel shows it (PLX-755), view-only: each sheet's cells with their values
 * as their number formats show them, their fonts and fills, column widths, row heights, and merges.
 */
export interface Xlsx {
  sheets: Sheet[];
  shared: string[];
  styles: CellStyle[];
}

export interface Sheet {
  name: string;
  cells: Map<string, Element>;
  /** Column widths in pixels, by zero-based column, where the sheet sets them. */
  widths: Map<number, number>;
  /** Row heights in pixels, by one-based row, where the sheet sets them. */
  heights: Map<number, number>;
  /** Merged ranges by their top-left cell, and the cells they cover. */
  merges: Map<string, { rows: number; cols: number }>;
  covered: Set<string>;
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
      cells,
      widths,
      heights,
      merges,
      covered,
    });
  }
  if (!sheets.length) throw new Error("This workbook has no sheets.");
  return { sheets, shared, styles: stylesOf(parts) };
}

/** What a cell shows, its look, and whether it's a number, which aligns right. */
export function cellAt(x: Xlsx, sheet: Sheet, ref: string) {
  const c = sheet.cells.get(ref);
  if (!c) return { text: "", css: "", number: false };
  const type = c.getAttribute("t");
  const v = childOf(c, "v")?.textContent ?? "";
  const formula = childOf(c, "f")?.textContent;
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
  else if (v === "" && formula) text = `=${formula}`;
  else if (type === "str" || type === "e" || v === "") text = v;
  else {
    text = formatNumber(Number(v), style?.format ?? "General");
    number = true;
  }
  return { text, css: style?.css ?? "", number };
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
