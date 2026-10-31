// @vitest-environment happy-dom
import { afterEach, expect, test } from "vite-plus/test";

import { legacyMode, readMode } from "./sidebarPrefs";

afterEach(() => localStorage.clear());

test("a stored mode reads under any name it had: Classic as Inbox, Beta and Folders as Traditional", () => {
  expect(readMode("inbox")).toBe("inbox");
  expect(readMode("classic")).toBe("inbox");
  expect(readMode("traditional")).toBe("traditional");
  expect(readMode("beta")).toBe("traditional");
  expect(readMode("folders")).toBe("traditional");
  expect(readMode("compact")).toBeUndefined();
  expect(readMode(true)).toBeUndefined();
});

test("before 0094, Settings › Beta's sidebar switch on reads as Traditional, and off or unset as Inbox", () => {
  expect(legacyMode()).toBe("inbox");
  localStorage.setItem("parallax.beta.newSidebar", "true");
  expect(legacyMode()).toBe("traditional");
  localStorage.setItem("parallax.beta.newSidebar", "false");
  expect(legacyMode()).toBe("inbox");
});
