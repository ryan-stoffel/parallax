/**
 * What Update's answer asks for when the pulled files (repo paths) include some that load only
 * when Parallax starts: new packages, or a change to these scripts or the Vite config. Quitting Parallax
 * stops `pnpm dev`, and reopening it (Parallax.app runs `pnpm dev`) loads them. "" when none do.
 *
 * @param {string[]} changed
 * @returns {string}
 */
export function restartNote(changed) {
  const load = [
    changed.includes("apps/desktop/pnpm-lock.yaml") && "packages",
    changed.some((file) => /^apps\/desktop\/(scripts\/|vite\.config\.ts$)/.test(file)) &&
      "dev scripts",
  ].filter(Boolean);
  return load.length ? `Quit and reopen Parallax to load its new ${load.join(" and ")}.` : "";
}
