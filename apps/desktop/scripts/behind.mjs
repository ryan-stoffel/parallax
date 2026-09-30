/**
 * Why Update must leave this checkout where it is, for people ("this checkout is on x"), or
 * undefined when it may move to another channel's branch (scripts/channels.mjs). A named branch
 * other than develop is someone's work. A detached HEAD or develop may move, if a remote branch
 * contains HEAD, so that moving loses no local commit. That also lets nightly move back to
 * release, whose branch is behind. Never changes the checkout.
 *
 * @param {Git} git
 * @returns {Promise<string | undefined>}
 */
export async function whyNotMove(git) {
  const branch = (await git(["branch", "--show-current"])).out;
  if (branch && branch !== "develop") return `this checkout is on ${branch}`;
  const containing = await git(["branch", "--remotes", "--contains", "HEAD"]);
  if (containing.code !== 0 || !containing.out)
    return "this checkout has commits that no remote branch contains";
  return undefined;
}

/**
 * How many commits the channel's `branch` on origin has that this checkout lacks, after fetching
 * it, for the sidebar's Update button (scripts/dev.mjs). At least 1 when the tips differ, so
 * switching to a branch this checkout is ahead of is offered too. 0 where Update wouldn't move
 * (`whyNotMove`) and when the fetch fails. Never changes the checkout. `git` runs git with the
 * given arguments and resolves to its exit code and trimmed output.
 *
 * @param {Git} git
 * @param {string} branch
 * @returns {Promise<number>}
 */
export async function commitsBehind(git, branch) {
  if (await whyNotMove(git)) return 0;
  if ((await git(["fetch", "--quiet", "origin", branch])).code !== 0) return 0;
  const counts = await git(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`]);
  if (counts.code !== 0) return 0;
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  return (behind ?? 0) || (ahead ? 1 : 0);
}

/** @typedef {(args: string[]) => Promise<{ code: number | null; out: string }>} Git */
