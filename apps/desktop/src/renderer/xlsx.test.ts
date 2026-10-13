// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser and serializer keep namespace prefixes, as Chromium does.
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import {
  cellAt,
  editSummary,
  formatNumber,
  openXlsx,
  saveXlsx,
  setCell,
  shiftFormula,
} from "./xlsx";

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const file = zipSync({
  "[Content_Types].xml": strToU8(
    `<Types><Override PartName="/xl/workbook.xml"/><Override PartName="/xl/calcChain.xml"/></Types>`,
  ),
  "xl/workbook.xml": strToU8(
    `<workbook ${NS}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets><definedNames/></workbook>`,
  ),
  "xl/_rels/workbook.xml.rels": strToU8(
    `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://x/calcChain" Target="calcChain.xml"/></Relationships>`,
  ),
  "xl/sharedStrings.xml": strToU8(`<sst ${NS}><si><t>Item</t></si></sst>`),
  "xl/styles.xml": strToU8(
    `<styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts><font/><font><b/></font></fonts><fills><fill/></fills><cellXfs><xf numFmtId="0"/><xf numFmtId="164" fontId="1"/></cellXfs></styleSheet>`,
  ),
  "xl/worksheets/sheet1.xml": strToU8(
    `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>1234.5</v></c></row><row r="3"><c r="B3"><f>B1*2</f><v>2469</v></c></row></sheetData></worksheet>`,
  ),
  "xl/calcChain.xml": strToU8(`<calcChain/>`),
});

test("cells read with their shared strings, formats, styles, and formulas", () => {
  const x = openXlsx(file);
  const sheet = x.sheets[0]!;
  expect(cellAt(x, sheet, "A1")).toMatchObject({ text: "Item", number: false });
  expect(cellAt(x, sheet, "B1")).toMatchObject({ text: "$1,234.50", number: true });
  expect(cellAt(x, sheet, "B1").css).toContain("font-weight:700");
  expect(cellAt(x, sheet, "B3")).toMatchObject({ text: "2469", input: "=B1*2" });
});

test("edits keep a cell's style, add new rows in order, and save to recalculate on open", () => {
  const x = openXlsx(file);
  const sheet = x.sheets[0]!;
  setCell(x, sheet, "B1", "99");
  setCell(x, sheet, "C2", "new note");
  setCell(x, sheet, "B3", "=B1*3");
  expect(editSummary(x)).toEqual([
    `Budget!B1: "$1,234.50" to "99"`,
    `Budget!C2: "" to "new note"`,
    `Budget!B3: "=B1*2" to "=B1*3"`,
  ]);

  // An uncalculated formula shows itself until Excel calculates it.
  expect(cellAt(x, sheet, "B3").text).toBe("=B1*3");

  const parts = unzipSync(saveXlsx(x));
  const sheetXml = strFromU8(parts["xl/worksheets/sheet1.xml"]!);
  expect(sheetXml).toContain(`<c r="B1" s="1"><v>99</v></c>`);
  expect(sheetXml).toMatch(
    /<row r="1">.*<\/row><row r="2"><c r="C2" t="inlineStr">.*<\/row><row r="3">/,
  );
  expect(sheetXml).toContain(`<c r="B3"><f>B1*3</f></c>`);
  expect(strFromU8(parts["xl/workbook.xml"]!)).toMatch(
    /<definedNames\/><calcPr fullCalcOnLoad="1"\/>/,
  );
  expect(parts["xl/calcChain.xml"]).toBeUndefined();
  expect(strFromU8(parts["xl/_rels/workbook.xml.rels"]!)).not.toContain("calcChain");
  expect(strFromU8(parts["[Content_Types].xml"]!)).not.toContain("calcChain");

  const reopened = openXlsx(saveXlsx(x));
  expect(cellAt(reopened, reopened.sheets[0]!, "C2").text).toBe("new note");
});

test("an edit put back drops out of the summary", () => {
  const x = openXlsx(file);
  setCell(x, x.sheets[0]!, "A1", "Thing");
  setCell(x, x.sheets[0]!, "A1", "Item");
  expect(editSummary(x)).toEqual([]);
});

test("a filled-down formula reads moved, and editing its first cell keeps the rest working", () => {
  const sheet = (data: string) =>
    zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet ${NS}><sheetData>${data}</sheetData></worksheet>`,
      ),
    });
  const x = openXlsx(
    sheet(
      `<row r="2"><c r="C2"><f t="shared" ref="C2:C4" si="0">A2*$B$1+SUM(A2:B2)</f><v>1</v></c></row>` +
        `<row r="3"><c r="C3"><f t="shared" si="0"/><v>2</v></c></row>` +
        `<row r="4"><c r="C4"><f t="shared" si="0"/><v>3</v></c></row>`,
    ),
  );
  const s = x.sheets[0]!;
  expect(cellAt(x, s, "C4").input).toBe("=A4*$B$1+SUM(A4:B4)");
  setCell(x, s, "C2", "7");
  const xml = strFromU8(unzipSync(saveXlsx(x))["xl/worksheets/sheet1.xml"]!);
  expect(xml).toContain(`<c r="C3"><f>A3*$B$1+SUM(A3:B3)</f><v>2</v></c>`);
  expect(xml).toContain(`<c r="C4"><f>A4*$B$1+SUM(A4:B4)</f><v>3</v></c>`);
  expect(xml).not.toContain(`si="0"`);
});

test("whole-column and whole-row ranges shift too", () => {
  expect(shiftFormula("SUM(B:B)+SUM($C:$C)+SUM(3:3)+A1:B2", 1, 1)).toBe(
    "SUM(C:C)+SUM($C:$C)+SUM(4:4)+B2:C3",
  );
});

test("formulas shift their relative references only", () => {
  expect(shiftFormula(`LOG10(A1)+'Q1 2026'!B2+Q1!C3+"A1"&$D$4+E$5`, 2, 1)).toBe(
    `LOG10(B3)+'Q1 2026'!C4+Q1!D5+"A1"&$D$4+F$5`,
  );
});

test("numbers show in their format", () => {
  expect(formatNumber(0.125, "0.0%")).toBe("12.5%");
  expect(formatNumber(1234567.891, "#,##0.00")).toBe("1,234,567.89");
  expect(formatNumber(-50, "#,##0 ;(#,##0)")).toBe("(50)");
  expect(formatNumber(3.14159265, "General")).toBe("3.14159265");
  expect(formatNumber(45000, "m/d/yyyy")).toBe(
    new Date(Date.UTC(2023, 2, 15)).toLocaleDateString(undefined, { timeZone: "UTC" }),
  );
});
