import { expect, test } from "vite-plus/test";

import { suggestionsFor, type Suggestion } from "./addressSuggestions";
import type { BookmarkNode } from "./Bookmarks";
import type { Visit } from "./browserHistory";

const search: Suggestion = {
  kind: "search",
  url: "https://www.google.com/search?q=git",
  title: "git",
};

test("what Enter does comes first, then bookmarks, then pages by visits, then how lately", () => {
  const bookmarks: BookmarkNode[] = [
    { id: "f", title: "Work", children: [{ url: "https://gitlab.com/", title: "GitLab" }] },
    { url: "https://example.com/", title: "Example" },
  ];
  const visits: Visit[] = [
    { url: "https://docs.github.com/", title: "GitHub Docs", time: 1 },
    { url: "https://github.com/", title: "GitHub", time: 2 },
    { url: "https://github.com/", title: "GitHub", time: 3 },
    { url: "https://gitlab.com/", title: "GitLab", time: 4 },
    { url: "https://example.com/", title: "Example", time: 5 },
  ];
  expect(suggestionsFor("git", search, bookmarks, visits).map((s) => [s.kind, s.url])).toEqual([
    ["search", search.url],
    ["bookmark", "https://gitlab.com/"],
    // github.com's host starts with what's typed, so it beats docs.github.com.
    ["history", "https://github.com/"],
    ["history", "https://docs.github.com/"],
  ]);
});

test("every word must match, nothing typed suggests nothing, and at most six follow Enter's", () => {
  const visits = Array.from({ length: 10 }, (_, i): Visit => ({
    url: `https://a.com/${i}`,
    time: i,
  }));
  expect(suggestionsFor("a.com", search, [], visits)).toHaveLength(7);
  expect(suggestionsFor("a.com 3", search, [], visits).map((s) => s.url)).toEqual([
    search.url,
    "https://a.com/3",
  ]);
  expect(suggestionsFor("  ", search, [], visits)).toEqual([]);
});
