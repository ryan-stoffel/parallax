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

test("a section's name finds it first, and a setting says where it is", () => {
  expect(searchSettings("general")[0]).toEqual({ section: "general", title: "General" });
  expect(searchSettings("time")[0]).toEqual({
    section: "general",
    title: "Time format",
    place: "General › Preferences",
    anchor: "time-format",
  });
});
