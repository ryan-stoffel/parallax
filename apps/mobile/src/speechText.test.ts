import { describe, expect, it } from "vitest";

import { Heard } from "./speechText";

describe("Heard", () => {
  it("adds finished phrases and only the latest unfinished one", () => {
    const heard = new Heard();
    heard.add("fix", false);
    heard.add("fix the bug", false);
    heard.add("fix the bug", true);
    heard.add("then", false);
    heard.add("then ship it", false);
    expect(heard.text).toBe("fix the bug then ship it");
  });

  it("keeps the phrase an empty final result confirms", () => {
    const heard = new Heard();
    heard.add("fix the bug", false);
    heard.add("", true);
    expect(heard.text).toBe("fix the bug");
  });
});
