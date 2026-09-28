/** Whether a link the renderer tried to open may go to the system browser: only https. */
export function isOpenableExternally(url: string): boolean {
  return URL.parse(url)?.protocol === "https:";
}

/**
 * Whether a navigation the renderer started may proceed: only a reload of the page it shows,
 * such as `location.reload()` or Vite's full reload in dev. That page is always the app's own,
 * since every other navigation is blocked.
 */
export function isReload(url: string, currentUrl: string): boolean {
  return url === currentUrl;
}
