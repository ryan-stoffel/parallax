import { expect, test } from "vite-plus/test";

import { focusRow } from "./ChangesDiff";
import type { DiffFile, DiffLine } from "./parseDiff";

test("focusRow lands on a guide hunk's first line, or its file's header when it can't", () => {
  const file = (path: string) => ({ path }) as DiffFile;
  const line = (op: DiffLine["op"], n?: number): DiffLine => ({ op, text: "", new: n });
  const a = file("a.ts");
  const b = file("b.ts");
  const rows = [
    { file: a, header: true },
    { file: a, line: line("@") },
    { file: a, line: line(" ", 10) },
    { file: b, header: true },
    { file: b, line: line("@") },
    { file: b, line: line("-") },
    { file: b, line: line(" ", 4) },
    { file: b, line: line("+", 5) },
  ];
  expect(focusRow(rows, { path: "b.ts", line: 5, end: 6 })).toBe(7);
  expect(focusRow(rows, { path: "b.ts", line: 1 })).toBe(6);
  expect(focusRow(rows, { path: "b.ts", line: 99 })).toBe(3);
  expect(focusRow(rows, { path: "a.ts" })).toBe(0);
  expect(focusRow(rows, { path: "gone.ts", line: 1 })).toBe(-1);
});
