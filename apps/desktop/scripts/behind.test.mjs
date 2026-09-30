import { expect, test } from "vite-plus/test";

import { commitsBehind } from "./behind.mjs";

/** A git that answers each command, by its first argument, from `answers`; unlisted ones succeed. */
const fakeGit = (answers) => {
  const calls = [];
  const git = async (args) => {
    calls.push(args[0]);
    return { code: 0, out: "", ...answers[args[0]] };
  };
  return { git, calls };
};

test("an update is the commits develop has, on develop or a detached HEAD", async () => {
  const counts = { "rev-list": { out: "0\t3" } };
  expect(await commitsBehind(fakeGit({ branch: { out: "develop" }, ...counts }).git)).toBe(3);
  expect(await commitsBehind(fakeGit({ branch: { out: "" }, ...counts }).git)).toBe(3);
  expect(await commitsBehind(fakeGit({ "rev-list": { out: "0\t0" } }).git)).toBe(0);
});

test("no update where Update wouldn't pull one", async () => {
  // Another branch is someone's work: no fetch at all.
  const other = fakeGit({ branch: { out: "feature/RYA-1-x" } });
  expect(await commitsBehind(other.git)).toBe(0);
  expect(other.calls).toEqual(["branch"]);
  // Offline: nothing, until the next check.
  expect(await commitsBehind(fakeGit({ fetch: { code: 128 } }).git)).toBe(0);
  // Local commits: a fast-forward can't take develop's.
  expect(await commitsBehind(fakeGit({ "rev-list": { out: "2\t3" } }).git)).toBe(0);
});
