import { expect, test } from "vite-plus/test";

import { countIn, findBookmark, folderList, moved, removedFolder, withFolder } from "./Bookmarks";

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
