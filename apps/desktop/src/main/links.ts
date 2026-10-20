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

// Chrome's page shortcuts, by key, with Cmd on macOS and Ctrl elsewhere.
const browserShortcuts = {
  r: "reload",
  "[": "back",
  "]": "forward",
  "=": "zoomIn",
  "-": "zoomOut",
  "0": "resetZoom",
  l: "address",
  t: "newTab",
  w: "closeTab",
} as const;

/**
 * What Cmd (macOS) or Ctrl (elsewhere) with a key does in a side panel browser's page, as Chrome
 * does, or undefined for a press it leaves to the page and the app's menu.
 */
export function browserShortcut(
  input: {
    type: string;
    key: string;
    meta: boolean;
    control: boolean;
    alt: boolean;
    shift: boolean;
  },
  platform: NodeJS.Platform,
): (typeof browserShortcuts)[keyof typeof browserShortcuts] | "hardReload" | undefined {
  const mod = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (input.type !== "keyDown" || !mod || input.alt) return undefined;
  // Shift makes Reload Chrome's hard reload, and leaves every other key to the page.
  if (input.shift) return input.key.toLowerCase() === "r" ? "hardReload" : undefined;
  return browserShortcuts[input.key.toLowerCase() as keyof typeof browserShortcuts];
}

/**
 * Whether a page may navigate to `url`: the side panel's browser, to any page it may show; the
 * app's own pages, only to reload.
 */
export function mayNavigate(url: string, currentUrl: string, inBrowser: boolean): boolean {
  return inBrowser ? isBrowsable(url) : isReload(url, currentUrl);
}
