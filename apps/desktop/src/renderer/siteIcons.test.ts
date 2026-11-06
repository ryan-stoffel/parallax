import { expect, test } from "vite-plus/test";

import { prNumber } from "./github";
import { linkSite } from "./siteIcons";

test("a link's icon comes from its domain, never its whole host, and only over https", () => {
  expect(linkSite("https://linear.app/team/issue/PLX-1")).toBe("https://linear.app");
  expect(linkSite("https://what-it-read.evil.dev/x")).toBe("https://evil.dev");
  expect(linkSite("https://user@docs.github.com/en")).toBe("https://github.com");
  for (const url of ["http://linear.app", "https://127.0.0.1:8080", "https://[::1]/", "src/a.ts"])
    expect(linkSite(url), url).toBe("");
});

test("a pull request link's number, on any of its tabs, and no other link's", () => {
  expect(prNumber("https://github.com/o/r/pull/765")).toBe("765");
  expect(prNumber("https://github.com/o/r/pull/765/files#diff-1")).toBe("765");
  for (const url of [
    "https://github.com/o/r/issues/765",
    "https://github.com/o/r/pull/765abc",
    "https://evil.dev/o/r/pull/765",
  ])
    expect(prNumber(url), url).toBeUndefined();
});
