import { emuToPx, find, imageUrl, kid, kids, readXml, rels, unzip, type Parts } from "./ooxml";

/**
 * A .pptx, drawn view-only in the side panel and its cards (PLX-755): each slide's background,
 * then its master's and layout's own shapes, then its shapes, with text, fills, outlines, pictures,
 * groups, and tables at their positions. Placeholders take their position and text size from the
 * layout or master. ponytail: no charts, SmartArt, effects, or color transforms such as lumMod;
 * add them when decks need them.
 */
export interface Pptx {
  parts: Parts;
  width: number;
  height: number;
  /** Each slide's part, in order. */
  slides: string[];
}

/** Opens a .pptx's bytes. Throws when it has no readable presentation. */
export function openPptx(bytes: Uint8Array): Pptx {
  const parts = unzip(bytes);
  const presentation = readXml(parts, "ppt/presentation.xml");
  if (!presentation) throw new Error("This file has no PowerPoint presentation in it.");
  const size = find(presentation, "p:sldSz");
  const targets = rels(parts, "ppt/presentation.xml");
  const slides = [...presentation.getElementsByTagName("p:sldId")]
    .map((s) => targets.get(s.getAttribute("r:id") ?? ""))
    .filter((path): path is string => !!path && !!parts[path]);
  return {
    parts,
    width: emuToPx(Number(size?.getAttribute("cx") ?? 12192000)),
    height: emuToPx(Number(size?.getAttribute("cy") ?? 6858000)),
    slides,
  };
}

interface Part {
  path: string;
  xml: Document;
  rels: Map<string, string>;
}

