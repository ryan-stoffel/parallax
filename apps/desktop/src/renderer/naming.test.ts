import { expect, test } from "vite-plus/test";

import { slugify } from "./naming";

test("a slug is the first four words, lowercase, joined by hyphens", () => {
  expect(slugify("Fix the login page crash, again please")).toBe("fix-the-login-page");
  expect(slugify("  Add v2 API!  ")).toBe("add-v2-api");
  expect(slugify("Ünïcode? Yes")).toBe("n-code-yes");
  expect(slugify("a".repeat(60))).toBe("a".repeat(40));
  expect(slugify("!!!")).toBeUndefined();
});
