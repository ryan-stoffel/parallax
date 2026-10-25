import { expect, test } from "vitest";

import { byName, replaceSlash, slashAt } from "./slash";

test("slashAt finds a / at the start or after a space, up to the cursor", () => {
  expect(slashAt("/rev", 4)).toEqual({ query: "rev", from: 0, to: 4 });
  expect(slashAt("please /", 8)).toEqual({ query: "", from: 7, to: 8 });
  expect(slashAt("a/b", 3)).toBeUndefined();
  expect(slashAt("/review now", 11)).toBeUndefined();
  expect(slashAt("/review now", 7)).toEqual({ query: "review", from: 0, to: 7 });
});

test("byName puts names that start with the query first", () => {
  const names = ["code-review", "review", "simplify"];
  expect(byName(names, "rev", (n) => n)).toEqual(["review", "code-review"]);
  expect(byName(names, "", (n) => n)).toEqual(names);
});

test("replaceSlash puts the command in and the cursor after it", () => {
  expect(replaceSlash("hi /re there", { query: "re", from: 3, to: 6 }, "/review ")).toEqual({
    text: "hi /review  there",
    cursor: 11,
  });
});
