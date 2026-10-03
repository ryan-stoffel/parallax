import { expect, test } from "vite-plus/test";

import { commitsBehind, whyNotMove } from "./behind.mjs";
import { branchOf } from "./channels.mjs";

/**
 * A git that answers each command from `answers`, by its first two arguments for `branch` and its
 * first for the rest. Unlisted ones succeed: detached, on a remote branch, level with the fetched one.
 */
const answersByDefault = {
  "branch --show-current": { out: "" },
  "branch --remotes": { out: "origin/main" },
  "rev-list": { out: "0\t0" },
};
const fakeGit = (answers = {}) => {
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(" "));
    const key = args[0] === "branch" ? `branch ${args[1]}` : args[0];
    return { code: 0, out: "", ...answersByDefault[key], ...answers[key] };
  };
  return { git, calls };
};
const onBranch = (out) => ({ "branch --show-current": { out } });

test("channels name their branches, and nothing else is a channel", () => {
  expect(branchOf("nightly")).toBe("main");
  expect(branchOf("release")).toBe("main");
  for (const other of ["stable", "constructor", "", 3, undefined]) {
    expect(branchOf(other)).toBeUndefined();
  }
});

test("an update is the commits main has, on main or a detached HEAD", async () => {
  const counts = { "rev-list": { out: "0\t3" } };
  const trunk = fakeGit({ ...counts, ...onBranch("main") });
  expect(await commitsBehind(trunk.git, "main")).toBe(3);
  expect(trunk.calls).toContain("fetch --quiet origin main");
  expect(trunk.calls).toContain("rev-list --left-right --count HEAD...origin/main");
  expect(await commitsBehind(fakeGit(counts).git, "main")).toBe(3);
  expect(await commitsBehind(fakeGit().git, "main")).toBe(0);
});

test("a branch this checkout is ahead of is still offered, so a move backward is too", async () => {
  expect(await commitsBehind(fakeGit({ "rev-list": { out: "5\t0" } }).git, "main")).toBe(1);
  // Diverged tips: the switch brings the commits main has.
  expect(await commitsBehind(fakeGit({ "rev-list": { out: "2\t3" } }).git, "main")).toBe(3);
});

test("no update where Update wouldn't move the checkout", async () => {
  // Another branch is someone's work: no fetch at all.
  const other = fakeGit(onBranch("feature/RYA-1-x"));
  expect(await commitsBehind(other.git, "main")).toBe(0);
  expect(other.calls).toEqual(["branch --show-current"]);
  expect(await whyNotMove(other.git)).toBe("this checkout is on feature/RYA-1-x");
  // Local commits that no remote branch has would be lost by the move.
  const unpushed = fakeGit({ "branch --remotes": { out: "" }, "rev-list": { out: "0\t3" } });
  expect(await whyNotMove(unpushed.git)).toMatch(/no remote branch/);
  expect(await commitsBehind(unpushed.git, "main")).toBe(0);
  // Offline: nothing, until the next check.
  expect(await commitsBehind(fakeGit({ fetch: { code: 128 } }).git, "main")).toBe(0);
  // Detached, main, and a remote branch containing HEAD: free to move. develop is not.
  expect(await whyNotMove(fakeGit().git)).toBeUndefined();
  expect(await whyNotMove(fakeGit(onBranch("main")).git)).toBeUndefined();
  expect(await whyNotMove(fakeGit(onBranch("develop")).git)).toBe("this checkout is on develop");
});
