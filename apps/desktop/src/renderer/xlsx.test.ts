// @vitest-environment jsdom
// jsdom, not happy-dom: its XML parser keeps namespaces, as Chromium does.
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { cellAt, formatNumber, openXlsx } from "./xlsx";

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const file = zipSync({
  "[Content_Types].xml": strToU8(`<Types><Override PartName="/xl/workbook.xml"/></Types>`),
  "xl/workbook.xml": strToU8(
    `<workbook ${NS}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets><definedNames/></workbook>`,
  ),
  "xl/_rels/workbook.xml.rels": strToU8(
    `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  ),
  "xl/sharedStrings.xml": strToU8(`<sst ${NS}><si><t>Item</t></si></sst>`),
  "xl/styles.xml": strToU8(
    `<styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts><font/><font><b/></font></fonts><fills><fill/></fills><cellXfs><xf numFmtId="0"/><xf numFmtId="164" fontId="1"/></cellXfs></styleSheet>`,
  ),
  "xl/worksheets/sheet1.xml": strToU8(
    `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>1234.5</v></c></row><row r="3"><c r="B3"><f>B1*2</f><v>2469</v></c></row></sheetData></worksheet>`,
  ),
});

test("cells read with their shared strings, formats, styles, and formulas", () => {
  const x = openXlsx(file);
  const sheet = x.sheets[0]!;
  expect(cellAt(x, sheet, "A1")).toMatchObject({ text: "Item", number: false });
  expect(cellAt(x, sheet, "B1")).toMatchObject({ text: "$1,234.50", number: true });
  expect(cellAt(x, sheet, "B1").css).toContain("font-weight:700");
  expect(cellAt(x, sheet, "B3")).toMatchObject({ text: "2469", number: true });
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
