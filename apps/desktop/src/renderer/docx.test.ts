// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser keeps namespace prefixes, as Chromium's does.
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { openDocx, pagesOf } from "./docx";

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (type: string, target: string) =>
  strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/${type}" Target="${target}"/></Relationships>`,
  );
const docxOf = (body: string, numbering?: string) =>
  zipSync({
    "_rels/.rels": rels("officeDocument", "word/document.xml"),
    "word/document.xml": strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
    ...(numbering && {
      "word/numbering.xml": strToU8(`<w:numbering ${NS}>${numbering}</w:numbering>`),
      "word/_rels/document.xml.rels": rels("numbering", "numbering.xml"),
    }),
  });
const p = (text: string, pPr = "") =>
  `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

test("a document's page is its section's size and margins, or Letter with one-inch margins", async () => {
  const a4 = await openDocx(
    docxOf(
      p("Summary") +
        `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>`,
    ),
  );
  // A4 in CSS pixels, with half-inch margins, through docx-preview's points.
  expect(a4.page.width).toBeCloseTo(11906 / 15, 0);
  expect(a4.page.height).toBeCloseTo(16838 / 15, 0);
  expect(a4.page).toMatchObject({ top: 48, right: 48, bottom: 48, left: 48 });
  expect(a4.render().textContent).toBe("Summary");

  const plain = await openDocx(docxOf(p("Summary")));
  expect(plain.page).toEqual({
    width: 816,
    height: 1056,
    top: 96,
    right: 96,
    bottom: 96,
    left: 96,
  });
});

test("a page break and a paragraph that breaks before itself start new pages", async () => {
  const docx = await openDocx(
    docxOf(
      p("One") +
        `<w:p><w:r><w:t>Two</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>Three</w:t></w:r></w:p>` +
        p("Four", "<w:pageBreakBefore/>"),
    ),
  );
  const pages = pagesOf(docx).map((page) => page.lastElementChild!.textContent);
  expect(pages).toEqual(["OneTwo", "Three", "Four"]);
});

test("each page resets list counters to where it starts, so later pages keep counting", async () => {
  const item = (text: string, level = 0) =>
    p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`);
  const docx = await openDocx(
    docxOf(
      item("One") +
        item("Sub", 1) +
        item("Two") +
        item("Three", 0).replace("<w:pPr>", "<w:pPr><w:pageBreakBefore/>") +
        item("Sub", 1),
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
    ),
  );
  const [top, sub] = [...docx.counters.keys()];
  expect([...docx.counters.values()]).toEqual([2, 0]);
  const resets = pagesOf(docx).map(
    (page) => (page.lastElementChild as HTMLElement).style.counterReset,
  );
  // Page 2 starts after "3." and "4." at the top level, and level 1 restarted under "4.".
  expect(resets).toEqual([`${top} 2 ${sub} 0`, `${top} 4 ${sub} 0`]);
});

test("Symbol bullets show as a plain bullet, and each font falls back to sans-serif", async () => {
  const docx = await openDocx(
    docxOf(
      p("Item", `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`),
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:rPr><w:rFonts w:ascii="Symbol"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
    ),
  );
  expect(docx.css).not.toMatch(/[-]/);
  expect(docx.css).toContain('content: "•');
  expect(docx.css).toContain("font-family: Symbol, sans-serif");
});

test("images are data: URLs, which the CSP allows and nothing has to revoke", async () => {
  const drawing = `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="3810000" cy="2857500"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="${REL}" r:embed="rId2"/></pic:blipFill><pic:spPr><a:xfrm><a:ext cx="3810000" cy="2857500"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const docx = await openDocx(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>`,
      ),
      "_rels/.rels": rels("officeDocument", "word/document.xml"),
      "word/document.xml": strToU8(
        `<w:document ${NS}><w:body><w:p><w:r>${drawing}</w:r></w:p></w:body></w:document>`,
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/image" Target="media/image1.png"/></Relationships>`,
      ),
      "word/media/image1.png": strToU8("png"),
    }),
  );
  expect(docx.render().querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/png;/);
});

test("a file that isn't a Word document says so", async () => {
  await expect(openDocx(strToU8("not a zip"))).rejects.toThrow(
    "This file has no Word document in it.",
  );
});
