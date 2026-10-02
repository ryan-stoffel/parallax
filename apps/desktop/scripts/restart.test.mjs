import { expect, test } from "vite-plus/test";

import { restartNote } from "./restart.mjs";

test("Update asks to reopen Parallax only for what loads when it starts", () => {
  expect(restartNote(["apps/desktop/src/renderer/App.tsx", "daemon/src/main.rs"])).toBe("");
  expect(restartNote(["apps/desktop/pnpm-lock.yaml"])).toBe(
    "Quit and reopen Parallax to load its new packages.",
  );
  expect(restartNote(["apps/desktop/scripts/behind.mjs"])).toBe(
    "Quit and reopen Parallax to load its new dev scripts.",
  );
  expect(restartNote(["apps/desktop/vite.config.ts", "apps/desktop/pnpm-lock.yaml"])).toBe(
    "Quit and reopen Parallax to load its new packages and dev scripts.",
  );
});
