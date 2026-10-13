import { Mark, Schema, type Node as PMNode, type NodeSpec } from "@tiptap/pm/model";
import { TableMap, tableNodes } from "@tiptap/pm/tables";

import {
  find,
  imageUrl,
  kid,
  kids,
  readXml,
  rels,
  twipsToPx,
  unzip,
  val,
  writeXml,
  zip,
  type Parts,
} from "./ooxml";

/**
 * A .docx as the side panel edits it (PLX-755, PLX-758). `word/document.xml`'s body becomes a
 * ProseMirror document. Each `w:p` is a paragraph whose style, alignment, indent, spacing, and
 * list numbering are attributes, with the rest of its `w:pPr` kept. Its runs are text marked with
 * font, size, color, highlight, bold, italic, underline, strike, and super- or subscript, with the
 * rest of each `w:rPr` kept, and `w:hyperlink`s are a link mark over their runs. A `w:tbl` is an
 * editable table. Anything else (drawings, fields, bookmarks, content controls, tables plxd can't
 * map) is an atom holding its original XML. Saving writes a paragraph or table the user didn't
 * touch back as its original element, rebuilds only the rest in Word's element order, and writes
 * every other part of the package back as it was, plus any list numbering or link the user added.
 */
export interface Docx {
  parts: Parts;
  xml: Document;
  body: Element;
  /** The body's closing section properties: page size and margins, headers and footers. */
  sectPr?: Element;
  /** Elements the document's nodes name by index: kept `w:pPr`s and `w:rPr`s, atoms' XML. */
  els: Element[];
  /** Each unchanged paragraph's or table's original element, by its node's JSON. */
  originals: Map<string, Element>;
  schema: DocxSchema;
  doc: PMNode;
  /** The page in CSS pixels. */
  page: { width: number; height: number; top: number; right: number; bottom: number; left: number };
  /** The page's text width in twips, which a new table spans. */
  textWidth: number;
  /** The stylesheet for numbered and bulleted paragraphs, scoped to `scope`, as numbering is now. */
  css: () => string;
  /** A class unique to this document, on the element its pages render in. */
  scope: string;
  /** The page's base look: the default paragraph style's font, size, and color. */
  base: string;
  /** Paragraph styles to offer, by id, with their names. */
  styles: { id: string; name: string }[];
  /** Fonts to offer: the document's own, then common ones. */
  fonts: string[];
  /** `word/numbering.xml`, made when the user starts a list in a document without one. */
  numbering?: Document;
  /** `word/document.xml`'s relationships, which links the user adds join. */
  rels?: Document;
  /** Parts the user's lists or links changed, written back on save. */
  changed: Set<"numbering" | "rels" | "types">;
  /** Each paragraph's text when opened, for the change summary. */
  texts: string[];
}

type NodeName =
  | "doc"
  | "paragraph"
  | "opaqueBlock"
  | "table"
  | "table_row"
  | "table_cell"
  | "table_header"
  | "text"
  | "hardBreak"
  | "opaque";
type MarkName =
  | "run"
  | "link"
  | "font"
  | "bold"
  | "italic"
  | "strike"
  | "color"
  | "size"
  | "highlight"
  | "underline"
  | "vertAlign";

/** The editor's schema, with its node and mark names typed. */
export type DocxSchema = Schema<NodeName, MarkName>;

/** A paragraph's numbering: its list and level. */
export interface Num {
  numId: string;
  ilvl: string;
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const order = (names: string) => names.split(" ").map((name) => `w:${name}`);
// The child orders Word checks: rebuilt elements go in their places.
const RPR_ORDER = order(
  "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath",
);
const PPR_ORDER = order(
  "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange",
);
const TCPR_ORDER = order(
  "cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign hideMark headers cellIns cellDel cellMerge tcPrChange",
);

/** Word's highlight colors, by name, as CSS. */
export const HIGHLIGHTS: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
};

const COMMON_FONTS = [
  "Aptos",
  "Arial",
  "Calibri",
  "Cambria",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Times New Roman",
  "Verdana",
];

/** Whether a toggle such as `<w:b/>` is on: present, without a false `w:val`. */
const on = (el: Element | undefined) =>
  !!el && !["0", "false", "off"].includes(el.getAttribute("w:val") ?? "true");

/** An element's attributes, by qualified name. */
const attrsOf = (el: Element | undefined) =>
  el ? Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])) : null;

/** `child` put into `parent` in `order`'s place. */
function insertOrdered(parent: Element, child: Element, names: string[]) {
  const at = names.indexOf(child.nodeName);
  parent.insertBefore(child, kids(parent).find((c) => names.indexOf(c.nodeName) > at) ?? null);
}

let scopes = 0;

