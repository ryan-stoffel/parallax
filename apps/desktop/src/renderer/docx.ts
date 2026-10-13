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
            ? JSON.stringify(/^[\uf000-\uf8ff]?$/.test(text) ? "•" : text)
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

  return { base: cssText(baseCss), render, numberingCss };
}
