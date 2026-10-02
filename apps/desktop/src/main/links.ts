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

/** Whether the side panel's browser (Browser.tsx) may show a page: only http and https. */
export function isBrowsable(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

/**
 * Whether a page may navigate to `url`: the side panel's browser, to any page it may show; the
 * app's own pages, only to reload.
 */
export function mayNavigate(url: string, currentUrl: string, inBrowser: boolean): boolean {
  return inBrowser ? isBrowsable(url) : isReload(url, currentUrl);
}
