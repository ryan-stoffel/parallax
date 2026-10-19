import { expect, test } from "vite-plus/test";

import { searchSettings } from "./search";

const titles = (query: string) => searchSettings(query).map((r) => r.title);

test("a word from a setting's title, keywords, or description finds it, best match first", () => {
  expect(titles("time")[0]).toBe("Time format");
  expect(titles("clock")[0]).toBe("Time format");
  expect(titles("ghostty")[0]).toBe("Terminal");
  expect(titles("dark mode")[0]).toBe("Color scheme");
  expect(titles("toast")).toContain("In-app notifications");
  // A section by its name comes before settings that only mention it.
  expect(titles("appearance")[0]).toBe("Appearance");
});

test("prefixes, run-together words, and small typos still find a setting", () => {
  expect(titles("notif")).toContain("System notifications");
  expect(titles("notifcations")).toContain("System notifications");
  expect(titles("darkmode")[0]).toBe("Color scheme");
  expect(titles("worktre")).toContain("Clean up merged worktrees");
  // Not when the word matches as typed: "clock" isn't "block".
  expect(titles("clock")).toEqual(["Time format"]);
});

test("every typed word has to match", () => {
  expect(titles("send shortcut")[0]).toBe("Send shortcut");
  expect(titles("ghostty zebra")).toEqual([]);
});

test("a path lists sections, then a section's settings, and names each setting's place", () => {
  expect(titles("/")).toHaveLength(11);
  expect(titles("/gen")).toEqual(["General"]);
  expect(searchSettings("/general")[0]).toMatchObject({ section: "general", path: "/general" });
  const general = searchSettings("/general/");
  expect(general.every((r) => r.section === "general")).toBe(true);
  expect(general[0]!.path).toBe("/general/open-folders-in");
  expect(searchSettings("/general/time")[0]).toMatchObject({
    title: "Time format",
    path: "/general/time-format",
    anchor: "time-format",
    place: "General › Preferences",
  });
  expect(searchSettings("/source-control")[0]!.section).toBe("sourceControl");
  expect(titles("/nowhere/time")).toEqual([]);
});
