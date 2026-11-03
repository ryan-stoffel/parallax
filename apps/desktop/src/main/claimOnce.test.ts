import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";

import { claimOnce } from "./claimOnce";

test("only the first claim of a file succeeds, and one that can't be made fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claim-"));
  const file = path.join(dir, "claim");
  expect(claimOnce(file)).toBe(true);
  expect(claimOnce(file)).toBe(false);
  expect(claimOnce(path.join(dir, "missing", "claim"))).toBe(false);
});