/** Opens a .docx's bytes. Throws when it has no readable `word/document.xml`. */
export function openDocx(bytes: Uint8Array): Docx {
  const parts = unzip(bytes);
  const xml = readXml(parts, "word/document.xml");
  const body = xml && find(xml, "w:body");
  if (!xml || !body) throw new Error("This file has no Word document in it.");
  const els: Element[] = [];
  const reg = (el: Element) => els.push(el) - 1;
  const sectPr = kids(body, "w:sectPr").at(-1);
  const docx = {
    parts,
    xml,
    body,
    sectPr,
    els,
    originals: new Map(),
    page: pageOf(sectPr),
    textWidth: textWidthOf(sectPr),
    scope: `docx-${++scopes}`,
    numbering: readXml(parts, "word/numbering.xml"),
    rels: readXml(parts, "word/_rels/document.xml.rels"),
    changed: new Set(),
    texts: [],
  } as unknown as Docx;
  const look = lookOf(docx);
  docx.base = look.base;
  docx.styles = look.paragraphStyles;
  docx.fonts = look.fonts;
  docx.css = () => look.numberingCss(docx.scope);
  docx.schema = schemaFor(docx, look);
  const { schema } = docx;

  const marksOf = (rPr: Element | undefined, link: Mark | undefined): Mark[] => {
    const kept = rPr ? (rPr.cloneNode(true) as Element) : undefined;
    const marks: Mark[] = [];
    if (link) marks.push(link);
    const take = (name: string) => {
      const found = kid(kept, name);
      found?.remove();
      return found;
    };
    const rFonts = kid(kept, "w:rFonts");
    const ascii = rFonts?.getAttribute("w:ascii");
    // A theme font stays kept, since naming it would stop it following the theme.
    if (ascii && ![...rFonts!.attributes].some((a) => a.name.endsWith("Theme"))) {
      take("w:rFonts");
      marks.push(schema.marks.font.create({ name: ascii }));
    }
    const b = take("w:b");
    take("w:bCs");
    if (on(b)) marks.push(schema.marks.bold.create());
    const i = take("w:i");
    take("w:iCs");
    if (on(i)) marks.push(schema.marks.italic.create());
    if (on(take("w:strike"))) marks.push(schema.marks.strike.create());
    const color = kid(kept, "w:color");
    const colorVal = color?.getAttribute("w:val");
    if (colorVal && colorVal !== "auto" && !color!.hasAttribute("w:themeColor")) {
      take("w:color");
      marks.push(schema.marks.color.create({ val: colorVal }));
    }
    const sz = take("w:sz")?.getAttribute("w:val");
    take("w:szCs");
    if (sz) marks.push(schema.marks.size.create({ half: sz }));
    const highlight = take("w:highlight")?.getAttribute("w:val");
    if (highlight && highlight !== "none")
      marks.push(schema.marks.highlight.create({ val: highlight }));
    const u = take("w:u")?.getAttribute("w:val");
    if (u && u !== "none") marks.push(schema.marks.underline.create({ val: u }));
    const vertAlign = take("w:vertAlign")?.getAttribute("w:val");
    if (vertAlign === "superscript" || vertAlign === "subscript")
      marks.push(schema.marks.vertAlign.create({ val: vertAlign }));
    return [schema.marks.run.create({ rPr: kept ? reg(kept) : null }), ...marks];
  };

  const runNodes = (r: Element, into: PMNode[], link?: Mark) => {
    const rPr = kid(r, "w:rPr");
    const marks = marksOf(rPr, link);
    let text = "";
    const flush = () => {
      if (text) into.push(schema.text(text, marks));
      text = "";
    };
    for (const c of kids(r)) {
      const type = c.getAttribute("w:type");
      if (c.nodeName === "w:rPr" || c.nodeName === "w:lastRenderedPageBreak") continue;
      else if (c.nodeName === "w:t") text += c.textContent ?? "";
      else if (c.nodeName === "w:tab") text += "\t";
      else if (c.nodeName === "w:br" && (!type || type === "textWrapping")) {
        flush();
        into.push(schema.nodes.hardBreak.create(null, null, marks));
      } else {
        // A drawing, a field's code, a page break: a run of its own, as it was.
        flush();
        const piece = r.cloneNode(false) as Element;
        if (rPr) piece.append(rPr.cloneNode(true));
        piece.append(c.cloneNode(true));
        into.push(schema.nodes.opaque.create({ id: reg(piece) }));
      }
    }
    flush();
  };

  const paragraph = (p: Element): PMNode => {
    const pPr = kid(p, "w:pPr");
    const kept = pPr ? (pPr.cloneNode(true) as Element) : undefined;
    const take = (name: string) => {
      const found = kid(kept, name);
      found?.remove();
      return found;
    };
    const style = take("w:pStyle")?.getAttribute("w:val") ?? null;
    const numPr = take("w:numPr");
    const numId = val(numPr, "w:numId");
    const attrs = {
      style,
      align: take("w:jc")?.getAttribute("w:val") ?? null,
      ind: attrsOf(take("w:ind")),
      spacing: attrsOf(take("w:spacing")),
      // A numPr of only a level, or a style's own, stays kept.
      num: numId ? { numId, ilvl: val(numPr, "w:ilvl") ?? "0" } : null,
      pPr: null as number | null,
    };
    if (numPr && !numId) kept!.append(numPr);
    if (kept && (kept.children.length || kept.attributes.length)) attrs.pPr = reg(kept);
    const inline: PMNode[] = [];
    for (const c of kids(p)) {
      if (c.nodeName === "w:pPr" || c.nodeName === "w:proofErr") continue;
      if (c.nodeName === "w:r") runNodes(c, inline);
      else if (
        c.nodeName === "w:hyperlink" &&
        kids(c).every((r) => r.nodeName === "w:r" || r.nodeName === "w:proofErr")
      ) {
        const link = schema.marks.link.create({ id: reg(c.cloneNode(false) as Element) });
        for (const r of kids(c, "w:r")) runNodes(r, inline, link);
      } else inline.push(schema.nodes.opaque.create({ id: reg(c) }));
    }
    const node = schema.nodes.paragraph.create(attrs, inline);
    docx.originals.set(JSON.stringify(node.toJSON()), p);
    return node;
  };

  /** A table as an editable node, or undefined for one this editor can't map losslessly. */
  const table = (tbl: Element): PMNode | undefined => {
    const rows = kids(tbl, "w:tr");
    if (
      !rows.length ||
      kids(tbl).some((c) => !["w:tblPr", "w:tblGrid", "w:tr"].includes(c.nodeName))
    )
      return undefined;
    // Each row's cells by grid column, with vertical merges' continuations.
    const grid = rows.map((tr) => {
      if (kids(tr).some((c) => !["w:trPr", "w:tc", "w:tblPrEx"].includes(c.nodeName)))
        return undefined;
      const trPr = kid(tr, "w:trPr");
      if (kid(trPr, "w:gridBefore") || kid(trPr, "w:gridAfter")) return undefined;
      let col = 0;
      return kids(tr, "w:tc").map((tc) => {
        const tcPr = kid(tc, "w:tcPr");
        const span = Number(val(tcPr, "w:gridSpan") ?? 1) || 1;
        const vMerge = kid(tcPr, "w:vMerge");
        const merge = vMerge
          ? vMerge.getAttribute("w:val") === "restart"
            ? "restart"
            : "continue"
          : undefined;
        const cell = { tc, col, span, merge };
        col += span;
        return cell;
      });
    });
    if (grid.some((row) => !row)) return undefined;
    const rowNodes: PMNode[] = [];
    for (let r = 0; r < rows.length; r++) {
      const cells: PMNode[] = [];
      for (const cell of grid[r]!) {
        if (cell.merge === "continue") {
          // A continuation's own content would be lost; keep such a table as it is.
          if (wordText(cell.tc).trim()) return undefined;
          continue;
        }
        let rowspan = 1;
        if (cell.merge === "restart")
          while (grid[r + rowspan]?.some((c) => c.col === cell.col && c.merge === "continue"))
            rowspan++;
        const tcPr = kid(cell.tc, "w:tcPr");
        const kept = tcPr ? (tcPr.cloneNode(true) as Element) : undefined;
        kid(kept, "w:gridSpan")?.remove();
        kid(kept, "w:vMerge")?.remove();
        const content = blocks(cell.tc);
        if (!content.length || content.at(-1)!.type !== schema.nodes.paragraph)
          content.push(schema.nodes.paragraph.create());
        cells.push(
          schema.nodes.table_cell.create(
            { colspan: cell.span, rowspan, tcPr: kept ? reg(kept) : null },
            content,
          ),
        );
      }
      const trPr = kid(rows[r], "w:trPr");
      rowNodes.push(schema.nodes.table_row.create({ trPr: trPr ? reg(trPr) : null }, cells));
    }
    const tblPr = kid(tbl, "w:tblPr");
    const widths = kids(kid(tbl, "w:tblGrid"), "w:gridCol").map(
      (c) => Number(c.getAttribute("w:w")) || 0,
    );
    const node = schema.nodes.table.create(
      { tblPr: tblPr ? reg(tblPr) : null, grid: widths },
      rowNodes,
    );
    // A table whose cells don't fill its grid would be changed by the editor's fixing.
    if (TableMap.get(node).problems) return undefined;
    docx.originals.set(JSON.stringify(node.toJSON()), tbl);
    return node;
  };

  const blocks = (parent: Element): PMNode[] =>
    kids(parent)
      .filter((el) => el !== sectPr && el.nodeName !== "w:tcPr")
      .map(
        (el) =>
          (el.nodeName === "w:p"
            ? paragraph(el)
            : el.nodeName === "w:tbl"
              ? table(el)
              : undefined) ?? schema.nodes.opaqueBlock.create({ id: reg(el) }),
      );

  const top = blocks(body);
  if (!top.length) top.push(schema.nodes.paragraph.create());
  docx.doc = schema.nodes.doc.create(null, top);
  docx.texts = paragraphTexts(docx, docx.doc);
  return docx;
}

