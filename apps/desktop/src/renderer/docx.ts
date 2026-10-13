import { Mark, Schema, type Node as PMNode } from "@tiptap/pm/model";

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
 * A .docx as the side panel edits it (PLX-755). `word/document.xml`'s body becomes a ProseMirror
 * document: each `w:p` a paragraph that keeps its `w:pPr` and paragraph style, its runs text marked
 * with their `w:rPr` plus bold, italic, and underline, and everything else (tables, drawings,
 * hyperlinks, fields) an atom holding its original XML. Saving writes a paragraph the user didn't
 * touch back as its original element, so only edited paragraphs are rebuilt, and every other part
 * of the package is written back as it was.
 */
export interface Docx {
  parts: Parts;
  xml: Document;
  body: Element;
  /** The body's closing section properties: page size and margins, headers and footers. */
  sectPr?: Element;
  /** Elements the document's nodes name by index: `w:pPr`s, `w:rPr`s, and atoms' XML. */
  els: Element[];
  /** Each unchanged paragraph's original element, by its node's JSON. */
  originals: Map<string, Element>;
  schema: DocxSchema;
  doc: PMNode;
  /** The page in CSS pixels. */
  page: { width: number; height: number; top: number; right: number; bottom: number; left: number };
  /** The stylesheet for the document's numbered and bulleted paragraphs, scoped to `scope`. */
  css: string;
  /** A class unique to this document, on the element its pages render in. */
  scope: string;
  /** The page's base look: the default paragraph style's font, size, and color. */
  base: string;
  /** Paragraph styles to offer, by id, with their names. */
  styles: { id: string; name: string }[];
  /** Each paragraph's text when opened or last saved, for the change summary. */
  texts: string[];
}

/** The editor's schema, with its node and mark names typed. */
export type DocxSchema = Schema<
  "doc" | "paragraph" | "opaqueBlock" | "text" | "hardBreak" | "opaque",
  "run" | "bold" | "italic" | "underline"
>;

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

// CT_RPr's child order, which Word checks: a run's bold, italic, and underline go in their places.
const RPR_ORDER = [
  "rStyle",
  "rFonts",
  "b",
  "bCs",
  "i",
  "iCs",
  "caps",
  "smallCaps",
  "strike",
  "dstrike",
  "outline",
  "shadow",
  "emboss",
  "imprint",
  "noProof",
  "snapToGrid",
  "vanish",
  "webHidden",
  "color",
  "spacing",
  "w",
  "kern",
  "position",
  "sz",
  "szCs",
  "highlight",
  "u",
  "effect",
  "bdr",
  "shd",
  "fitText",
  "vertAlign",
  "rtl",
  "cs",
  "em",
  "lang",
  "eastAsianLayout",
  "specVanish",
  "oMath",
].map((name) => `w:${name}`);

/** Whether a toggle such as `<w:b/>` is on: present, without a false `w:val`. */
const on = (el: Element | undefined) =>
  !!el && !["0", "false", "off"].includes(el.getAttribute("w:val") ?? "true");

let scopes = 0;

