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
  type Parts,
} from "./ooxml";

/**
 * A .docx as the side panel shows it (PLX-755), view-only: `word/document.xml`'s body drawn as
 * HTML with its styles, theme fonts, list numbering, tables, and images, on pages its section
 * properties size.
 */
export interface Docx {
  /** The page in CSS pixels. */
  page: { width: number; height: number; top: number; right: number; bottom: number; left: number };
  /** A class unique to this document, on the element its pages render in. */
  scope: string;
  /** The stylesheet the body needs: the page's base look and list markers, scoped to `scope`. */
  css: string;
  /** The body as HTML, one element per paragraph or table, in an element with class `scope`. */
  render: () => HTMLElement;
}

/** Whether a toggle such as `<w:b/>` is on: present, without a false `w:val`. */
const on = (el: Element | undefined) =>
  !!el && !["0", "false", "off"].includes(el.getAttribute("w:val") ?? "true");

let scopes = 0;

// Each document's pages, as its body's block indexes, measured once.
const layouts = new WeakMap<Docx, { groups: number[][]; tall: boolean[] }>();

/**
 * The body on pages, each a sheet of the page's size, built fresh on each call: its paragraphs
 * and tables, laid out once at the page's text width, go onto pages in order. A new page starts
 * when the next block won't fit, after a page break, or before a paragraph that breaks before
 * itself. A page holding one block taller than a page grows to fit it. ponytail: a paragraph
 * or table isn't split across pages; split tables at rows if long ones need it.
 */
export function pagesOf(docx: Docx): HTMLElement[] {
  const { page } = docx;
  const flow = docx.render();
  const blocks = [...flow.children] as HTMLElement[];
  let layout = layouts.get(docx);
  if (!layout) {
    const textHeight = page.height - page.top - page.bottom;
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      `position:fixed;left:-100000px;top:0;width:${page.width - page.left - page.right}px;visibility:hidden`,
    );
    const style = document.createElement("style");
    style.textContent = docx.css;
    box.append(style, flow);
    document.body.append(box);
    const tops = blocks.map((block) => block.getBoundingClientRect().top);
    const end = flow.getBoundingClientRect().bottom;
    box.remove();
    const groups: number[][] = [[]];
    let start = tops[0] ?? 0;
    blocks.forEach((block, i) => {
      const bottom = tops[i + 1] ?? end;
      const full = bottom - start > textHeight;
      if (groups.at(-1)!.length && (full || block.dataset["breakBefore"] !== undefined)) {
        groups.push([]);
        start = tops[i]!;
      }
      groups.at(-1)!.push(i);
      if (block.querySelector("[data-page-break]")) {
        groups.push([]);
        start = bottom;
      }
    });
    const kept = groups.filter((group) => group.length);
    const tall = kept.map(
      (group) => group.length === 1 && (tops[group[0]! + 1] ?? end) - tops[group[0]!]! > textHeight,
    );
    layout = { groups: kept, tall };
    layouts.set(docx, layout);
  }
  return layout.groups.map((group, i) => {
    const sheet = document.createElement("div");
    sheet.setAttribute(
      "style",
      `width:${page.width}px;${layout.tall[i] ? "min-height" : "height"}:${page.height}px;padding:${page.top}px ${page.right}px ${page.bottom}px ${page.left}px;box-sizing:border-box;overflow:hidden;background:#fff;color:#000`,
    );
    const style = document.createElement("style");
    style.textContent = docx.css;
    const text = document.createElement("div");
    text.className = docx.scope;
    text.append(...group.map((n) => blocks[n]!));
    sheet.append(style, text);
    return sheet;
  });
}

