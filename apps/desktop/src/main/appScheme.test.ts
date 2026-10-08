import path from "node:path";
import { expect, test } from "vite-plus/test";

import { rendererFile } from "./appScheme";

test("rendererFile serves only files inside the renderer's folder", () => {
  const dir = path.join("/app", "renderer");
  expect(rendererFile("app://renderer/index.html", dir)).toBe(path.join(dir, "index.html"));
  expect(rendererFile("app://renderer/assets/a%20b.js", dir)).toBe(path.join(dir, "assets/a b.js"));
  expect(rendererFile("app://renderer/../main/main.cjs", dir)).toBe(
    path.join(dir, "main/main.cjs"),
  );
  expect(rendererFile("app://renderer/..%2fmain%2fmain.cjs", dir)).toBeUndefined();
});
