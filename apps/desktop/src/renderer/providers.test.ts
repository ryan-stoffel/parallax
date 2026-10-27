import { expect, test } from "vite-plus/test";

import { portableHome } from "./providers";

test.each([
  ["/Users/ryan/.codex-work", "~/.codex-work"],
  ["/home/ryan/accounts/work", "~/accounts/work"],
  ["C:\\Users\\ryan\\.codex-work", "~/.codex-work"],
  ["/Users/ryan", "~"],
  ["/opt/codex-work", "/opt/codex-work"],
])("a copied home %s goes as %s (PLX-1065)", (home, copied) => {
  expect(portableHome(home)).toBe(copied);
});
