import { describe, expect, it } from "vitest";

import { marks, matchesAll, wordsOf } from "./searchText";

describe("search text", () => {
  it("matches every word in any order and case", () => {
    const words = wordsOf("  Fix  PARALLAX ");
    expect(words).toEqual(["fix", "parallax"]);
    expect(matchesAll("parallax · Fix the sidebar", words)).toBe(true);
    expect(matchesAll("Fix the sidebar", words)).toBe(false);
  });

  it("marks each match, joining ones that overlap", () => {
    expect(marks("Fix the fixture", ["fix"])).toEqual([
      { text: "Fix", hit: true },
      { text: " the ", hit: false },
      { text: "fix", hit: true },
      { text: "ture", hit: false },
    ]);
    expect(marks("sidebar", ["side", "deb"])).toEqual([
      { text: "sideb", hit: true },
      { text: "ar", hit: false },
    ]);
    expect(marks("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });
});