/** The slide at `index`, drawn at the presentation's size in CSS pixels. */
export function renderSlide(pptx: Pptx, index: number): HTMLElement {
  const { parts } = pptx;
  const part = (path: string | undefined): Part | undefined => {
    const xml = path ? readXml(parts, path) : undefined;
    return xml && path ? { path, xml, rels: rels(parts, path) } : undefined;
  };
  const byType = (from: Part | undefined, type: string) =>
    [...(from?.rels ?? [])].find(([, path]) => path.includes(`/${type}`))?.[1];
  const slide = part(pptx.slides[index]);
  const layout = part(byType(slide, "slideLayouts/"));
  const master = part(byType(layout, "slideMasters/"));
  const theme = part(byType(master, "theme/"));

  const scheme = new Map<string, string>();
  for (const c of kids(find(theme?.xml, "a:clrScheme"))) {
    const value =
      kid(c, "a:srgbClr")?.getAttribute("val") ?? kid(c, "a:sysClr")?.getAttribute("lastClr");
    if (value) scheme.set(c.nodeName.slice(2), `#${value}`);
  }
  const aliases: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
  const colorOf = (el: Element | undefined): string | undefined => {
    const srgb = kid(el, "a:srgbClr")?.getAttribute("val");
    if (srgb) return `#${srgb}`;
    const name = kid(el, "a:schemeClr")?.getAttribute("val");
    if (name) return scheme.get(aliases[name] ?? name);
    const sys = kid(el, "a:sysClr")?.getAttribute("lastClr");
    return sys ? `#${sys}` : undefined;
  };
  const fonts = {
    major: find(find(theme?.xml, "a:majorFont"), "a:latin")?.getAttribute("typeface"),
    minor: find(find(theme?.xml, "a:minorFont"), "a:latin")?.getAttribute("typeface"),
  };
  const fontOf = (face: string | null | undefined) =>
    face === "+mj-lt" ? fonts.major : face === "+mn-lt" ? fonts.minor : face;

  const root = document.createElement("div");
  root.setAttribute(
    "style",
    `position:relative;overflow:hidden;width:${pptx.width}px;height:${pptx.height}px;background:#fff;font-family:"${fonts.minor ?? "Calibri"}",Carlito,Arial,sans-serif;color:${scheme.get("dk1") ?? "#000"}`,
  );

  // The background: the slide's, else its layout's, else its master's.
  for (const from of [slide, layout, master]) {
    const bg = find(from?.xml, "p:bg");
    if (!bg) continue;
    const fill = find(bg, "a:solidFill");
    const blip = find(bg, "a:blip")?.getAttribute("r:embed");
    const ref = find(bg, "p:bgRef");
    if (fill) root.style.background = colorOf(fill) ?? "#fff";
    else if (blip) {
      const src = imageUrl(parts, from!.rels.get(blip));
      if (src) root.style.background = `center / cover no-repeat url("${src}")`;
    } else if (ref) root.style.background = colorOf(ref) ?? "#fff";
    break;
  }

  // Placeholders: a slide's names its type and index; its layout or master has the rest.
  const placeholderOf = (sp: Element) =>
    find(kid(sp, "p:nvSpPr") ?? kid(sp, "p:nvPicPr") ?? sp, "p:ph");
  const matching = (from: Part | undefined, ph: Element) => {
    const type = ph.getAttribute("type") ?? "body";
    const idx = ph.getAttribute("idx");
    const shapes = [...(from?.xml.getElementsByTagName("p:sp") ?? [])];
    const same = (sp: Element, test: (other: Element) => boolean) => {
      const other = placeholderOf(sp);
      return !!other && test(other);
    };
    const kind = (t: string) =>
      t === "ctrTitle" ? "title" : t === "subTitle" || t === "obj" ? "body" : t;
    return (
      (idx ? shapes.find((sp) => same(sp, (o) => o.getAttribute("idx") === idx)) : undefined) ??
      shapes.find((sp) => same(sp, (o) => kind(o.getAttribute("type") ?? "body") === kind(type)))
    );
  };
  const textStyle = (ph: Element | undefined) => {
    const type = ph?.getAttribute("type") ?? (ph ? "body" : "other");
    const name =
      type === "title" || type === "ctrTitle"
        ? "p:titleStyle"
        : type === "other"
          ? "p:otherStyle"
          : "p:bodyStyle";
    return find(find(master?.xml, "p:txStyles"), name);
  };

  type Box = { x: number; y: number; w: number; h: number };
  type Place = (box: Box) => Box;
  const xfrmBox = (xfrm: Element | undefined): Box | undefined => {
    const off = kid(xfrm, "a:off");
    const ext = kid(xfrm, "a:ext");
    if (!off || !ext) return undefined;
    return {
      x: emuToPx(Number(off.getAttribute("x"))),
      y: emuToPx(Number(off.getAttribute("y"))),
      w: emuToPx(Number(ext.getAttribute("cx"))),
      h: emuToPx(Number(ext.getAttribute("cy"))),
    };
  };

  const textInto = (
    el: HTMLElement,
    txBody: Element | undefined,
    chain: (Element | undefined)[],
  ) => {
    if (!txBody) return;
    const bodyPr = kid(txBody, "a:bodyPr");
    const anchor = bodyPr?.getAttribute("anchor");
    const inset = (name: string, fallback: number) =>
      emuToPx(Number(bodyPr?.getAttribute(name) ?? fallback));
    const scale =
      Number(find(bodyPr, "a:normAutofit")?.getAttribute("fontScale") ?? 100000) / 100000;
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.justifyContent =
      anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start";
    el.style.padding = `${inset("tIns", 45720)}px ${inset("rIns", 91440)}px ${inset("bIns", 45720)}px ${inset("lIns", 91440)}px`;
    // A level's properties, from the shape's own list style down to the master's text style.
    const levelPPr = (level: number) =>
      [kid(txBody, "a:lstStyle"), ...chain]
        .map((style) => kid(style, `a:lvl${level + 1}pPr`))
        .filter(Boolean) as Element[];
    for (const p of kids(txBody, "a:p")) {
      const pPr = kid(p, "a:pPr");
      const level = Number(pPr?.getAttribute("lvl") ?? 0);
      const inherited = levelPPr(level);
      const line = document.createElement("div");
      const algn =
        pPr?.getAttribute("algn") ??
        inherited.find((l) => l.hasAttribute("algn"))?.getAttribute("algn");
      line.style.textAlign =
        algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left";
      line.style.whiteSpace = "pre-wrap";
      line.style.overflowWrap = "break-word";
      const defRPr = [kid(pPr, "a:defRPr"), ...inherited.map((l) => kid(l, "a:defRPr"))];
      const runLook = (rPr: Element | undefined) => {
        const look = [rPr, ...defRPr];
        const pick = (name: string) => look.find((r) => r?.hasAttribute(name))?.getAttribute(name);
        const size = Number(pick("sz") ?? 1800) / 100;
        const fill = look.map((r) => kid(r, "a:solidFill")).find(Boolean);
        const face = look.map((r) => kid(r, "a:latin")?.getAttribute("typeface")).find(Boolean);
        return [
          `font-size:${size * scale}pt`,
          pick("b") === "1" && "font-weight:700",
          pick("i") === "1" && "font-style:italic",
          pick("u") && pick("u") !== "none" && "text-decoration:underline",
          fill && `color:${colorOf(fill)}`,
          face && `font-family:"${fontOf(face)}",Carlito,Arial,sans-serif`,
        ]
          .filter(Boolean)
          .join(";");
      };
      const buNone =
        !!kid(pPr, "a:buNone") ||
        (!kid(pPr, "a:buChar") && inherited.some((l) => kid(l, "a:buNone")));
      const bullet = kid(pPr, "a:buChar") ?? inherited.map((l) => kid(l, "a:buChar")).find(Boolean);
      const marL =
        pPr?.getAttribute("marL") ??
        inherited.find((l) => l.hasAttribute("marL"))?.getAttribute("marL");
      if (marL) line.style.paddingLeft = `${emuToPx(Number(marL))}px`;
      const hasText = kids(p).some((c) => c.nodeName === "a:r" || c.nodeName === "a:fld");
      if (bullet && !buNone && hasText) {
        const mark = document.createElement("span");
        mark.textContent = `${bullet.getAttribute("char") ?? "•"} `;
        mark.setAttribute(
          "style",
          runLook(kid(p, "a:r") ? kid(kid(p, "a:r"), "a:rPr") : undefined),
        );
        line.append(mark);
      }
      for (const c of kids(p)) {
        if (c.nodeName === "a:br") line.append(document.createElement("br"));
        if (c.nodeName !== "a:r" && c.nodeName !== "a:fld") continue;
        const span = document.createElement("span");
        span.setAttribute("style", runLook(kid(c, "a:rPr")));
        span.textContent = kid(c, "a:t")?.textContent ?? "";
        line.append(span);
      }
      if (!hasText) {
        const blank = document.createElement("span");
        blank.setAttribute("style", runLook(kid(p, "a:endParaRPr")));
        blank.textContent = "​";
        line.append(blank);
      }
      el.append(line);
    }
  };

  const draw = (
    el: Element,
    from: Part,
    into: HTMLElement,
    place: Place,
    skipPlaceholders: boolean,
  ) => {
    switch (el.nodeName) {
      case "p:sp":
      case "p:pic":
      case "p:cxnSp": {
        const ph = placeholderOf(el);
        if (ph && skipPlaceholders) return;
        const inherited = ph && from === slide ? [matching(layout, ph), matching(master, ph)] : [];
        const spPr = kid(el, "p:spPr");
        const box =
          xfrmBox(kid(spPr, "a:xfrm")) ??
          inherited.map((sp) => xfrmBox(find(sp, "a:xfrm"))).find(Boolean);
        if (!box) return;
        const at = place(box);
        const shape = document.createElement("div");
        const geometry = kid(spPr, "a:prstGeom")?.getAttribute("prst");
        const radius =
          geometry === "ellipse"
            ? "50%"
            : geometry === "roundRect"
              ? `${Math.min(at.w, at.h) * 0.1667}px`
              : "0";
        const rot = Number(kid(spPr, "a:xfrm")?.getAttribute("rot") ?? 0) / 60000;
        shape.setAttribute(
          "style",
          `position:absolute;left:${at.x}px;top:${at.y}px;width:${at.w}px;height:${at.h}px;border-radius:${radius};box-sizing:border-box;overflow:visible;${rot ? `transform:rotate(${rot}deg);` : ""}`,
        );
        const fill = kid(spPr, "a:solidFill");
        const styleFill = find(kid(el, "p:style"), "a:fillRef");
        if (fill) shape.style.background = colorOf(fill) ?? "";
        else if (
          !kid(spPr, "a:noFill") &&
          styleFill &&
          styleFill.getAttribute("idx") !== "0" &&
          el.nodeName === "p:sp"
        )
          shape.style.background = colorOf(styleFill) ?? "";
        const ln = kid(spPr, "a:ln");
        const lnColor =
          colorOf(kid(ln, "a:solidFill")) ??
          (ln && !kid(ln, "a:noFill") ? colorOf(find(kid(el, "p:style"), "a:lnRef")) : undefined);
        if (lnColor && !kid(ln, "a:noFill"))
          shape.style.border = `${Math.max(1, emuToPx(Number(ln?.getAttribute("w") ?? 12700)))}px solid ${lnColor}`;
        const blip = find(kid(el, "p:blipFill"), "a:blip")?.getAttribute("r:embed");
        const src = blip ? imageUrl(parts, from.rels.get(blip)) : undefined;
        if (src) {
          const img = document.createElement("img");
          img.src = src;
          img.setAttribute("style", "width:100%;height:100%;object-fit:fill;display:block");
          shape.append(img);
        }
        const chain = [
          ...inherited.map((sp) => kid(kid(sp, "p:txBody"), "a:lstStyle")),
          textStyle(ph),
        ];
        textInto(shape, kid(el, "p:txBody"), chain);
        into.append(shape);
        return;
      }
      case "p:grpSp": {
        const xfrm = kid(kid(el, "p:grpSpPr"), "a:xfrm");
        const outer = xfrmBox(xfrm);
        const chOff = kid(xfrm, "a:chOff");
        const chExt = kid(xfrm, "a:chExt");
        const inner: Place =
          outer && chOff && chExt
            ? (box) => {
                const sx = outer.w / (emuToPx(Number(chExt.getAttribute("cx"))) || outer.w);
                const sy = outer.h / (emuToPx(Number(chExt.getAttribute("cy"))) || outer.h);
                const cx = emuToPx(Number(chOff.getAttribute("x")));
                const cy = emuToPx(Number(chOff.getAttribute("y")));
                return place({
                  x: outer.x + (box.x - cx) * sx,
                  y: outer.y + (box.y - cy) * sy,
                  w: box.w * sx,
                  h: box.h * sy,
                });
              }
            : place;
        for (const c of kids(el)) draw(c, from, into, inner, skipPlaceholders);
        return;
      }
      case "p:graphicFrame": {
        const box = xfrmBox(kid(el, "p:xfrm"));
        if (!box) return;
        const at = place(box);
        const frame = document.createElement("div");
        frame.setAttribute(
          "style",
          `position:absolute;left:${at.x}px;top:${at.y}px;width:${at.w}px;height:${at.h}px`,
        );
        const tbl = find(el, "a:tbl");
        if (tbl) {
          const table = document.createElement("table");
          table.setAttribute("style", "width:100%;height:100%;border-collapse:collapse");
          for (const tr of kids(tbl, "a:tr")) {
            const row = document.createElement("tr");
            for (const tc of kids(tr, "a:tc")) {
              if (tc.getAttribute("hMerge") === "1" || tc.getAttribute("vMerge") === "1") continue;
              const cell = document.createElement("td");
              const span = Number(tc.getAttribute("gridSpan"));
              if (span > 1) cell.colSpan = span;
              const bg = colorOf(kid(kid(tc, "a:tcPr"), "a:solidFill"));
              cell.setAttribute(
                "style",
                `border:1px solid #fff;vertical-align:top;${bg ? `background:${bg};` : ""}`,
              );
              textInto(cell, kid(tc, "a:txBody"), [textStyle(undefined)]);
              row.append(cell);
            }
            table.append(row);
          }
          frame.append(table);
        } else {
          frame.style.border = "1px dashed #999";
          frame.style.display = "grid";
          frame.style.placeItems = "center";
          frame.style.color = "#777";
          frame.textContent = "Chart";
        }
        into.append(frame);
        return;
      }
      default:
        return;
    }
  };
  const tree = (from: Part | undefined) => find(find(from?.xml, "p:cSld"), "p:spTree");
  const identity: Place = (box) => box;
  const showMaster = (from: Part | undefined) =>
    from?.xml.documentElement.getAttribute("showMasterSp") !== "0";
  if (master && showMaster(slide) && showMaster(layout))
    for (const el of kids(tree(master))) draw(el, master, root, identity, true);
  if (layout && showMaster(slide))
    for (const el of kids(tree(layout))) draw(el, layout, root, identity, true);
  if (slide) for (const el of kids(tree(slide))) draw(el, slide, root, identity, false);
  return root;
}