/** A `w:` element in the document, with `w:` attributes. */
function element(docx: Docx, name: string, attrs: Record<string, string> = {}) {
  const made = docx.xml.createElementNS(W, name);
  for (const [key, value] of Object.entries(attrs)) made.setAttributeNS(W, key, value);
  return made;
}

/** A paragraph's whole `w:pPr`: its kept properties with its attributes put back in order. */
export function pPrOf(docx: Docx, node: PMNode): Element | undefined {
  const { attrs } = node;
  const id = attrs["pPr"] as number | null;
  const pPr = id == null ? element(docx, "w:pPr") : (docx.els[id]!.cloneNode(true) as Element);
  const put = (name: string, values: Record<string, string> | null) => {
    if (values) insertOrdered(pPr, element(docx, name, values), PPR_ORDER);
  };
  const style = attrs["style"] as string | null;
  if (style) put("w:pStyle", { "w:val": style });
  const num = attrs["num"] as Num | null;
  if (num) {
    const numPr = element(docx, "w:numPr");
    numPr.append(
      element(docx, "w:ilvl", { "w:val": num.ilvl }),
      element(docx, "w:numId", { "w:val": num.numId }),
    );
    kid(pPr, "w:numPr")?.remove();
    insertOrdered(pPr, numPr, PPR_ORDER);
  }
  put("w:spacing", attrs["spacing"] as Record<string, string> | null);
  put("w:ind", attrs["ind"] as Record<string, string> | null);
  const align = attrs["align"] as string | null;
  if (align) put("w:jc", { "w:val": align });
  return pPr.children.length || pPr.attributes.length ? pPr : undefined;
}

/** A run's whole `w:rPr`: its kept properties with its marks put back in order. */
export function rPrOf(docx: Docx, marks: readonly Mark[]): Element | undefined {
  const { schema, els } = docx;
  const id = marks.find((m) => m.type === schema.marks.run)?.attrs["rPr"] as
    | number
    | null
    | undefined;
  const rPr = id == null ? element(docx, "w:rPr") : (els[id]!.cloneNode(true) as Element);
  const put = (names: string[], attrs: Record<string, string> = {}) => {
    for (const name of names) {
      kid(rPr, name)?.remove();
      insertOrdered(rPr, element(docx, name, attrs), RPR_ORDER);
    }
  };
  for (const mark of marks) {
    const a = mark.attrs;
    switch (mark.type.name as MarkName) {
      case "font": {
        const name = a["name"] as string;
        put(["w:rFonts"], { "w:ascii": name, "w:hAnsi": name, "w:cs": name, "w:eastAsia": name });
        break;
      }
      case "bold":
        put(["w:b", "w:bCs"]);
        break;
      case "italic":
        put(["w:i", "w:iCs"]);
        break;
      case "strike":
        put(["w:strike"]);
        break;
      case "color":
        put(["w:color"], { "w:val": a["val"] as string });
        break;
      case "size":
        put(["w:sz", "w:szCs"], { "w:val": a["half"] as string });
        break;
      case "highlight":
        put(["w:highlight"], { "w:val": a["val"] as string });
        break;
      case "underline":
        put(["w:u"], { "w:val": a["val"] as string });
        break;
      case "vertAlign":
        put(["w:vertAlign"], { "w:val": a["val"] as string });
        break;
      default:
    }
  }
  return rPr.children.length || rPr.attributes.length ? rPr : undefined;
}

