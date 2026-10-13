// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser and serializer keep namespace prefixes, as Chromium does.
import { EditorState } from "@tiptap/pm/state";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { changeSummary, openDocx, paragraphTexts, saveDocx } from "./docx";

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
