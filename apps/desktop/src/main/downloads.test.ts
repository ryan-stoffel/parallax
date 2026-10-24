import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, shell: {} }));

const { uniquePath } = await import("./downloads");

test("a download takes a name nothing has yet, numbered as Chrome numbers them", () => {
  const taken = new Set(
    ["/d/report.pdf", "/d/report (1).pdf", "/d/archive"].map((p) => path.normalize(p)),
  );
  const exists = (file: string) => taken.has(path.normalize(file));
  expect(uniquePath("/d", "report.pdf", exists)).toBe(path.join("/d", "report (2).pdf"));
  expect(uniquePath("/d", "notes.txt", exists)).toBe(path.join("/d", "notes.txt"));
  expect(uniquePath("/d", "archive", exists)).toBe(path.join("/d", "archive (1)"));
});
