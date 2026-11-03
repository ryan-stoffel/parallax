import { expect, test } from "vite-plus/test";

import licenses from "./licenses.generated.json";

// If this fails, run `node scripts/licenses.mjs`.
test("the license list has what ships, and each package's text is in it", () => {
  const names = (group: string) =>
    licenses.packages.filter((p) => p.group === group).map((p) => p.name);
  expect(names("App")).toEqual(expect.arrayContaining(["react", "electron", "lucide-react"]));
  expect(names("plxd")).toEqual(expect.arrayContaining(["tokio", "rusqlite"]));
  expect(names("Sidecars")).toContain("@anthropic-ai/claude-agent-sdk");
  for (const p of licenses.packages)
    for (const i of p.texts) expect(licenses.texts[i], p.name).toBeTruthy();
});
