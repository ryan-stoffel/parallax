import { expect, test } from "vite-plus/test";

import { commitsBehind, whyNotMove } from "./behind.mjs";

/**
 * A git that answers each command from `answers`, by its first two arguments for `branch` and its
 * first for the rest. Unlisted ones succeed: detached, on a remote branch, level with the fetched one.
 */
const answersByDefault = {
  "branch --show-current": { out: "" },
  "branch --remotes": { out: "origin/main" },
  "rev-list": { out: "0\t0" },
};
const fakeGit =
  (answers = {}) =>
  async (args) => {
    const key = args[0] === "branch" ? `branch ${args[1]}` : args[0];
    return { code: 0, out: "", ...answersByDefault[key], ...answers[key] };
  };
const onBranch = (out) => ({ "branch --show-current": { out } });

test("no update where Update wouldn't move the checkout", async () => {
  // Another branch is someone's work.
  const other = fakeGit(onBranch("feature/PLX-1-x"));
  expect(await commitsBehind(other, "main")).toBe(0);
  expect(await whyNotMove(other)).toBe("this checkout is on feature/PLX-1-x");
  // Local commits that no remote branch has would be lost by the move.
  const unpushed = fakeGit({ "branch --remotes": { out: "" }, "rev-list": { out: "0\t3" } });
  expect(await whyNotMove(unpushed)).toMatch(/no remote branch/);
  expect(await commitsBehind(unpushed, "main")).toBe(0);
  // Offline: nothing, until the next check.
  expect(await commitsBehind(fakeGit({ fetch: { code: 128 } }), "main")).toBe(0);
  // Detached, main, and a remote branch containing HEAD: free to move. develop is not.
  expect(await whyNotMove(fakeGit())).toBeUndefined();
  expect(await whyNotMove(fakeGit(onBranch("main")))).toBeUndefined();
  expect(await whyNotMove(fakeGit(onBranch("develop")))).toBe("this checkout is on develop");
});