/** The .docx with `doc`'s content: unchanged paragraphs and tables as they were, the rest rebuilt. */
export function saveDocx(docx: Docx, doc: PMNode): Uint8Array {
  const { els, schema } = docx;
  const el = (name: string, attrs?: Record<string, string>) => element(docx, name, attrs);
  const textInto = (run: Element, text: string) =>
    text.split("\t").forEach((piece, i) => {
      if (i) run.append(el("w:tab"));
      if (!piece) return;
      const t = el("w:t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.textContent = piece;
      run.append(t);
    });

  const paragraph = (block: PMNode) => {
    const p = el("w:p");
    const pPr = pPrOf(docx, block);
    if (pPr) p.append(pPr);
    // Runs go into the paragraph, or into the hyperlink their link mark names.
    let container: Element = p;
    let link: number | undefined;
    let run: Element | undefined;
    let runMarks: readonly Mark[] = [];
    block.forEach((node) => {
      const linked = node.marks.find((m) => m.type === schema.marks.link)?.attrs["id"] as
        | number
        | undefined;
      if (linked !== link) {
        link = linked;
        container = p;
        if (linked !== undefined) {
          container = els[linked]!.cloneNode(false) as Element;
          p.append(container);
        }
        run = undefined;
      }
      if (node.isText) {
        if (!run || !Mark.sameSet(runMarks, node.marks)) {
          run = el("w:r");
          const rPr = rPrOf(docx, node.marks);
          if (rPr) run.append(rPr);
          container.append(run);
          runMarks = node.marks;
        }
        textInto(run, node.text ?? "");
        return;
      }
      run = undefined;
      if (node.type === schema.nodes.hardBreak) {
        const br = el("w:r");
        const rPr = rPrOf(docx, node.marks);
        if (rPr) br.append(rPr);
        br.append(el("w:br"));
        container.append(br);
      } else container.append(els[node.attrs["id"] as number]!.cloneNode(true));
    });
    return p;
  };

  const table = (node: PMNode) => {
    const tbl = el("w:tbl");
    const tblPrId = node.attrs["tblPr"] as number | null;
    if (tblPrId != null) tbl.append(els[tblPrId]!.cloneNode(true));
    const map = TableMap.get(node);
    // The grid: the table's widths, with an added column as wide as the average.
    const widths = (node.attrs["grid"] as number[] | null) ?? [];
    const average = Math.round(
      widths.length
        ? widths.reduce((a, b) => a + b, 0) / widths.length
        : docx.textWidth / map.width,
    );
    const tblGrid = el("w:tblGrid");
    for (let c = 0; c < map.width; c++)
      tblGrid.append(el("w:gridCol", { "w:w": String(widths[c] ?? average) }));
    tbl.append(tblGrid);
    const cellPr = (cell: PMNode, merge?: "restart" | "continue") => {
      const id = cell.attrs["tcPr"] as number | null;
      const tcPr = id == null ? el("w:tcPr") : (els[id]!.cloneNode(true) as Element);
      const span = cell.attrs["colspan"] as number;
      if (span > 1) insertOrdered(tcPr, el("w:gridSpan", { "w:val": String(span) }), TCPR_ORDER);
      if (merge)
        insertOrdered(
          tcPr,
          el("w:vMerge", merge === "restart" ? { "w:val": "restart" } : {}),
          TCPR_ORDER,
        );
      return tcPr.children.length || tcPr.attributes.length ? tcPr : undefined;
    };
    node.forEach((row, _, r) => {
      void _;
      const tr = el("w:tr");
      const trPrId = row.attrs["trPr"] as number | null;
      if (trPrId != null) tr.append(els[trPrId]!.cloneNode(true));
      for (let c = 0; c < map.width; c++) {
        const pos = map.map[r * map.width + c]!;
        const rect = map.findCell(pos);
        if (rect.left !== c) continue;
        const cell = node.nodeAt(pos)!;
        const tc = el("w:tc");
        const merged = (cell.attrs["rowspan"] as number) > 1;
        if (rect.top === r) {
          const tcPr = cellPr(cell, merged ? "restart" : undefined);
          if (tcPr) tc.append(tcPr);
          cell.forEach((block) => tc.append(...blocks(block)));
          // A cell ends with a paragraph.
          if (tc.lastElementChild?.nodeName !== "w:p") tc.append(el("w:p"));
        } else {
          const tcPr = cellPr(cell, "continue");
          if (tcPr) tc.append(tcPr);
          tc.append(el("w:p"));
        }
        tr.append(tc);
      }
      tbl.append(tr);
    });
    return tbl;
  };

  const blocks = (block: PMNode): Node[] => {
    if (block.type === schema.nodes.opaqueBlock)
      return [els[block.attrs["id"] as number]!.cloneNode(true)];
    const original = docx.originals.get(JSON.stringify(block.toJSON()));
    if (original) return [original.cloneNode(true)];
    return [block.type === schema.nodes.table ? table(block) : paragraph(block)];
  };

  const out: Node[] = [];
  doc.forEach((block) => out.push(...blocks(block)));
  if (docx.sectPr) out.push(docx.sectPr.cloneNode(true));
  docx.body.replaceChildren(...out);
  const parts: Parts = { ...docx.parts, "word/document.xml": writeXml(docx.xml) };
  if (docx.changed.has("numbering") && docx.numbering)
    parts["word/numbering.xml"] = writeXml(docx.numbering);
  if (docx.changed.has("rels") && docx.rels)
    parts["word/_rels/document.xml.rels"] = writeXml(docx.rels);
  if (docx.changed.has("types")) {
    const types = readXml(parts, "[Content_Types].xml");
    if (
      types &&
      ![...types.getElementsByTagName("Override")].some(
        (o) => o.getAttribute("PartName") === "/word/numbering.xml",
      )
    ) {
      const override = types.createElementNS(types.documentElement.namespaceURI, "Override");
      override.setAttribute("PartName", "/word/numbering.xml");
      override.setAttribute(
        "ContentType",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
      );
      types.documentElement.append(override);
      parts["[Content_Types].xml"] = writeXml(types);
    }
  }
  return zip(parts);
}

/** The relationships part, made if the document has none, and a new `rId` in it. */
function relationship(docx: Docx, type: string, target: string, external: boolean): string {
  if (!docx.rels) {
    docx.rels = new DOMParser().parseFromString(
      `<Relationships xmlns="${REL}"/>`,
      "application/xml",
    );
  }
  const taken = new Set(
    [...docx.rels.getElementsByTagName("Relationship")].map((r) => r.getAttribute("Id")),
  );
  let n = taken.size + 1;
  while (taken.has(`rId${n}`)) n++;
  const rel = docx.rels.createElementNS(REL, "Relationship");
  rel.setAttribute("Id", `rId${n}`);
  rel.setAttribute(
    "Type",
    `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`,
  );
  rel.setAttribute("Target", target);
  if (external) rel.setAttribute("TargetMode", "External");
  docx.rels.documentElement.append(rel);
  docx.changed.add("rels");
  return `rId${n}`;
}

/** A new hyperlink to `url`, as the element id a link mark names. */
export function newLink(docx: Docx, url: string): number {
  const link = element(docx, "w:hyperlink");
  link.setAttributeNS(R, "r:id", relationship(docx, "hyperlink", url, true));
  return docx.els.push(link) - 1;
}

/** Where a link mark points, for its tooltip and the link box. */
export function linkTarget(docx: Docx, id: number): string | undefined {
  const link = docx.els[id];
  const rid = link?.getAttributeNS(R, "id");
  const anchor = link?.getAttribute("w:anchor");
  if (anchor) return `#${anchor}`;
  return (
    [...(docx.rels?.getElementsByTagName("Relationship") ?? [])]
      .find((r) => r.getAttribute("Id") === rid)
      ?.getAttribute("Target") ?? undefined
  );
}

/**
 * A list's numbering id: the document's first list whose top level is bullets (or numbers), or a
 * new one, with `numbering.xml` made if the document has none.
 */
export function listNumId(docx: Docx, kind: "bullet" | "number"): string {
  if (!docx.numbering) {
    docx.numbering = new DOMParser().parseFromString(
      `<w:numbering xmlns:w="${W}"/>`,
      "application/xml",
    );
    relationship(docx, "numbering", "numbering.xml", false);
    docx.changed.add("types");
  }
  const numbering = docx.numbering;
  const abstracts = new Map(
    [...numbering.getElementsByTagName("w:abstractNum")].map((a) => [
      a.getAttribute("w:abstractNumId"),
      a,
    ]),
  );
  const nums = [...numbering.getElementsByTagName("w:num")];
  for (const num of nums) {
    const abstract = abstracts.get(val(num, "w:abstractNumId") ?? null);
    const format = val(kids(abstract, "w:lvl")[0], "w:numFmt");
    if ((format === "bullet") === (kind === "bullet") && format)
      return num.getAttribute("w:numId")!;
  }
  const make = (name: string, attrs: Record<string, string> = {}) => {
    const made = numbering.createElementNS(W, name);
    for (const [key, value] of Object.entries(attrs)) made.setAttributeNS(W, key, value);
    return made;
  };
  const next = (values: (string | null)[]) =>
    String(Math.max(0, ...values.map(Number).filter(Number.isFinite)) + 1);
  const abstractId = next([...abstracts.keys()]);
  const abstract = make("w:abstractNum", { "w:abstractNumId": abstractId });
  abstract.append(make("w:multiLevelType", { "w:val": "hybridMultilevel" }));
  const bullets = ["•", "o", "▪"];
  const formats = ["decimal", "lowerLetter", "lowerRoman"];
  for (let level = 0; level < 9; level++) {
    const lvl = make("w:lvl", { "w:ilvl": String(level) });
    lvl.append(
      make("w:start", { "w:val": "1" }),
      make("w:numFmt", { "w:val": kind === "bullet" ? "bullet" : formats[level % 3]! }),
      make("w:lvlText", {
        "w:val": kind === "bullet" ? bullets[level % 3]! : `%${level + 1}.`,
      }),
      make("w:lvlJc", { "w:val": "left" }),
    );
    const pPr = make("w:pPr");
    pPr.append(make("w:ind", { "w:left": String(720 * (level + 1)), "w:hanging": "360" }));
    lvl.append(pPr);
    abstract.append(lvl);
  }
  // Every abstractNum comes before the first num.
  numbering.documentElement.insertBefore(abstract, nums[0] ?? null);
  const numId = next(nums.map((n) => n.getAttribute("w:numId")));
  const num = make("w:num", { "w:numId": numId });
  num.append(make("w:abstractNumId", { "w:val": abstractId }));
  numbering.documentElement.append(num);
  docx.changed.add("numbering");
  return numId;
}

/** Whether `numId`'s top level is bullets. */
export function isBulleted(docx: Docx, numId: string): boolean {
  const num = [...(docx.numbering?.getElementsByTagName("w:num") ?? [])].find(
    (n) => n.getAttribute("w:numId") === numId,
  );
  const abstractId = val(num, "w:abstractNumId");
  const abstract = [...(docx.numbering?.getElementsByTagName("w:abstractNum") ?? [])].find(
    (a) => a.getAttribute("w:abstractNumId") === abstractId,
  );
  return val(kids(abstract, "w:lvl")[0], "w:numFmt") === "bullet";
}

/** A new table of `rows` by `cols` empty cells across the page, bordered as Word's grid. */
export function newTable(docx: Docx, rows: number, cols: number): PMNode {
  const { schema } = docx;
  const tblPr = element(docx, "w:tblPr");
  if (
    docx.styles.some((s) => s.id === "TableGrid") ||
    readXml(docx.parts, "word/styles.xml")?.querySelector('[*|styleId="TableGrid"]')
  )
    tblPr.append(element(docx, "w:tblStyle", { "w:val": "TableGrid" }));
  tblPr.append(element(docx, "w:tblW", { "w:w": "0", "w:type": "auto" }));
  if (!kid(tblPr, "w:tblStyle")) {
    const borders = element(docx, "w:tblBorders");
    for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"])
      borders.append(
        element(docx, `w:${side}`, {
          "w:val": "single",
          "w:sz": "4",
          "w:space": "0",
          "w:color": "auto",
        }),
      );
    tblPr.append(borders);
  }
  const width = Math.floor(docx.textWidth / cols);
  const cell = () =>
    schema.nodes.table_cell.create({ tcPr: null }, schema.nodes.paragraph.create());
  return schema.nodes.table.create(
    { tblPr: docx.els.push(tblPr) - 1, grid: Array.from({ length: cols }, () => width) },
    Array.from({ length: rows }, () =>
      schema.nodes.table_row.create(null, Array.from({ length: cols }, cell)),
    ),
  );
}

/** A page break, as the inline atom that holds its run. */
export function pageBreak(docx: Docx): PMNode {
  const run = element(docx, "w:r");
  run.append(element(docx, "w:br", { "w:type": "page" }));
  return docx.schema.nodes.opaque.create({ id: docx.els.push(run) - 1 });
}

/** Each paragraph's text, tables' cells included, with atoms' text and line breaks. */
export function paragraphTexts(docx: Docx, doc: PMNode): string[] {
  const texts: string[] = [];
  doc.descendants((node) => {
    if (node.type === docx.schema.nodes.opaqueBlock) {
      for (const p of docx.els[node.attrs["id"] as number]!.getElementsByTagName("w:p"))
        texts.push(wordText(p));
      return false;
    }
    if (node.type !== docx.schema.nodes.paragraph) return true;
    let text = "";
    node.forEach((child) => {
      if (child.isText) text += child.text;
      else if (child.type === docx.schema.nodes.hardBreak) text += "\n";
      else text += wordText(docx.els[child.attrs["id"] as number]!);
    });
    texts.push(text);
    return false;
  });
  return texts;
}

/** The text of an element's `w:t`s. */
const wordText = (el: Element) =>
  [...el.getElementsByTagName("w:t")].map((t) => t.textContent ?? "").join("");

/**
 * What changed between two lists of paragraphs or lines, for the agent: an LCS alignment, with
 * removed and added lines that meet paired as changes. At most `max` lines.
 */
export function changeSummary(before: string[], after: string[], max = 12): string[] {
  const clip = (text: string) =>
    JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text);
  // ponytail: O(n·m) table; documents of a few thousand paragraphs are well inside it.
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: string[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++)
      lines.push(`Changed ${clip(removed[k]!)} to ${clip(added[k]!)}`);
    for (const text of removed.slice(pairs)) if (text.trim()) lines.push(`Removed ${clip(text)}`);
    for (const text of added.slice(pairs)) if (text.trim()) lines.push(`Added ${clip(text)}`);
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) added.push(after[j++]!);
    else removed.push(before[i++]!);
  }
  flush();
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines;
}

