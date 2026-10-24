import { expect, test } from "vite-plus/test";

import {
  countIn,
  findBookmark,
  folderList,
  moved,
  removedFolder,
  toggled,
  withFolder,
  withIcon,
  type BookmarkNode,
} from "./Bookmarks";

const icon = "data:image/png;base64,AAAA";

test("the star adds a page's bookmark at the bar's end, or removes it wherever it is", () => {
  const a = { url: "https://a.com/", title: "A" };
  const list = toggled([a], { url: "https://b.com/", title: "B", icon });
  expect(list).toEqual([a, { url: "https://b.com/", title: "B", icon }]);
  const tree: BookmarkNode[] = [{ id: "f", title: "Work", children: [a] }];
  expect(toggled(tree, a)).toEqual([{ id: "f", title: "Work", children: [] }]);
  // A large icon isn't kept.
  expect(toggled([], { url: "https://c.com/", icon: `${icon}${"A".repeat(20_000)}` })).toEqual([
    { url: "https://c.com/" },
  ]);
});

test("bookmarks move into folders, nested ones too, and a folder goes with what it holds", () => {
  const a = { url: "https://a.com/" };
  const [withWork, work] = withFolder([a], "Work");
  const [nested, docs] = withFolder(withWork, "Docs", work);
  const tree = moved(nested, a.url, docs);
  expect(findBookmark(tree, a.url)).toEqual({ bookmark: a, folder: docs });
  expect(folderList(tree)).toEqual([
    { id: work, title: "Work", depth: 0 },
    { id: docs, title: "Docs", depth: 1 },
  ]);
  // Back to the bar.
  expect(findBookmark(moved(tree, a.url, undefined), a.url)).toEqual({ bookmark: a });
  expect(countIn(tree, work)).toBe(1);
  expect(countIn(tree, "missing")).toBe(-1);
  expect(removedFolder(tree, work)).toEqual([]);
});

test("a bookmark saved before its page's icon arrived gets it later", () => {
  const tree: BookmarkNode[] = [
    { id: "f", title: "F", children: [{ url: "https://a.com/" }] },
    { url: "https://b.com/", icon: "data:old" },
  ];
  expect(findBookmark(withIcon(tree, "https://a.com/", icon), "https://a.com/")?.bookmark).toEqual({
    url: "https://a.com/",
    icon,
  });
  // One that has an icon keeps it, and an icon too large to keep changes nothing, both handing
  // back the same tree, so setting it doesn't loop.
  expect(withIcon(tree, "https://b.com/", icon)).toBe(tree);
  expect(withIcon(tree, "https://a.com/", `${icon}${"A".repeat(20_000)}`)).toBe(tree);
});
