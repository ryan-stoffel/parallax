import path from "node:path";

/** Whether a link the renderer tried to open may go to the system browser: only https. */
export function isOpenableExternally(url: string): boolean {
  return URL.parse(url)?.protocol === "https:";
}

/**
 * The file on this computer a transcript's link names outside its thread's folder, which main
 * shows in Finder or Explorer: an absolute path, or one in the home folder `home` as `~/`.
 * Undefined for anything else, such as a UNC path, which Windows would reach over the network.
 */
export function shownFilePath(value: unknown, home: string): string | undefined {
  if (typeof value !== "string" || /\p{Cc}/u.test(value) || /^[\\/]{2}/.test(value))
    return undefined;
  const file = value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return path.isAbsolute(file) ? path.normalize(file) : undefined;
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
  f: "find",
  g: "findNext",
  p: "print",
  d: "bookmark",
  "1": "tab1",
  "2": "tab2",
  "3": "tab3",
  "4": "tab4",
  "5": "tab5",
  "6": "tab6",
  "7": "tab7",
  "8": "tab8",
  "9": "lastTab",
} as const;

// With Shift as well.
const shiftShortcuts = { r: "hardReload", t: "reopenTab", g: "findPrevious" } as const;

/** A page shortcut a browser tab acts on (main.ts). */
export type BrowserShortcut =
  | (typeof browserShortcuts)[keyof typeof browserShortcuts]
  | (typeof shiftShortcuts)[keyof typeof shiftShortcuts]
  | "nextTab"
  | "previousTab"
  | "history";

/**
 * What a key press in a side panel browser's page does, as Chrome's shortcuts do (PLX-969), or
 * undefined for a press it leaves to the page and the app's menu: Cmd (macOS) or Ctrl (elsewhere)
 * with a key, Shift for a few more, Ctrl+Tab and Ctrl+Shift+Tab, and Cmd+Option+Right and Left on
 * macOS, Ctrl+PageDown and PageUp elsewhere, for the next and previous tab.
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
): BrowserShortcut | undefined {
  if (input.type !== "keyDown") return undefined;
  const mac = platform === "darwin";
  if (input.key === "Tab" && input.control && !input.meta && !input.alt)
    return input.shift ? "previousTab" : "nextTab";
  if (mac && input.meta && input.alt && !input.control && !input.shift) {
    if (input.key === "ArrowRight") return "nextTab";
    if (input.key === "ArrowLeft") return "previousTab";
  }
  if (!mac && input.control && !input.meta && !input.alt && !input.shift) {
    if (input.key === "PageDown") return "nextTab";
    if (input.key === "PageUp") return "previousTab";
  }
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!mod || input.alt) return undefined;
  const key = input.key.toLowerCase();
  // History is Cmd+Y on macOS and Ctrl+H elsewhere, as in Chrome (PLX-976).
  if (key === (mac ? "y" : "h") && !input.shift) return "history";
  if (input.shift) return shiftShortcuts[key as keyof typeof shiftShortcuts];
  return browserShortcuts[key as keyof typeof browserShortcuts];
}

/** Whether a url is a Chrome extension's page, such as its popup (extensions.ts). */
export const isExtensionPage = (url: string) => URL.parse(url)?.protocol === "chrome-extension:";

/**
 * Whether a page may navigate to `url`: the side panel's browser, to any page it may show; the
 * app's own pages, only to reload.
 */
export function mayNavigate(url: string, currentUrl: string, inBrowser: boolean): boolean {
  if (!inBrowser) return isReload(url, currentUrl);
  // An extension's page may go to another of its own pages.
  if (isExtensionPage(url)) return URL.parse(url)?.host === URL.parse(currentUrl)?.host;
  return isBrowsable(url);
}
