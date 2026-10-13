// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser and serializer keep namespace prefixes, as Chromium does.
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { addRowAfter } from "@tiptap/pm/tables";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import {
  changeSummary,
  isBulleted,
  listNumId,
  newLink,
  openDocx,
  paragraphTexts,
  saveDocx,
} from "./docx";

const body = [
  // An attribute a rebuilt paragraph would drop, so it shows the paragraph was kept.
  `<w:p w:rsidR="00AB12CD"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>`,
  `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:r><w:tab/><w:t>world</w:t></w:r></w:p>`,
  `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`,
].join("");
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
const file = zipSync({
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(documentXml),
  "word/media/keep.bin": new Uint8Array([1, 2, 3]),
});

const bodyOf = (bytes: Uint8Array) => {
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]!);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return [...doc.getElementsByTagName("w:body")[0]!.children];
};
const original = bodyOf(file);
const xmlOf = (el: Element) => new XMLSerializer().serializeToString(el);

test("an untouched document saves every element and part as it was", () => {
  const docx = openDocx(file);
  const saved = saveDocx(docx, docx.doc);
  expect(bodyOf(saved).map(xmlOf)).toEqual(original.map(xmlOf));
  expect([...unzipSync(saved)["word/media/keep.bin"]!]).toEqual([1, 2, 3]);
});

test("an edit rebuilds only its paragraph, keeping its properties, formatting, and links", () => {
  const docx = openDocx(file);
  let at = -1;
  docx.doc.descendants((node, pos) => {
    // The tab and the text after it are one text node.
    if (node.text === "\tworld") at = pos + 1;
  });
  const state = EditorState.create({ doc: docx.doc });
  const edited = state.apply(state.tr.insertText("big ", at)).doc;
  const [title, paragraph, table, sectPr] = bodyOf(saveDocx(docx, edited));

  expect(xmlOf(title!)).toBe(xmlOf(original[0]!));
  expect(xmlOf(table!)).toBe(xmlOf(original[2]!));
  expect(xmlOf(sectPr!)).toBe(xmlOf(original[3]!));
  const xml = xmlOf(paragraph!);
  expect(xml).toContain(`<w:jc w:val="center"/>`);
  // Bold goes back in CT_RPr's order, ahead of the color.
  expect(xml).toMatch(/<w:rPr><w:b\/><w:bCs\/><w:color w:val="FF0000"\/><\/w:rPr>/);
  // By qualified name: alone, an element serializes without its root's xmlns:r.
  expect(paragraph!.getElementsByTagName("w:hyperlink")[0]?.getAttribute("r:id")).toBe("rId9");
  expect(xml).toMatch(/<w:tab\/><w:t xml:space="preserve">big world<\/w:t>/);
  expect(changeSummary(docx.texts, paragraphTexts(docx, edited))).toEqual([
    `Changed "Hello link\\tworld" to "Hello link\\tbig world"`,
  ]);
});

test("a change summary pairs replaced lines and names added and removed ones", () => {
  expect(changeSummary(["a", "b", "c"], ["a", "B", "c", "d"])).toEqual([
    `Changed "b" to "B"`,
    `Added "d"`,
  ]);
  expect(changeSummary(["a", "b"], ["b"])).toEqual([`Removed "a"`]);
  expect(changeSummary(["a"], ["a"])).toEqual([]);
});

// PLX-758: Word's Home tab. Each test opens a small document, changes it as the toolbar would,
// and reads the saved XML back.
const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const docxOf = (body: string, extra: Record<string, string> = {}) =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="x"/></Types>`,
    ),
    "word/document.xml": strToU8(`<w:document ${W_NS}><w:body>${body}</w:body></w:document>`),
    ...Object.fromEntries(Object.entries(extra).map(([path, xml]) => [path, strToU8(xml)])),
  });
const saved = (bytes: Uint8Array, part = "word/document.xml") => strFromU8(unzipSync(bytes)[part]!);
/** The position just inside the text `text`. */
const at = (doc: PMNode, text: string) => {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text))
      found = pos + node.text.indexOf(text);
  });
  return found;
};

test("run formatting saves in Word's order, and a theme color stays as it was", () => {
  const docx = openDocx(
    docxOf(
      `<w:p><w:r><w:rPr><w:color w:val="1F3864" w:themeColor="accent1"/></w:rPr><w:t>Hello world</w:t></w:r></w:p>`,
    ),
  );
  const { marks } = docx.schema;
  const from = at(docx.doc, "world");
  const tr = EditorState.create({ doc: docx.doc }).tr;
  for (const mark of [
    marks.vertAlign.create({ val: "superscript" }),
    marks.highlight.create({ val: "yellow" }),
    marks.size.create({ half: "28" }),
    marks.strike.create(),
    marks.font.create({ name: "Georgia" }),
  ])
    tr.addMark(from, from + 5, mark);
  const xml = saved(saveDocx(docx, tr.doc));
  // "Hello " keeps its theme color; "world" adds the rest around it in CT_RPr's order.
  expect(xml).toContain(
    `<w:r><w:rPr><w:color w:val="1F3864" w:themeColor="accent1"/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r>`,
  );
  expect(xml).toContain(
    `<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia" w:eastAsia="Georgia"/><w:strike/><w:color w:val="1F3864" w:themeColor="accent1"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/></w:rPr>`,
  );
});

