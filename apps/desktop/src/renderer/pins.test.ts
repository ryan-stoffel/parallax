import { beforeEach, expect, test } from "vite-plus/test";

import {
  addToFolder,
  createFolder,
  entriesOf,
  makeFolder,
  pinLayout,
  placeAt,
  ungroup,
  updateFolder,
  type PinEntry,
} from "./pins";

const rename = (id: string, name: string) => updateFolder(id, { name });

/** The tree `entriesOf` shows for the pins `keys`, as nested arrays of keys and folder names. */
const tree = (keys: string[]) => {
  const draw = (list: PinEntry[]): unknown[] =>
    list.map((e) => (e.kind === "pin" ? e.key : { [e.folder.name]: draw(e.children) }));
  return draw(entriesOf(pinLayout.get(), keys));
};
const pins = ["a", "b", "c", "d"];
const entries = () => entriesOf(pinLayout.get(), pins);
const folderId = (name: string) =>
  Object.entries(pinLayout.get().folders).find(([, f]) => f.name === name)![0];
beforeEach(() => pinLayout.set({ order: [], folders: {} }));

test("pins it doesn't place show last, in order, and a folder of two takes the target's place", () => {
  expect(tree(pins)).toEqual(["a", "b", "c", "d"]);
  rename(makeFolder(entries(), "b", "d"), "Work");
  expect(tree(pins)).toEqual(["a", { Work: ["b", "d"] }, "c"]);
  // A pin filtered out, as by a search, leaves its folder; an empty folder still shows.
  expect(tree(["a", "c"])).toEqual(["a", "c"]);
  rename(createFolder(), "Empty");
  expect(tree(["a", "c"])).toEqual(["a", "c", { Empty: [] }]);
});

test("a folder never moves into itself or a folder inside it", () => {
  rename(makeFolder(entries(), "a", "b"), "Outer");
  rename(createFolder(folderId("Outer")), "Inner");
  const before = pinLayout.get();
  addToFolder(entries(), folderId("Inner"), `folder:${folderId("Outer")}`);
  placeAt(entries(), `folder:${folderId("Outer")}`, `folder:${folderId("Inner")}`, true);
  expect(pinLayout.get()).toEqual(before);
});

test("ungrouping puts what was in a folder, nested folders included, in its place", () => {
  rename(makeFolder(entries(), "b", "c"), "Outer");
  rename(createFolder(folderId("Outer")), "Inner");
  addToFolder(entries(), folderId("Inner"), "d");
  ungroup(entries(), folderId("Outer"));
  expect(tree(pins)).toEqual(["a", "b", "c", { Inner: ["d"] }]);
  expect(Object.values(pinLayout.get().folders).map((f) => f.name)).toEqual(["Inner"]);
});
