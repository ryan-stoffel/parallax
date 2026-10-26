/**
 * A .docx as the side panel shows it (PLX-755), view-only: its body drawn as HTML by docx-preview
 * (PLX-1025), with Word's styles, fonts, list numbering, tables, and images, on pages its first
 * section sizes.
 */
export interface Docx {
  /** The page in CSS pixels. */
  page: { width: number; height: number; top: number; right: number; bottom: number; left: number };
  /** A class unique to this document, on the element its pages render in. */
  scope: string;
  /** docx-preview's stylesheets for the body, scoped to `scope`. */
  css: string;
  /**
   * The body's paragraphs and tables, built fresh on each call, in an element with class `scope`.
   * One that starts a page docx-preview broke at (a page break, page break before, or a new
   * section) has `data-break-before`.
   */
  render: () => HTMLElement;
  /** docx-preview's list counters, each at the value its list starts from. */
  counters: Map<string, number>;
}

let scopes = 0;

// Each document's pages, as its body's block indexes, and the counters each page starts at,
// measured once.
const layouts = new WeakMap<Docx, { groups: number[][]; tall: boolean[]; counters: string[] }>();

/**
 * The body on pages, each a sheet of the page's size, built fresh on each call: its paragraphs
 * and tables, laid out once at the page's text width, go onto pages in order. A new page starts
 * when the next block won't fit, or where docx-preview broke the page. A page holding one block
 * taller than a page grows to fit it. Each page resets the list counters to where it starts, so
 * a page drawn alone, as on a card, numbers as it does among the others. ponytail: a paragraph or
 * table isn't split across pages; split tables at rows if long ones need it.
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
    });
    const kept = groups.filter((group) => group.length);
    const tall = kept.map(
      (group) => group.length === 1 && (tops[group[0]! + 1] ?? end) - tops[group[0]!]! > textHeight,
    );
    layout = { groups: kept, tall, counters: countersAt(docx, blocks, kept) };
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
    text.style.counterReset = layout.counters[i]!;
    text.append(...group.map((n) => blocks[n]!));
    sheet.append(style, text);
    return sheet;
  });
}

/**
 * Each page's `counter-reset`: the list counters' values before its first block, counted through
 * the numbered paragraphs before it as docx-preview's stylesheet counts them. A paragraph at a
 * list's level counts that level and restarts the level below it.
 */
function countersAt(docx: Docx, blocks: HTMLElement[], groups: number[][]): string[] {
  const now = new Map(docx.counters);
  const numbered = new RegExp(`^(${docx.scope}-num-.+-)(\\d+)$`);
  return groups.map((group) => {
    const reset = [...now].map(([name, value]) => `${name} ${value}`).join(" ");
    for (const block of group.map((n) => blocks[n]!))
      for (const p of [block, ...block.querySelectorAll("p")]) {
        for (const name of p.tagName === "P" ? p.classList : []) {
          const level = numbered.exec(name);
          if (!level) continue;
          const below = `${level[1]}${Number(level[2]) + 1}`;
          if (docx.counters.has(below)) now.set(below, docx.counters.get(below)!);
          if (now.has(name)) now.set(name, now.get(name)! + 1);
        }
      }
    return reset;
  });
}

/**
 * Opens a .docx's bytes, with docx-preview loaded on first use. Throws when it has no readable
 * Word document.
 */
export async function openDocx(bytes: Uint8Array): Promise<Docx> {
  const { parseAsync, renderDocument } = await import("docx-preview");
  const scope = `docx-${++scopes}`;
  const options = {
    className: scope,
    inWrapper: false,
    // Pages are cut from the body (pagesOf), so headers, footers, and notes aren't drawn.
    renderHeaders: false,
    renderFooters: false,
    renderFootnotes: false,
    renderEndnotes: false,
    // data: URLs for images and fonts, which the renderer's CSP allows where blob: fonts aren't,
    // and which nothing has to revoke. Parsing reads this one, so both steps take the options.
    useBase64URL: true,
  };
  const parsed = await parseAsync(bytes, options).catch(() => {
    throw new Error("This file has no Word document in it.");
  });
  const nodes = await renderDocument(parsed, options);
  const sections = nodes.filter((node): node is HTMLElement => node.nodeName === "SECTION");
  const css = withFallbacks(
    nodes
      .filter((node) => node.nodeName === "STYLE")
      .map((node) => node.textContent)
      .join("\n")
      // The text look docx-preview gives a paragraph's runs, the document's default and each
      // paragraph style's, on the paragraph's list marker (its ::before) too, which keeps its tab.
      .replaceAll(`.${scope} span {`, `.${scope}, .${scope} span {`)
      .replace(/(p\.[\w-]+) span(?=\s*[,{])/g, "$1 span, $1::before"),
  );
  // The counters' starts, from the one `counter-reset` docx-preview writes, on `:root`.
  const reset = /counter-reset:\s*([^;}]+)/.exec(css)?.[1]?.trim().split(/\s+/) ?? [];
  const counters = new Map<string, number>();
  for (let i = 0; i + 1 < reset.length; i += 2) counters.set(reset[i]!, Number(reset[i + 1]));
  return {
    page: pageOf(sections[0]),
    scope,
    css,
    render: () => {
      const flow = document.createElement("div");
      flow.className = scope;
      sections.forEach((section, n) => {
        const blocks = [...section.querySelectorAll(":scope > article > *")].map(
          (block) => block.cloneNode(true) as HTMLElement,
        );
        if (n > 0 && blocks[0]) blocks[0].dataset["breakBefore"] = "";
        flow.append(...blocks);
      });
      return flow;
    },
    counters,
  };
}

/**
 * docx-preview's stylesheet with what a computer without Office's fonts needs: each font a
 * sans-serif fallback, as a missing Calibri would otherwise fall back to the browser's serif, and
 * symbol fonts' private-use characters (Symbol's and Wingdings' bullets, checks, and arrows) as a
 * plain bullet. `@font-face` rules keep their names.
 */
function withFallbacks(css: string): string {
  return css
    .replace(/(@font-face\s*\{[^}]*\})|font-family:\s*([^;}]+)/g, (rule, face, family: string) =>
      face || /\b(sans-serif|serif|monospace)\s*$/.test(family)
        ? rule
        : `font-family: ${family.trim()}, sans-serif`,
    )
    .replace(/[-]/g, "•");
}

/**
 * A section's page as docx-preview sizes it, in points, as CSS pixels. Word's defaults where it
 * has none: US Letter with one-inch margins.
 */
function pageOf(section: HTMLElement | undefined): Docx["page"] {
  const px = (value: string | undefined, fallback: number) =>
    value?.endsWith("pt") ? (parseFloat(value) * 4) / 3 : fallback;
  const style = section?.style;
  return {
    width: px(style?.width, 816),
    height: px(style?.minHeight, 1056),
    top: px(style?.paddingTop, 96),
    right: px(style?.paddingRight, 96),
    bottom: px(style?.paddingBottom, 96),
    left: px(style?.paddingLeft, 96),
  };
}
