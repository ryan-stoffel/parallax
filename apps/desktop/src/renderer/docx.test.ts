// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser keeps namespace prefixes, as Chromium's does.
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { numberAs, openDocx } from "./docx";

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

test("list markers count in document order across levels and formats", () => {
  const p = (numId: string, ilvl: string, text: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const docx = openDocx(
    docxOf(
      `${p("1", "0", "One")}${p("1", "1", "Sub")}${p("1", "1", "Sub")}${p("1", "0", "Two")}${p("1", "1", "Sub")}`,
      {
        "word/numbering.xml": `<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
      },
    ),
  );
  const markers = [...docx.render().querySelectorAll(".marker")].map((m) => m.textContent);
  expect(markers).toEqual(["3.", "3.i)", "3.ii)", "4.", "4.i)"]);
  expect(numberAs(28, "upperLetter")).toBe("BB");
  expect(numberAs(14, "upperRoman")).toBe("XIV");
});