/** Whether Enter at the end of a paragraph in `style` starts a plain one, as Word does. */
export const endsStyle = (style: unknown) =>
  typeof style === "string" && /^(heading|title|subtitle)/i.test(style);

function schemaFor(docx: Docx, look: Look): DocxSchema {
  const tables = tableNodes({
    tableGroup: "block",
    cellContent: "block+",
    cellAttributes: {
      tcPr: {
        default: null,
        setDOMAttr: (value, attrs) => {
          attrs["style"] = look.cell(value == null ? undefined : docx.els[value as number]);
        },
      },
    },
  });
  const span = (style: string): ["span", { style: string }, 0] => ["span", { style }, 0];
  return new Schema<NodeName, MarkName>({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        group: "block",
        content: "inline*",
        attrs: {
          style: { default: null },
          align: { default: null },
          ind: { default: null },
          spacing: { default: null },
          num: { default: null },
          pPr: { default: null },
        },
        parseDOM: [{ tag: "p" }, { tag: "h1" }, { tag: "h2" }, { tag: "h3" }, { tag: "li" }],
        toDOM: (node) => {
          const { css, cls } = look.paragraph(
            node.attrs["style"] as string | null,
            pPrOf(docx, node),
          );
          return ["p", { style: css, class: cls }, 0];
        },
      },
      opaqueBlock: {
        group: "block",
        atom: true,
        selectable: true,
        attrs: { id: {} },
        toDOM: (node) => look.block(docx.els[node.attrs["id"] as number]!),
      },
      table: {
        ...tables.table,
        attrs: { tblPr: { default: null }, grid: { default: null } },
        toDOM: (node) => [
          "table",
          {
            style: look.table(
              node.attrs["tblPr"] == null ? undefined : docx.els[node.attrs["tblPr"] as number],
            ),
          },
          ["tbody", 0],
        ],
      } as NodeSpec,
      table_row: { ...tables.table_row, attrs: { trPr: { default: null } } } as NodeSpec,
      table_cell: tables.table_cell,
      table_header: tables.table_header,
      text: { group: "inline" },
      hardBreak: {
        inline: true,
        group: "inline",
        selectable: false,
        parseDOM: [{ tag: "br" }],
        toDOM: () => ["br"],
      },
      opaque: {
        inline: true,
        group: "inline",
        atom: true,
        attrs: { id: {} },
        toDOM: (node) => look.inline(docx.els[node.attrs["id"] as number]!),
      },
    },
    // Outer to inner: a run's kept look, then each mark's own, which overrides it.
    marks: {
      run: {
        attrs: { rPr: { default: null } },
        toDOM: (mark) =>
          span(
            look.run(mark.attrs["rPr"] == null ? undefined : docx.els[mark.attrs["rPr"] as number]),
          ),
      },
      link: {
        attrs: { id: {} },
        inclusive: false,
        toDOM: (mark) => [
          "span",
          {
            style: "color:#0563c1;text-decoration:underline",
            title: linkTarget(docx, mark.attrs["id"] as number) ?? "",
          },
          0,
        ],
      },
      font: {
        attrs: { name: {} },
        toDOM: (mark) =>
          span(`font-family:"${mark.attrs["name"] as string}",Carlito,Arial,sans-serif`),
      },
      bold: {
        parseDOM: [{ tag: "strong" }, { tag: "b" }],
        toDOM: () => ["strong", { style: "font-weight:700" }, 0],
      },
      italic: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
      strike: { parseDOM: [{ tag: "s" }], toDOM: () => ["s", 0] },
      color: { attrs: { val: {} }, toDOM: (mark) => span(`color:#${mark.attrs["val"] as string}`) },
      size: {
        attrs: { half: {} },
        toDOM: (mark) => span(`font-size:${Number(mark.attrs["half"]) / 2}pt`),
      },
      highlight: {
        attrs: { val: {} },
        toDOM: (mark) =>
          span(`background-color:${HIGHLIGHTS[mark.attrs["val"] as string] ?? "transparent"}`),
      },
      underline: {
        attrs: { val: { default: "single" } },
        parseDOM: [{ tag: "u" }],
        toDOM: () => ["u", 0],
      },
      vertAlign: {
        attrs: { val: {} },
        excludes: "vertAlign",
        toDOM: (mark) => [mark.attrs["val"] === "superscript" ? "sup" : "sub", 0],
      },
    },
  });
}

