import { expect, test } from "vite-plus/test";
import { voiceText } from "./voiceText";
test("dictation separates adjacent draft words and preserves whitespace", () => {
  expect(voiceText("world", "o", "")).toBe(" world");
  expect(voiceText("new", " ", " ")).toBe("new");
  expect(voiceText("new", "a", "b")).toBe(" new ");
  expect(voiceText("world", "\n", "")).toBe("world");
  expect(voiceText("**literal**", "", "")).toBe("**literal**");
});
