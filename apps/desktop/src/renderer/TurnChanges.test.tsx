import { expect, test } from "vite-plus/test";

import { fileIcon, iconName } from "./fileIcons";
import { fileTree, type TreeNode } from "./TurnChanges";

const file = (path: string) => ({ path, additions: 1, deletions: 0 });
// Each node as its name, a folder's children indented under it.
const outline = (nodes: TreeNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.name}`,
    ...(n.kind === "dir" ? outline(n.children, depth + 1) : []),
  ]);

test("a turn's files read as a tree: single-child folders joined, folders before files", () => {
  const tree = fileTree([
    file("apps/desktop/src/renderer/index.css"),
    file("apps/desktop/src/renderer/ThreadDetails.tsx"),
    file("apps/desktop/src/main/app.ts"),
    file("README.md"),
    file("docs/a.md"),
  ]);
  expect(outline(tree)).toEqual([
    "apps/desktop/src",
    "  main",
    "    app.ts",
    "  renderer",
    "    index.css",
    "    ThreadDetails.tsx",
    "docs",
    "  a.md",
    "README.md",
  ]);
  expect(tree[0]!.kind === "dir" && tree[0]!.children[1]).toMatchObject({
    path: "apps/desktop/src/renderer",
  });
});

test("a file's icon goes by its name, then its longest known extension", () => {
  expect(iconName("daemon/src/methods/provider_updates.rs")).toBe("rust");
  expect(iconName("src/renderer/TurnChanges.tsx")).toBe("react_ts");
  expect(iconName("src/renderer/TurnChanges.test.tsx")).toBe("test-jsx");
  expect(iconName("src/renderer/parallax.d.ts")).toBe("typescript-def");
  expect(iconName("apps/desktop/package.json")).toBe("nodejs");
  expect(iconName("README.md")).toBe("readme");
  expect(iconName("Dockerfile")).toBe("docker");
  expect(iconName("notes.unknown")).toBeUndefined();
  // A known file's icon is bundled, and a pale one has its light theme version.
  expect(fileIcon("main.rs")?.dark).toMatch(/^data:image\/svg/);
  expect(fileIcon("Cargo.toml")?.light).toMatch(/^data:image\/svg/);
});
