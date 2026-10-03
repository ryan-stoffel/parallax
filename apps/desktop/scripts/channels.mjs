/** The branch a dev checkout's Update follows. Nightly and stable are tags on main (0051). */
export const channelBranches = { nightly: "main", release: "main" };

/**
 * The branch a channel follows, or undefined for anything that isn't one. The app sends the
 * channel to scripts/dev.mjs, so it is checked here.
 *
 * @param {unknown} channel
 * @returns {string | undefined}
 */
export function branchOf(channel) {
  return typeof channel === "string" && Object.hasOwn(channelBranches, channel)
    ? channelBranches[/** @type {keyof typeof channelBranches} */ (channel)]
    : undefined;
}
