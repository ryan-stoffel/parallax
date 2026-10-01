import type { BrowserWindowConstructorOptions, TitleBarOverlay } from "electron";

// The app's colors that native UI has to match: --background and --foreground
// in the renderer's index.css.
const colors = {
  dark: { background: "#0d0d0f", foreground: "#ececef" },
  light: { background: "#ffffff", foreground: "#18181b" },
};

/** The window's color before the renderer paints. */
export const windowBackground = (dark: boolean) => colors[dark ? "dark" : "light"].background;

/**
 * Windows' minimize, maximize and close buttons, drawn over the right end of the
 * app's 52px top row (`h-13` in ui.tsx) with the theme's foreground. Their
 * background is the theme's, fully transparent: whichever row is under them
 * (the main pane's, or the side panel's darker one) shows through, and Electron
 * still shades hovered buttons from its RGB. Undefined off Windows.
 */
export function titleBarOverlay(platform: string, dark: boolean): TitleBarOverlay | undefined {
  if (platform !== "win32") return undefined;
  const { background, foreground } = colors[dark ? "dark" : "light"];
  return { color: `${background}00`, symbolColor: foreground, height: 52 };
}

/**
 * How the window's frame looks. macOS: no title bar, the traffic lights inset
 * over the top row. Windows: no title bar either, just the buttons in an overlay
 * that follows the theme, since the native one takes the accent color when
 * "Show accent color on title bars" is on. Both make the top row draggable
 * (index.css). Linux keeps the native frame, which follows nativeTheme, and
 * hides the menu bar until Alt.
 */
export function frameOptions(platform: string, dark: boolean): BrowserWindowConstructorOptions {
  if (platform === "darwin")
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 19 } };
  const overlay = titleBarOverlay(platform, dark);
  if (overlay) return { titleBarStyle: "hidden", titleBarOverlay: overlay };
  return { autoHideMenuBar: true };
}