/** Opens a .docx's bytes. Throws when it has no readable `word/document.xml`. */
export function openDocx(bytes: Uint8Array): Docx {
  const parts = unzip(bytes);
  const xml = readXml(parts, "word/document.xml");
  const body = xml && find(xml, "w:body");
  if (!xml || !body) throw new Error("This file has no Word document in it.");
  const look = lookOf(parts);
  const scope = `docx-${++scopes}`;
  return {
    page: pageOf(kids(body, "w:sectPr").at(-1)),
    scope,
    css: `.${scope}{${look.base};white-space:pre-wrap}\n${look.numberingCss(scope)}`,
    render: () => {
      const flow = document.createElement("div");
      flow.className = scope;
      look.render(body, flow);
      return flow;
    },
  };
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
  render: (el: Element, into: HTMLElement) => void;
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

  const paragraphCache = new Map<
    string,
    { css: string; cls: string; num: { numId: string; level: number } | undefined }
  >();
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
    const listed = !!numId && numId !== "0";
    const cls = listed ? `n${numId}-${level}` : "";
    const found = {
      css: cssText(css),
      cls,
      num: listed ? { numId: numId!, level: Number(level) } : undefined,
    };
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

  /** The body's XML as HTML: its paragraphs and runs, tables, images, and page breaks. */
  const render = (el: Element, into: HTMLElement) => {
    for (const c of kids(el)) {
      switch (c.nodeName) {
        case "w:p": {
          const p = document.createElement("p");
          const pPr = kid(c, "w:pPr");
          const { css, cls, num } = paragraph(val(pPr, "w:pStyle") ?? null, pPr);
          p.setAttribute("style", css);
          if (cls) p.className = cls;
          if (on(kid(pPr, "w:pageBreakBefore"))) p.dataset["breakBefore"] = "";
          const label = num && marker(num.numId, num.level);
          if (label !== undefined) {
            const span = document.createElement("span");
            span.className = "marker";
            span.textContent = label;
            p.append(span);
          }
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
            else if (piece.nodeName === "w:br" && piece.getAttribute("w:type") === "page")
              // The pages start a new one after its paragraph.
              span.dataset["pageBreak"] = "";
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
        case "w:sectPr":
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
    const cy = Number(extent?.getAttribute("cy")) / 9525;
    if (cx) img.style.width = `${cx}px`;
    // Its shape before it decodes, so pages measure it at its height.
    if (cx && cy) img.style.aspectRatio = `${cx} / ${cy}`;
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

  // Each list level's marker: its text with %n as that level's count, or the bullet.
  // Each list's levels, by numId.
  const abstracts = new Map(
    [...(numbering?.getElementsByTagName("w:abstractNum") ?? [])].map((a) => [
      a.getAttribute("w:abstractNumId"),
      a,
    ]),
  );
  const lists = new Map(
    [...(numbering?.getElementsByTagName("w:num") ?? [])].map((num) => [
      num.getAttribute("w:numId") ?? "",
      kids(abstracts.get(val(num, "w:abstractNumId") ?? null), "w:lvl"),
    ]),
  );
  const levelOf = (numId: string, level: number) =>
    lists.get(numId)?.find((l) => Number(l.getAttribute("w:ilvl") ?? 0) === level);
  const startOf = (numId: string, level: number) =>
    Number(val(levelOf(numId, level), "w:start") ?? 1);
  // Each list's count at each level, in document order, from the start of a render.
  let counts = new Map<string, number[]>();
  /** A list paragraph's marker: its bullet, or its level's text with each %n counted. */
  const marker = (numId: string, level: number): string | undefined => {
    const lvl = levelOf(numId, level);
    if (!lvl) return undefined;
    const counted = counts.get(numId) ?? [];
    counted[level] = (counted[level] ?? startOf(numId, level) - 1) + 1;
    counted.length = level + 1;
    counts.set(numId, counted);
    const text = val(lvl, "w:lvlText") ?? "";
    if (val(lvl, "w:numFmt") === "bullet")
      // Symbol fonts' private-use bullets show as a plain bullet.
      return /^[\uf000-\uf8ff]?$/.test(text) ? "•" : text;
    return text.replace(/%(\d)/g, (_, n: string) => {
      const at = Number(n) - 1;
      return numberAs(
        counted[at] ?? startOf(numId, at),
        val(levelOf(numId, at), "w:numFmt") ?? "decimal",
      );
    });
  };
  const renderBody = (body: Element, into: HTMLElement) => {
    counts = new Map();
    render(body, into);
  };

  // Each list level's indent, with its marker hanging in it.
  const numberingCss = (scope: string) => {
    const rules: string[] = [];
    for (const [numId, levels] of lists)
      for (const lvl of levels) {
        const ind = kid(kid(lvl, "w:pPr"), "w:ind");
        const left =
          Number(ind?.getAttribute("w:left") ?? ind?.getAttribute("w:start") ?? 720) / 20;
        const hanging = Number(ind?.getAttribute("w:hanging") ?? 360) / 20;
        const cls = `.${scope} .n${numId}-${lvl.getAttribute("w:ilvl") ?? "0"}`;
        rules.push(
          `${cls}{padding-left:${left}pt;text-indent:-${hanging}pt}`,
          `${cls}>.marker{display:inline-block;min-width:${hanging}pt;text-indent:0}`,
        );
      }
    return rules.join("\n");
  };

  return { base: cssText(baseCss), render: renderBody, numberingCss };
}

/** `n` in a list's number format: decimal, letters, or roman numerals. */
export function numberAs(n: number, format: string): string {
  const letters = (upper: boolean) => {
    const letter = String.fromCharCode((upper ? 65 : 97) + ((n - 1) % 26));
    return letter.repeat(Math.floor((n - 1) / 26) + 1);
  };
  const roman = () => {
    const numerals: [number, string][] = [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ];
    let left = n;
    let out = "";
    for (const [value, numeral] of numerals)
      while (left >= value) {
        out += numeral;
        left -= value;
      }
    return out;
  };
  switch (format) {
    case "lowerLetter":
      return letters(false);
    case "upperLetter":
      return letters(true);
    case "lowerRoman":
      return roman();
    case "upperRoman":
      return roman().toUpperCase();
    case "decimalZero":
      return String(n).padStart(2, "0");
    default:
      return String(n);
  }
}
