import { expect, test } from "vite-plus/test";

import { fallbackName, parseName, slugify } from "./naming";

test("a slug is the first four words, lowercase, joined by hyphens", () => {
  expect(slugify("Fix the login page crash, again please")).toBe("fix-the-login-page");
  expect(slugify("  Add v2 API!  ")).toBe("add-v2-api");
  expect(slugify("Ünïcode? Yes")).toBe("n-code-yes");
  expect(slugify("a".repeat(60))).toBe("a".repeat(40));
  expect(slugify("!!!")).toBeUndefined();
});

test("a model's reply is a title and a branch", () => {
  expect(parseName("Title: Fix flaky cancel test\nBranch: cancel-test-windows")).toEqual({
    title: "Fix flaky cancel test",
    slug: "cancel-test-windows",
  });
  expect(parseName("Title: Fix the GitHub sign in flow for good\nBranch: github-sign-in")).toEqual({
    title: "Fix the GitHub sign in flow",
    slug: "github-sign-in",
  });
  expect(parseName("Hello! How can I assist you today?")).toBeUndefined();
  expect(parseName("Title: Only a title")).toBeUndefined();
});

test("without the model, a thread keeps its prompt as its title and names its branch from it", () => {
  expect(fallbackName("Add a README\nthat explains the build")).toEqual({
    slug: "add-a-readme-that",
  });
});
