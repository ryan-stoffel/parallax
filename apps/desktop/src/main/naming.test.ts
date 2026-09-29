import { expect, test } from "vite-plus/test";

import { cleanTitle, fallbackName, slugify } from "./naming";

test("a slug is the first four words, lowercase, joined by hyphens", () => {
  expect(slugify("Fix the login page crash, again please")).toBe("fix-the-login-page");
  expect(slugify("  Add v2 API!  ")).toBe("add-v2-api");
  expect(slugify("Ünïcode? Yes")).toBe("n-code-yes");
  expect(slugify("a".repeat(60))).toBe("a".repeat(40));
  expect(slugify("!!!")).toBeUndefined();
});

test("a model's reply is a title only when it looks like one", () => {
  expect(cleanTitle('"Fix flaky cancel test."\nSure!')).toBe("Fix flaky cancel test");
  expect(cleanTitle("Hello! How can I assist you today?")).toBeUndefined();
  expect(cleanTitle("one two three four five six seven eight nine")).toBeUndefined();
  expect(cleanTitle("  ")).toBeUndefined();
});

test("without the model, a thread keeps its prompt as its title and names its branch from it", () => {
  expect(fallbackName("Add a README\nthat explains the build")).toEqual({
    slug: "add-a-readme-that",
  });
});
