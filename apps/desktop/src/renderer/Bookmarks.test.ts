import { expect, test } from "vite-plus/test";

import { toggled } from "./Bookmarks";

test("the star adds a page's bookmark at the end, or removes it when it has one", () => {
  const a = { url: "https://a.com/", title: "A" };
  const icon = "data:image/png;base64,AAAA";
  const list = toggled([a], { url: "https://b.com/", title: "B", icon });
  expect(list).toEqual([a, { url: "https://b.com/", title: "B", icon }]);
  expect(toggled(list, { url: "https://a.com/" })).toEqual([list[1]]);
  // A large icon isn't kept.
  expect(toggled([], { url: "https://c.com/", icon: `${icon}${"A".repeat(20_000)}` })).toEqual([
    { url: "https://c.com/" },
  ]);
});
