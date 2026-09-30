/**
 * How many commits origin/develop has that this checkout lacks, after fetching develop, for the
 * sidebar's Update button (scripts/dev.mjs). 0 where Update wouldn't pull them: on a branch other
 * than develop (a detached HEAD is fine), when the fetch fails, or when local commits stop a
 * fast-forward. Never changes the checkout. `git` runs git with the given arguments and resolves
 * to its exit code and trimmed output.
 *
 * @param {(args: string[]) => Promise<{ code: number | null; out: string }>} git
 * @returns {Promise<number>}
 */
export async function commitsBehind(git) {
  const branch = (await git(["branch", "--show-current"])).out;
  if (branch && branch !== "develop") return 0;
  if ((await git(["fetch", "--quiet", "origin", "develop"])).code !== 0) return 0;
  const counts = await git(["rev-list", "--left-right", "--count", "HEAD...origin/develop"]);
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  return counts.code === 0 && ahead === 0 ? (behind ?? 0) : 0;
}
