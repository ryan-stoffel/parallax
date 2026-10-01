import { expect, test } from "vite-plus/test";

import { resolveTheme } from "./theme";

test("system follows the OS, and an explicit choice ignores it", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
});
