import { expect, test } from "vite-plus/test";

import { tint } from "./appearance";

test("the theme covers less of an OS blur, which has a tint of its own", () => {
  expect(tint("clear", 75, "darwin")).toBe(75);
  expect(tint("blur", 75, "darwin")).toBe(30);
  expect(tint("blur", 75, "win32")).toBe(30);
  // Linux's blur is the compositor's, of a clear window.
  expect(tint("blur", 75, "linux")).toBe(75);
});
