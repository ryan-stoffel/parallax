import { expect, test } from "vite-plus/test";

import { pursuedGoal } from "./Goal";
import type { Item } from "./transcript";

const user = (text: string, extra: Partial<Extract<Item, { kind: "user" }>> = {}): Item => ({
  kind: "user",
  key: text,
  text,
  ...extra,
});
const said: Item = { kind: "assistant", key: "a", text: "Goal set: the tests pass" };

test("the goal is the user's latest message's /goal objective", () => {
  expect(pursuedGoal([user("/goal  the tests pass "), said])).toBe("the tests pass");
  expect(pursuedGoal([user("/goal the tests pass"), user("wake", { wake: true })])).toBe(
    "the tests pass",
  );
  expect(pursuedGoal([user("/goal the tests pass"), user("and the lint")])).toBeUndefined();
  expect(pursuedGoal([user("/goal clear")])).toBeUndefined();
  expect(pursuedGoal([user("/goals x"), said])).toBeUndefined();
});