test("paragraph alignment, spacing, and indent save in Word's order with the rest kept", () => {
  const docx = openDocx(
    docxOf(
      `<w:p><w:pPr><w:pStyle w:val="Quote"/><w:keepNext/></w:pPr><w:r><w:t>Para</w:t></w:r></w:p>`,
    ),
  );
  let pos = -1;
  docx.doc.descendants((node, p) => {
    if (node.type.name === "paragraph") pos = p;
  });
  const node = docx.doc.nodeAt(pos)!;
  const tr = EditorState.create({ doc: docx.doc }).tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    align: "center",
    spacing: { "w:line": "360", "w:lineRule": "auto" },
    ind: { "w:left": "720" },
  });
  expect(saved(saveDocx(docx, tr.doc))).toContain(
    `<w:pPr><w:pStyle w:val="Quote"/><w:keepNext/><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:left="720"/><w:jc w:val="center"/></w:pPr>`,
  );
});

test("a list in a document without numbering adds the part, its relationship, and its type", () => {
  const docx = openDocx(docxOf(`<w:p><w:r><w:t>Item</w:t></w:r></w:p>`));
  const numId = listNumId(docx, "bullet");
  expect(isBulleted(docx, numId)).toBe(true);
  expect(listNumId(docx, "bullet")).toBe(numId);
  const numbered = listNumId(docx, "number");
  expect(numbered).not.toBe(numId);
  const node = docx.doc.firstChild!;
  const tr = EditorState.create({ doc: docx.doc }).tr.setNodeMarkup(0, undefined, {
    ...node.attrs,
    num: { numId, ilvl: "1" },
  });
  const bytes = saveDocx(docx, tr.doc);
  expect(saved(bytes)).toContain(
    `<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`,
  );
  const numbering = saved(bytes, "word/numbering.xml");
  // Every abstractNum comes before the first num.
  expect(numbering.lastIndexOf("<w:abstractNum ")).toBeLessThan(numbering.indexOf("<w:num "));
  expect(saved(bytes, "word/_rels/document.xml.rels")).toContain(`Target="numbering.xml"`);
  expect(saved(bytes, "[Content_Types].xml")).toContain(`PartName="/word/numbering.xml"`);
});

test("table cells edit in place, rows add, and merged cells save as Word merges them", () => {
  const cell = (text: string, tcPr = "") =>
    `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell("Wide", `<w:gridSpan w:val="2"/>`)}${cell("Tall", `<w:vMerge w:val="restart"/>`)}</w:tr><w:tr>${cell("A")}${cell("B")}<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>`;
  const docx = openDocx(docxOf(`${table}<w:p/>`));
  expect(docx.doc.firstChild!.type.name).toBe("table");
  // Untouched, it saves as it was.
  expect(saved(saveDocx(docx, docx.doc))).toContain(table);

  let state = EditorState.create({ doc: docx.doc });
  state = state.apply(state.tr.insertText("!", at(state.doc, "A") + 1));
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at(state.doc, "B"))));
  addRowAfter(state, (tr) => (state = state.apply(tr)));
  const xml = saved(saveDocx(docx, state.doc));
  expect(xml).toContain(`<w:t xml:space="preserve">A!</w:t>`);
  expect(xml).toContain(`<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>`);
  expect(xml).toContain(`<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>`);
  expect(xml.match(/<w:tr>/g)).toHaveLength(3);
  expect(xml.match(/<w:vMerge\/>/g)).toHaveLength(1);
  expect(xml.match(/<w:gridCol /g)).toHaveLength(3);
});

test("a new link adds an external relationship and wraps its runs", () => {
  const docx = openDocx(
    docxOf(`<w:p><w:r><w:t>Read the docs</w:t></w:r></w:p>`, {
      "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="styles.xml"/></Relationships>`,
    }),
  );
  const link = docx.schema.marks.link.create({ id: newLink(docx, "https://example.com") });
  const from = at(docx.doc, "docs");
  const tr = EditorState.create({ doc: docx.doc }).tr.addMark(from, from + 4, link);
  const bytes = saveDocx(docx, tr.doc);
  expect(saved(bytes)).toMatch(
    /<w:hyperlink r:id="rId2"><w:r><w:t xml:space="preserve">docs<\/w:t><\/w:r><\/w:hyperlink>/,
  );
  expect(saved(bytes, "word/_rels/document.xml.rels")).toContain(
    `Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"`,
  );
});
