// Every native function index.ts calls exists on both platforms. One missing on one of them throws
// only when the app calls it there, as Android's `relayClosedWith` once did on each relay socket's end.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");

/** The functions index.ts declares on the native module, from its `requireNativeModule<{…}>`. */
function declared(): string[] {
  const block = read("index.ts").match(/requireNativeModule<\{([\s\S]*?)\n\}>/)?.[1] ?? "";
  return [...block.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]!).filter((name) => name !== "addListener");
}

test.each([
  ["Swift", "ios/PinnedTlsModule.swift"],
  ["Kotlin", "android/src/main/java/dev/parallax/pinnedtls/PinnedTlsModule.kt"],
])("the %s module defines every function index.ts calls", (_, path) => {
  const names = declared();
  expect(names).toContain("relayClosedWith");
  const source = read(path);
  const missing = names.filter((name) => !source.includes(`Function("${name}")`));
  expect(missing).toEqual([]);
});
