// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser keeps namespace prefixes, as Chromium's does.
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { openDocx } from "./docx";

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const docxOf = (body: string, parts: Record<string, string> = {}) =>
  zipSync({
    "word/document.xml": strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
    ...Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)])),
  });

test("a document draws its paragraphs with their styles and runs, on its section's page", () => {
  const docx = openDocx(
    docxOf(
      `<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Summary</w:t></w:r></w:p>` +
        `<w:p><w:r><w:rPr><w:b/><w:color w:val="C00000"/><w:sz w:val="28"/></w:rPr><w:t>Confidential</w:t></w:r></w:p>` +
        `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>`,
      {
        "word/styles.xml": `<w:styles ${NS}><w:style w:type="paragraph" w:styleId="Title"><w:rPr><w:sz w:val="56"/></w:rPr></w:style></w:styles>`,
      },
    ),
  );
  // A4 in CSS pixels, with half-inch margins.
  expect(docx.page).toMatchObject({ width: 11906 / 15, height: 16838 / 15, top: 48, left: 48 });
  const flow = docx.render();
  expect(flow.className).toBe(docx.scope);
  const [title, body] = [...flow.children] as HTMLElement[];
  expect(title!.textContent).toBe("Summary");
  expect(title!.style.textAlign).toBe("center");
  expect(title!.style.fontSize).toBe("28pt");
  const run = body!.querySelector("span")!;
  expect(run.textContent).toBe("Confidential");
  expect(run.style.fontWeight).toBe("700");
  expect(run.style.color).toBe("rgb(192, 0, 0)");
  expect(run.style.fontSize).toBe("14pt");
});

test("tables draw with merged cells, list paragraphs get their markers, and page breaks are marked", () => {
  const docx = openDocx(
    docxOf(
      `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tr>` +
        `<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc></w:tr>` +
        `<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Before</w:t><w:br w:type="page"/></w:r></w:p>`,
      {
        "word/numbering.xml": `<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
      },
    ),
  );
  const [table, item, broken] = [...docx.render().children] as HTMLElement[];
  const cells = [...table!.querySelectorAll("td")];
  expect(cells.map((td) => td.textContent)).toEqual(["Wide", "A", "B"]);
  expect(cells[0]!.colSpan).toBe(2);
  expect(item!.className).toBe("n3-0");
  expect(docx.css).toContain(`.${docx.scope} .n3-0::before{content:"•"`);
  expect(broken!.querySelector("[data-page-break]")).not.toBeNull();
});
