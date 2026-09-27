import { expect, test } from "vite-plus/test";

import { isOpenableExternally } from "./links";

test("only https links open in the system browser", () => {
  expect(isOpenableExternally("https://github.com/ryan-stoffel/wisp")).toBe(true);

  for (const url of [
    "http://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "smb://host/share",
    "not a url",
  ]) {
    expect(isOpenableExternally(url), url).toBe(false);
  }
});
