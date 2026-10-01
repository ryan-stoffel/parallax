import { useLayoutEffect, useState } from "react";

import { THEME_PREFERENCES, type ThemePreference } from "../preload/bridge";

export type Theme = "dark" | "light";

const STORAGE_KEY = "wisp.theme";
const darkQuery = "(prefers-color-scheme: dark)";

/** The theme to paint: the user's choice, or the OS's when the choice is "system". */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

function readPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return THEME_PREFERENCES.find((p) => p === stored) ?? "system";
}

/** Paints `preference` now: the `dark` class on <html> switches index.css's tokens. */
export function applyTheme(preference = readPreference()) {
  const theme = resolveTheme(preference, matchMedia(darkQuery).matches);
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * The Appearance setting, applied to the document and to Electron's
 * `nativeTheme`. Call once, at the app root.
 */
export function useThemePreference() {
  const [preference, setPreference] = useState(readPreference);

  // Layout effect, so the first paint already has the right theme.
  useLayoutEffect(() => {
    localStorage.setItem(STORAGE_KEY, preference);
    // Scrollbars, native controls, the Linux title bar, and Windows' window
    // buttons (main.ts).
    window.wisp.setThemeSource(preference);

    const media = matchMedia(darkQuery);
    const apply = () => applyTheme(preference);
    apply();
    // Fires when the OS theme changes, and once main applies `themeSource`.
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return [preference, setPreference] as const;
}