function pageOf(sectPr: Element | undefined): Docx["page"] {
  const size = kid(sectPr, "w:pgSz");
  const margin = kid(sectPr, "w:pgMar");
  const twips = (el: Element | undefined, name: string, fallback: number) =>
    twipsToPx(Number(el?.getAttribute(name) ?? fallback) || fallback);
  // Word's defaults: US Letter with one-inch margins.
  return {
    width: twips(size, "w:w", 12240),
    height: twips(size, "w:h", 15840),
    top: twips(margin, "w:top", 1440),
    right: twips(margin, "w:right", 1440),
    bottom: twips(margin, "w:bottom", 1440),
    left: twips(margin, "w:left", 1440),
  };
}

function textWidthOf(sectPr: Element | undefined): number {
  const twips = (el: Element | undefined, name: string, fallback: number) =>
    Number(el?.getAttribute(name) ?? fallback) || fallback;
  const margin = kid(sectPr, "w:pgMar");
  return (
    twips(kid(sectPr, "w:pgSz"), "w:w", 12240) -
    twips(margin, "w:left", 1440) -
    twips(margin, "w:right", 1440)
  );
}

interface Look {
  base: string;
  paragraphStyles: { id: string; name: string }[];
  fonts: string[];
  paragraph: (style: string | null, pPr: Element | undefined) => { css: string; cls: string };
  run: (rPr: Element | undefined) => string;
  table: (tblPr: Element | undefined) => string;
  cell: (tcPr: Element | undefined) => string;
  block: (el: Element) => HTMLElement;
  inline: (el: Element) => HTMLElement;
  numberingCss: (scope: string) => string;
}

type Css = Record<string, string>;
const cssText = (css: Css) =>
  Object.entries(css)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");