/** Opens a .docx's bytes. Throws when it has no readable `word/document.xml`. */
export function openDocx(bytes: Uint8Array): Docx {
  const parts = unzip(bytes);
  const xml = readXml(parts, "word/document.xml");
  const body = xml && find(xml, "w:body");
  if (!xml || !body) throw new Error("This file has no Word document in it.");
  const els: Element[] = [];
  const reg = (el: Element) => els.push(el) - 1;
  const look = lookOf(parts);
  const docx = {
    parts,
    xml,
    body,
    els,
    originals: new Map(),
    page: pageOf(kids(body, "w:sectPr").at(-1)),
    scope: `docx-${++scopes}`,
    base: look.base,
    styles: look.paragraphStyles,
    texts: [],
  } as unknown as Docx;
  docx.sectPr = kids(body, "w:sectPr").at(-1);
  docx.schema = schemaFor(docx, look);
  docx.css = look.numberingCss(docx.scope);
  const { schema } = docx;

  const marksOf = (rPr: Element | undefined): Mark[] => {
    const clean = rPr ? (rPr.cloneNode(true) as Element) : undefined;
    const marks: Mark[] = [];
    const take = (names: string[], mark: () => Mark) => {
      const found = names.map((name) => kid(clean, name)).filter((el) => el && on(el));
      if (!found.length || !clean) return;
      for (const el of found) clean.removeChild(el!);
      marks.push(mark());
    };
    take(["w:b", "w:bCs"], () => schema.marks.bold.create());
    take(["w:i", "w:iCs"], () => schema.marks.italic.create());
    const u = kid(clean, "w:u");
    if (u && clean && u.getAttribute("w:val") !== "none") {
      clean.removeChild(u);
      marks.push(schema.marks.underline.create({ val: u.getAttribute("w:val") ?? "single" }));
    }
    return [schema.marks.run.create({ rPr: clean ? reg(clean) : null }), ...marks];
  };

  const runNodes = (r: Element, into: PMNode[]) => {
    const rPr = kid(r, "w:rPr");
    const marks = marksOf(rPr);
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

  const blocks: PMNode[] = [];
  for (const el of kids(body)) {
    if (el === docx.sectPr) continue;
    if (el.nodeName !== "w:p") {
      blocks.push(schema.nodes.opaqueBlock.create({ id: reg(el) }));
      continue;
    }
    const pPr = kid(el, "w:pPr");
    const inline: PMNode[] = [];
    for (const c of kids(el)) {
      if (c.nodeName === "w:pPr" || c.nodeName === "w:proofErr") continue;
      if (c.nodeName === "w:r") runNodes(c, inline);
      else inline.push(schema.nodes.opaque.create({ id: reg(c) }));
    }
    const node = schema.nodes.paragraph.create(
      { style: val(pPr, "w:pStyle") ?? null, pPr: pPr ? reg(pPr) : null },
      inline,
    );
    docx.originals.set(JSON.stringify(node.toJSON()), el);
    blocks.push(node);
  }
  if (!blocks.length) blocks.push(schema.nodes.paragraph.create());
  docx.doc = schema.nodes.doc.create(null, blocks);
  docx.texts = paragraphTexts(docx, docx.doc);
  return docx;
}

/** The .docx with `doc`'s content: unchanged paragraphs as they were, edited ones rebuilt. */
export function saveDocx(docx: Docx, doc: PMNode): Uint8Array {
  const { xml, els, schema } = docx;
  const el = (name: string, attrs: Record<string, string> = {}) => {
    const made = xml.createElementNS(W, name);
    for (const [key, value] of Object.entries(attrs)) made.setAttributeNS(W, key, value);
    return made;
  };
  const insert = (rPr: Element, made: Element) => {
    const at = RPR_ORDER.indexOf(made.nodeName);
    const before = kids(rPr).find((c) => RPR_ORDER.indexOf(c.nodeName) > at);
    rPr.insertBefore(made, before ?? null);
  };
  const rPrFor = (marks: readonly Mark[]) => {
    const id = marks.find((m) => m.type === schema.marks.run)?.attrs["rPr"] as number | null;
    const rPr = id == null ? el("w:rPr") : (els[id]!.cloneNode(true) as Element);
    const set = (names: string[], wanted: boolean, attrs: Record<string, string> = {}) => {
      for (const name of names) {
        kid(rPr, name)?.remove();
        if (wanted) insert(rPr, el(name, attrs));
      }
    };
    if (marks.some((m) => m.type === schema.marks.bold)) set(["w:b", "w:bCs"], true);
    if (marks.some((m) => m.type === schema.marks.italic)) set(["w:i", "w:iCs"], true);
    const u = marks.find((m) => m.type === schema.marks.underline);
    if (u) set(["w:u"], true, { "w:val": u.attrs["val"] as string });
    return rPr.children.length || rPr.attributes.length ? rPr : undefined;
  };
  const textInto = (run: Element, text: string) =>
    text.split("\t").forEach((piece, i) => {
      if (i) run.append(el("w:tab"));
      if (!piece) return;
      const t = el("w:t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.textContent = piece;
      run.append(t);
    });
  const build = (block: PMNode) => {
    const p = el("w:p");
    const pPrId = block.attrs["pPr"] as number | null;
    let pPr = pPrId == null ? undefined : (els[pPrId]!.cloneNode(true) as Element);
    const style = block.attrs["style"] as string | null;
    if (style !== (val(pPr, "w:pStyle") ?? null)) {
      pPr ??= el("w:pPr");
      kid(pPr, "w:pStyle")?.remove();
      if (style) pPr.prepend(el("w:pStyle", { "w:val": style }));
    }
    if (pPr && (pPr.children.length || pPr.attributes.length)) p.append(pPr);
    let run: Element | undefined;
    let runMarks: readonly Mark[] = [];
    block.forEach((node) => {
      if (node.isText) {
        if (!run || !Mark.sameSet(runMarks, node.marks)) {
          run = el("w:r");
          const rPr = rPrFor(node.marks);
          if (rPr) run.append(rPr);
          p.append(run);
          runMarks = node.marks;
        }
        textInto(run, node.text ?? "");
        return;
      }
      run = undefined;
      if (node.type === schema.nodes.hardBreak) {
        const br = el("w:r");
        const rPr = rPrFor(node.marks);
        if (rPr) br.append(rPr);
        br.append(el("w:br"));
        p.append(br);
      } else p.append(els[node.attrs["id"] as number]!.cloneNode(true));
    });
    return p;
  };
  const out: Node[] = [];
  doc.forEach((block) => {
    if (block.type === schema.nodes.opaqueBlock)
      out.push(els[block.attrs["id"] as number]!.cloneNode(true));
    else
      out.push(docx.originals.get(JSON.stringify(block.toJSON()))?.cloneNode(true) ?? build(block));
  });
  if (docx.sectPr) out.push(docx.sectPr.cloneNode(true));
  docx.body.replaceChildren(...out);
  return zip({ ...docx.parts, "word/document.xml": writeXml(xml) });
}

/** Each paragraph's text, with atoms' text and line breaks, for the change summary. */
export function paragraphTexts(docx: Docx, doc: PMNode): string[] {
  const texts: string[] = [];
  doc.forEach((block) => {
    if (block.type === docx.schema.nodes.opaqueBlock) {
      // A table's cells, one paragraph each.
      for (const p of docx.els[block.attrs["id"] as number]!.getElementsByTagName("w:p"))
        texts.push(wordText(p));
      return;
    }
    let text = "";
    block.forEach((node) => {
      if (node.isText) text += node.text;
      else if (node.type === docx.schema.nodes.hardBreak) text += "\n";
      else text += wordText(docx.els[node.attrs["id"] as number]!);
    });
    texts.push(text);
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

const headingLike = (style: unknown) =>
  typeof style === "string" && /^(heading|title|subtitle)/i.test(style);

/** Whether Enter at the end of a paragraph in `style` starts a plain one, as Word does. */
export const endsStyle = headingLike;

function schemaFor(docx: Docx, look: Look): DocxSchema {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        group: "block",
        content: "inline*",
        attrs: { style: { default: null }, pPr: { default: null } },
        parseDOM: [{ tag: "p" }, { tag: "h1" }, { tag: "h2" }, { tag: "h3" }, { tag: "li" }],
        toDOM: (node) => {
          const { css, cls } = look.paragraph(
            node.attrs["style"] as string | null,
            node.attrs["pPr"] == null ? undefined : docx.els[node.attrs["pPr"] as number],
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
    marks: {
      run: {
        attrs: { rPr: { default: null } },
        toDOM: (mark) => [
          "span",
          {
            style: look.run(
              mark.attrs["rPr"] == null ? undefined : docx.els[mark.attrs["rPr"] as number],
            ),
          },
          0,
        ],
      },
      bold: {
        parseDOM: [{ tag: "strong" }, { tag: "b" }],
        toDOM: () => ["strong", { style: "font-weight:700" }, 0],
      },
      italic: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
      underline: {
        attrs: { val: { default: "single" } },
        parseDOM: [{ tag: "u" }],
        toDOM: () => ["u", 0],
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

interface Look {
  base: string;
  paragraphStyles: { id: string; name: string }[];
  paragraph: (style: string | null, pPr: Element | undefined) => { css: string; cls: string };
  run: (rPr: Element | undefined) => string;
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
function lookOf(parts: Parts): Look {
  const styles = readXml(parts, "word/styles.xml");
  const theme = readXml(parts, "word/theme/theme1.xml");
  const numbering = readXml(parts, "word/numbering.xml");
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
    const theme = rFonts?.getAttribute("w:asciiTheme");
    const font =
      rFonts?.getAttribute("w:ascii") ??
      (theme ? fonts[theme.startsWith("major") ? "major" : "minor"] : undefined);
    if (font) css["font-family"] = `"${font}", sans-serif`;
    const highlight = val(rPr, "w:highlight");
    if (highlight && highlight !== "none") css["background-color"] = highlight;
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
  const numIdOf = (pPr: Element | undefined) => kid(pPr, "w:numPr");

  const paragraphCache = new Map<string, { css: string; cls: string }>();
  const pPrIds = new WeakMap<Element, number>();
  let nextId = 0;
  const paragraph = (style: string | null, pPr: Element | undefined) => {
    if (pPr && !pPrIds.has(pPr)) pPrIds.set(pPr, nextId++);
    const key = `${style}|${pPr ? pPrIds.get(pPr) : ""}`;
    const cached = paragraphCache.get(key);
    if (cached) return cached;
    const styled = style ? chain(style) : chain(defaultParagraph?.getAttribute("w:styleId"));
    let css: Css = { margin: "0", ...defaultPPr };
    let numPr: Element | undefined;
    for (const s of styled) {
      css = { ...css, ...paragraphCss(kid(s, "w:pPr")), ...runCss(kid(s, "w:rPr")) };
      numPr = numIdOf(kid(s, "w:pPr")) ?? numPr;
    }
    css = { ...css, ...paragraphCss(pPr) };
    numPr = numIdOf(pPr) ?? numPr;
    const numId = val(numPr, "w:numId");
    const level = val(numPr, "w:ilvl") ?? "0";
    const cls = numId && numId !== "0" ? `n${numId}-${level}` : "";
    const found = { css: cssText(css), cls };
    paragraphCache.set(key, found);
    return found;
  };
  const run = (rPr: Element | undefined) => {
    const css = Object.assign(
      {},
      ...chain(val(rPr, "w:rStyle")).map((s) => runCss(kid(s, "w:rPr"))),
      runCss(rPr),
    ) as Css;
    return cssText(css);
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
            else if (piece.nodeName === "w:br") span.append(document.createElement("br"));
            else if (piece.nodeName === "w:drawing") image(piece, span);
          }
          into.append(span);
          break;
        }
        case "w:tbl":
          into.append(table(c));
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
  const table = (tbl: Element) => {
    const out = document.createElement("table");
    const bordered =
      !!find(kid(tbl, "w:tblPr"), "w:tblBorders") ||
      /grid/i.test(val(kid(tbl, "w:tblPr"), "w:tblStyle") ?? "");
    out.setAttribute("style", "border-collapse:collapse;width:100%;margin:4pt 0");
    for (const tr of kids(tbl, "w:tr")) {
      const row = document.createElement("tr");
      for (const tc of kids(tr, "w:tc")) {
        const tcPr = kid(tc, "w:tcPr");
        if (val(tcPr, "w:vMerge") === undefined && kid(tcPr, "w:vMerge")) continue;
        const cell = document.createElement("td");
        const span = Number(val(tcPr, "w:gridSpan"));
        if (span > 1) cell.colSpan = span;
        const fill = kid(tcPr, "w:shd")?.getAttribute("w:fill");
        cell.setAttribute(
          "style",
          `vertical-align:top;padding:2pt 5pt;${bordered ? "border:0.5pt solid #000;" : ""}${fill && fill !== "auto" ? `background:#${fill};` : ""}`,
        );
        render(tc, cell);
        row.append(cell);
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

  // Each list level's marker: its text with %n as that level's count, or the bullet.
  const numberingCss = (scope: string) => {
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
            ? JSON.stringify(/^[-]?$/.test(text) ? "•" : text)
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

  return {
    base: cssText(baseCss),
    paragraphStyles,
    paragraph,
    run,
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
