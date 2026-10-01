import { FolderKanban } from "lucide-react";
import { expect, test } from "vite-plus/test";

import { defaultIcon, iconColors, iconLook, projectIcons } from "./projectIcons";

const pascal = (name: string) =>
  name
    .split("-")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");

test("about 150 icons, each under its own Lucide name, which wispd accepts as a key", () => {
  expect(projectIcons.length).toBeGreaterThanOrEqual(140);
  expect(projectIcons.length).toBeLessThanOrEqual(160);
  expect(new Set(projectIcons.map((i) => i.name)).size).toBe(projectIcons.length);
  expect(new Set(projectIcons.map((i) => i.label)).size).toBe(projectIcons.length);
  for (const i of projectIcons) {
    expect(i.name).toMatch(/^[a-z0-9-]{1,64}$/);
    // Lucide names each glyph after its canonical name, so an alias or a mix-up shows here.
    expect(i.Icon.displayName).toBe(pascal(i.name));
  }
  expect(projectIcons[0]!.name).toBe(defaultIcon.name);
  expect(projectIcons.find((i) => i.name === "folder-git-2")?.label).toBe("Folder git");
});

test("the accent comes first with no key, then nine named colors, each a palette token", () => {
  expect(iconColors[0]).toEqual({ label: "Accent", text: "text-accent", fill: "bg-accent" });
  const named = iconColors.slice(1);
  expect(named).toHaveLength(9);
  for (const c of named) {
    expect(c.key).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(c.text).toBe(`text-project-${c.key}`);
    expect(c.fill).toBe(`bg-project-${c.key}`);
  }
});

test("an icon draws its glyph in its color, and falls back to FolderKanban and the accent on its own", () => {
  const rocket = projectIcons.find((i) => i.name === "rocket")!.Icon;
  expect(iconLook({ name: "rocket", color: "green" })).toEqual({
    Icon: rocket,
    color: "text-project-green",
  });
  expect(iconLook(undefined)).toEqual({ Icon: FolderKanban, color: "text-accent" });
  expect(iconLook({ name: "rocket" })).toEqual({ Icon: rocket, color: "text-accent" });
  expect(iconLook({ name: "not-an-icon", color: "green" })).toEqual({
    Icon: FolderKanban,
    color: "text-project-green",
  });
  expect(iconLook({ name: "rocket", color: "chartreuse" })).toEqual({
    Icon: rocket,
    color: "text-accent",
  });
});