/** How the document's styles, theme fonts, numbering, and images look in the page. */
function lookOf(docx: Docx): Look {
  const { parts } = docx;
  const styles = readXml(parts, "word/styles.xml");
  const theme = readXml(parts, "word/theme/theme1.xml");
  const media = rels(parts, "word/document.xml");
  const themeFont = (which: "major" | "minor") =>
    find(find(theme, `a:${which}Font`), "a:latin")?.getAttribute("typeface") ?? undefined;
  const fonts = { major: themeFont("major"), minor: themeFont("minor") };

  const runCss = (rPr: Element | undefined): Css => {
    const css: Css = {};
    if (!rPr) return css;
    const b = kid(rPr, "w:b");
    if (b) css["font-weight"] = on(b) ? "700" : "400";
    const i = kid(rPr, "w:i");
    if (i) css["font-style"] = on(i) ? "italic" : "normal";
    const u = val(rPr, "w:u");
    if (u) css["text-decoration"] = u === "none" ? "none" : "underline";
    if (on(kid(rPr, "w:strike"))) css["text-decoration"] = "line-through";
    const color = val(rPr, "w:color");
    if (color && color !== "auto") css["color"] = `#${color}`;
    const sz = Number(val(rPr, "w:sz"));
    if (sz) css["font-size"] = `${sz / 2}pt`;
    const rFonts = kid(rPr, "w:rFonts");
    const themed = rFonts?.getAttribute("w:asciiTheme");
    const font =
      rFonts?.getAttribute("w:ascii") ??
      (themed ? fonts[themed.startsWith("major") ? "major" : "minor"] : undefined);
    if (font) css["font-family"] = `"${font}", Carlito, Arial, sans-serif`;
    const highlight = val(rPr, "w:highlight");
    if (highlight && highlight !== "none")
      css["background-color"] = HIGHLIGHTS[highlight] ?? highlight;
    if (on(kid(rPr, "w:caps"))) css["text-transform"] = "uppercase";
    if (on(kid(rPr, "w:smallCaps"))) css["font-variant"] = "small-caps";
    const vertAlign = val(rPr, "w:vertAlign");
    if (vertAlign === "superscript" || vertAlign === "subscript") {
      css["vertical-align"] = vertAlign === "superscript" ? "super" : "sub";
      css["font-size"] = "0.75em";
    }
    return css;
  };
  const pt = (twips: string | null | undefined) => `${Number(twips) / 20}pt`;
  const paragraphCss = (pPr: Element | undefined): Css => {
    const css: Css = {};
    if (!pPr) return css;
    const jc = val(pPr, "w:jc");
    if (jc)
      css["text-align"] =
        jc === "center"
          ? "center"
          : jc === "right" || jc === "end"
            ? "right"
            : jc === "both" || jc === "distribute"
              ? "justify"
              : "left";
    const spacing = kid(pPr, "w:spacing");
    if (spacing?.hasAttribute("w:before")) css["margin-top"] = pt(spacing.getAttribute("w:before"));
    if (spacing?.hasAttribute("w:after"))
      css["margin-bottom"] = pt(spacing.getAttribute("w:after"));
    const line = Number(spacing?.getAttribute("w:line"));
    if (line) {
      const rule = spacing?.getAttribute("w:lineRule") ?? "auto";
      css["line-height"] = rule === "auto" ? String((line / 240) * 1.15) : pt(String(line));
    }
    const ind = kid(pPr, "w:ind");
    const left = ind?.getAttribute("w:left") ?? ind?.getAttribute("w:start");
    if (left) css["padding-left"] = pt(left);
    const right = ind?.getAttribute("w:right") ?? ind?.getAttribute("w:end");
    if (right) css["padding-right"] = pt(right);
    if (ind?.hasAttribute("w:firstLine")) css["text-indent"] = pt(ind.getAttribute("w:firstLine"));
    if (ind?.hasAttribute("w:hanging"))
      css["text-indent"] = `-${pt(ind.getAttribute("w:hanging"))}`;
    const fill = kid(pPr, "w:shd")?.getAttribute("w:fill");
    if (fill && fill !== "auto") css["background-color"] = `#${fill}`;
    const border = kid(kid(pPr, "w:pBdr"), "w:bottom");
    if (border && border.getAttribute("w:val") !== "none") {
      const color = border.getAttribute("w:color");
      css["border-bottom"] =
        `${Number(border.getAttribute("w:sz") ?? 4) / 8}pt solid ${color && color !== "auto" ? `#${color}` : "currentColor"}`;
      css["padding-bottom"] = pt(String(Number(border.getAttribute("w:space") ?? 1) * 20));
    }
    return css;
  };

  // Each style's look, merged down its basedOn chain.
  const byId = new Map(
    [...(styles?.getElementsByTagName("w:style") ?? [])].map((s) => [
      s.getAttribute("w:styleId") ?? "",
      s,
    ]),
  );
  const chain = (id: string | null | undefined, seen = new Set<string>()): Element[] => {
    const style = id ? byId.get(id) : undefined;
    if (!style || seen.has(id!)) return [];
    seen.add(id!);
    return [...chain(val(style, "w:basedOn"), seen), style];
  };
  const defaultParagraph = [...byId.values()].find(
    (s) =>
      s.getAttribute("w:type") === "paragraph" &&
      ["1", "true", "on"].includes(s.getAttribute("w:default") ?? ""),
  );
  const defaults = find(styles, "w:docDefaults");
  const baseCss: Css = {
    "font-family": `"${fonts.minor ?? "Calibri"}", Carlito, Arial, sans-serif`,
    "font-size": "11pt",
    color: "#000",
    ...runCss(find(find(defaults, "w:rPrDefault"), "w:rPr")),
  };
  const defaultPPr = paragraphCss(find(find(defaults, "w:pPrDefault"), "w:pPr"));

  const paragraph = (style: string | null, pPr: Element | undefined) => {
    const styled = style ? chain(style) : chain(defaultParagraph?.getAttribute("w:styleId"));
    let css: Css = { margin: "0", ...defaultPPr };
    let numPr: Element | undefined;
    for (const s of styled) {
      css = { ...css, ...paragraphCss(kid(s, "w:pPr")), ...runCss(kid(s, "w:rPr")) };
      numPr = kid(kid(s, "w:pPr"), "w:numPr") ?? numPr;
    }
    css = { ...css, ...paragraphCss(pPr) };
    numPr = kid(pPr, "w:numPr") ?? numPr;
    const numId = val(numPr, "w:numId");
    const level = val(numPr, "w:ilvl") ?? "0";
    const cls = numId && numId !== "0" ? `n${numId}-${level}` : "";
    return { css: cssText(css), cls };
  };
  const run = (rPr: Element | undefined) => {
    const css = Object.assign(
      {},
      ...chain(val(rPr, "w:rStyle")).map((s) => runCss(kid(s, "w:rPr"))),
      runCss(rPr),
    ) as Css;
    return cssText(css);
  };
  const tableBordered = (tblPr: Element | undefined) => {
    const own = kid(tblPr, "w:tblBorders");
    const styled = chain(val(tblPr, "w:tblStyle")).some((s) => find(s, "w:tblBorders"));
    return (!!own && kids(own).some((b) => b.getAttribute("w:val") !== "none")) || styled;
  };
  // Cells look up their table's borders through the DOM, so a table marks itself bordered.
  const table = (tblPr: Element | undefined) =>
    `border-collapse:collapse;width:100%;margin:4pt 0;${tableBordered(tblPr) ? "--cell-border:0.5pt solid #000" : "--cell-border:0.5pt dashed #c8c8c8"}`;
  const cell = (tcPr: Element | undefined) => {
    const fill = kid(tcPr, "w:shd")?.getAttribute("w:fill");
    return `vertical-align:top;padding:2pt 5pt;border:var(--cell-border);${fill && fill !== "auto" ? `background:#${fill};` : ""}`;
  };

  /** Static HTML for XML the editor doesn't edit: its paragraphs and runs, tables, images. */
  const render = (el: Element, into: HTMLElement) => {
    for (const c of kids(el)) {
      switch (c.nodeName) {
        case "w:p": {
          const p = document.createElement("p");
          const { css, cls } = paragraph(val(kid(c, "w:pPr"), "w:pStyle") ?? null, kid(c, "w:pPr"));
          p.setAttribute("style", css);
          if (cls) p.className = cls;
          render(c, p);
          if (!p.textContent && !p.querySelector("img")) p.append(document.createElement("br"));
          into.append(p);
          break;
        }
        case "w:r": {
          const span = document.createElement("span");
          span.setAttribute("style", run(kid(c, "w:rPr")));
          for (const piece of kids(c)) {
            if (piece.nodeName === "w:t") span.append(piece.textContent ?? "");
            else if (piece.nodeName === "w:tab") span.append("\t");
            else if (piece.nodeName === "w:br" && piece.getAttribute("w:type") === "page") {
              const mark = document.createElement("span");
              mark.setAttribute(
                "style",
                "display:block;border-top:1px dashed #9a9a9a;margin:6pt 0;font-size:8pt;color:#9a9a9a;text-align:center",
              );
              mark.textContent = "Page break";
              span.append(mark);
            } else if (piece.nodeName === "w:br") span.append(document.createElement("br"));
            else if (piece.nodeName === "w:drawing") image(piece, span);
          }
          into.append(span);
          break;
        }
        case "w:tbl":
          into.append(staticTable(c));
          break;
        case "w:hyperlink": {
          const a = document.createElement("span");
          a.setAttribute("style", "color:#0563c1;text-decoration:underline");
          render(c, a);
          into.append(a);
          break;
        }
        case "w:del":
        case "w:delText":
        case "w:pPr":
        case "w:rPr":
        case "w:tblPr":
        case "w:tblGrid":
          break;
        default:
          render(c, into);
      }
    }
  };
  const image = (drawing: Element, into: HTMLElement) => {
    const id = find(drawing, "a:blip")?.getAttribute("r:embed");
    const src = imageUrl(parts, id ? media.get(id) : undefined);
    if (!src) return;
    const extent = find(drawing, "wp:extent");
    const img = document.createElement("img");
    img.src = src;
    img.alt = find(drawing, "wp:docPr")?.getAttribute("descr") ?? "";
    const cx = Number(extent?.getAttribute("cx")) / 9525;
    if (cx) img.style.width = `${cx}px`;
    img.style.maxWidth = "100%";
    into.append(img);
  };
  const staticTable = (tbl: Element) => {
    const out = document.createElement("table");
    out.setAttribute("style", table(kid(tbl, "w:tblPr")));
    for (const tr of kids(tbl, "w:tr")) {
      const row = document.createElement("tr");
      for (const tc of kids(tr, "w:tc")) {
        const tcPr = kid(tc, "w:tcPr");
        if (val(tcPr, "w:vMerge") === undefined && kid(tcPr, "w:vMerge")) continue;
        const td = document.createElement("td");
        const span = Number(val(tcPr, "w:gridSpan"));
        if (span > 1) td.colSpan = span;
        td.setAttribute("style", cell(tcPr));
        render(tc, td);
        row.append(td);
      }
      out.append(row);
    }
    return out;
  };

  // `render` draws an element's children, so an element draws itself inside a wrapper.
  const wrapped = (el: Element) => {
    const wrap = el.ownerDocument.createElementNS(W, "w:wrap");
    wrap.append(el.cloneNode(true));
    return wrap;
  };

  // Each list level's marker: its text with %n as that level's count, or the bullet. Read from
  // the numbering as it is now, which a new list changes.
  const numberingCss = (scope: string) => {
    const numbering = docx.numbering;
    if (!numbering) return "";
    const abstracts = new Map(
      [...numbering.getElementsByTagName("w:abstractNum")].map((a) => [
        a.getAttribute("w:abstractNumId"),
        a,
      ]),
    );
    const formats: Record<string, string> = {
      decimal: "decimal",
      lowerLetter: "lower-alpha",
      upperLetter: "upper-alpha",
      lowerRoman: "lower-roman",
      upperRoman: "upper-roman",
    };
    const rules: string[] = [];
    for (const num of numbering.getElementsByTagName("w:num")) {
      const numId = num.getAttribute("w:numId");
      const abstract = abstracts.get(val(num, "w:abstractNumId") ?? null);
      const levels = kids(abstract, "w:lvl");
      for (const lvl of levels) {
        const level = lvl.getAttribute("w:ilvl") ?? "0";
        const cls = `.${scope} .n${numId}-${level}`;
        const deeper = levels
          .map((l) => l.getAttribute("w:ilvl"))
          .filter((l) => Number(l) > Number(level))
          .map((l) => `n${numId}-${l}`);
        const format = val(lvl, "w:numFmt") ?? "decimal";
        const text = val(lvl, "w:lvlText") ?? "";
        const content =
          format === "bullet"
            ? // Symbol fonts' private-use bullets show as a plain bullet.
              JSON.stringify(/^[-]?$/.test(text) ? "•" : text)
            : text
                .split(/(%\d)/)
                .filter(Boolean)
                .map((piece) =>
                  /^%\d$/.test(piece)
                    ? `counter(n${numId}-${Number(piece[1]) - 1}, ${formats[format] ?? "decimal"})`
                    : JSON.stringify(piece),
                )
                .join(" ");
        const ind = kid(kid(lvl, "w:pPr"), "w:ind");
        const left =
          Number(ind?.getAttribute("w:left") ?? ind?.getAttribute("w:start") ?? 720) / 20;
        const hanging = Number(ind?.getAttribute("w:hanging") ?? 360) / 20;
        rules.push(
          `${cls}{counter-increment:n${numId}-${level};${deeper.length ? `counter-reset:${deeper.join(" ")};` : ""}padding-left:${left}pt;text-indent:-${hanging}pt}`,
          `${cls}::before{content:${content || '""'};display:inline-block;min-width:${hanging}pt;text-indent:0}`,
        );
      }
    }
    return rules.join("\n");
  };

  const paragraphStyles = [...byId.values()]
    .filter(
      (s) =>
        s.getAttribute("w:type") === "paragraph" && (kid(s, "w:qFormat") || s === defaultParagraph),
    )
    .map((s) => ({ id: s.getAttribute("w:styleId") ?? "", name: val(s, "w:name") ?? "" }))
    .map((s) => ({
      ...s,
      name: s.name.replace(/^heading/i, "Heading").replace(/^title/, "Title"),
    }));

  const used = new Set<string>();
  for (const part of [docx.xml, styles])
    for (const rFonts of part?.getElementsByTagName("w:rFonts") ?? []) {
      const name = rFonts.getAttribute("w:ascii");
      if (name) used.add(name);
    }
  for (const name of [fonts.minor, fonts.major]) if (name) used.add(name);

  return {
    base: cssText(baseCss),
    paragraphStyles,
    fonts: [...new Set([...[...used].sort(), ...COMMON_FONTS])],
    paragraph,
    run,
    table,
    cell,
    block: (el) => {
      const div = document.createElement("div");
      div.contentEditable = "false";
      render(wrapped(el), div);
      return div;
    },
    inline: (el) => {
      const span = document.createElement("span");
      if (el.nodeName !== "w:bookmarkStart" && el.nodeName !== "w:bookmarkEnd")
        render(wrapped(el), span);
      return span;
    },
    numberingCss,
  };
}
