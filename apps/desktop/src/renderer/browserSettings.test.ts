import { expect, test } from "vite-plus/test";

import { searchEngineName, searchUrlFor } from "./browserSettings";

test("the address bar searches with the picked engine, and Google for one it doesn't know", () => {
  expect(searchUrlFor("duckduckgo", "rust & go")).toBe("https://duckduckgo.com/?q=rust%20%26%20go");
  expect(searchUrlFor("startpage", "a")).toBe("https://www.startpage.com/sp/search?q=a");
  expect(searchUrlFor("gone", "a")).toBe("https://www.google.com/search?q=a");
  expect(searchEngineName("kagi")).toBe("Kagi");
  expect(searchEngineName("gone")).toBe("Google");
});
