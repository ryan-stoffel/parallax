import { expect, test } from "vitest";

import type { Item } from "../../desktop/src/renderer/transcript";
import { unansweredOf } from "./unanswered";

const user = (key: string, text: string | null, extra: object = {}): Item => ({ kind: "user", key, text, ...extra });
const none = new Map<string, { text: string }>();

test("offers the latest message until the agent answers it", () => {
  const notice: Item = { kind: "notice", key: "n", tone: "info", text: "Retrying" };
  expect(unansweredOf([user("a", "first"), user("b", "second"), notice], none)).toEqual({ key: "b", text: "second" });
  const reply: Item = { kind: "assistant", key: "r", text: "On it" };
  expect(unansweredOf([user("b", "second"), reply], none)).toBeUndefined();
  const call: Item = { kind: "tool", key: "t", callId: "t", name: "Bash" };
  expect(unansweredOf([user("b", "second"), call], none)).toBeUndefined();
});

test("leaves Parallax's and other threads' messages alone", () => {
  expect(unansweredOf([user("w", "wake", { wake: true })], none)).toBeUndefined();
  expect(unansweredOf([user("f", "hi", { from: "run-2" })], none)).toBeUndefined();
});

test("takes the text sent from here when the log has none, without its images' paths", () => {
  const sent = new Map([["turn", { text: "look\n\nAttached files:\n- /tmp/x/image-1.png\n- /tmp/x/notes.md" }]]);
  expect(unansweredOf([user("u", null, { turnId: "turn" })], sent)?.text).toBe("look\n\nAttached files:\n- /tmp/x/notes.md");
  expect(unansweredOf([user("u", null)], sent)).toBeUndefined();
});
