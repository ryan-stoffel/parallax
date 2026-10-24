import { argbFromHex, Hct, hexFromArgb, TonalPalette } from "@material/material-color-utilities";
import { useSyncExternalStore, type CSSProperties } from "react";

import { stored } from "./stored";

// The browser's themes (PLX-973): Helium's, Chrome's Customize Chrome colors, or the app's own.
// Chrome derives a seeded theme's colors from Material tonal palettes in HCT
// (ui/color/dynamic_color/palette_factory.cc) and picks tones for each surface
// (chrome/browser/ui/color/material_*_color_mixer.cc); the fixed themes' colors are Chrome's and
// Helium's own (patches/helium/ui/helium-color-scheme.patch).

/** The colors of a browser's own UI. */
export interface BrowserColors {
  /** Behind the tabs. */
  frame: string;
  /** The toolbar under the tabs, in the classic layout, and around the page. */
  toolbar: string;
  /** The tab in front. */
  tab: string;
  /** The address bar. */
  omnibox: string;
  icon: string;
  text: string;
  accent: string;
}

type Fixed = { light: BrowserColors; dark: BrowserColors };
type Seeded = { seed: string; variant: "tonal" | "neutral" };

/** A theme: the app's own colors, a fixed set, or a seed Chrome builds a palette from. */
export interface BrowserTheme {
  id: string;
  name: string;
  /** Its swatch's color, as Chrome's picker draws it. */
  swatch: string;
  colors?: Fixed | Seeded;
}

const chromeDark: BrowserColors = {
  frame: "#1F2020",
  toolbar: "#3C3C3C",
  tab: "#3C3C3C",
  omnibox: "#282828",
  icon: "#C7C7C7",
  text: "#E3E3E3",
  accent: "#A8C7FA",
};

export const browserThemes: readonly BrowserTheme[] = [
  { id: "parallax", name: "Match Parallax", swatch: "transparent" },
  {
    id: "helium",
    name: "Helium",
    swatch: "#EDEDED",
    colors: {
      // One surface for frame and toolbar; the address bar and the tab in front a grey over it.
      light: {
        frame: "#FFFFFF",
        toolbar: "#FFFFFF",
        tab: "#EDEDED",
        omnibox: "#EDEDED",
        icon: "#444747",
        text: "#1A1C1C",
        accent: "#3450D1",
      },
      dark: {
        frame: "#1E2020",
        toolbar: "#1E2020",
        tab: "#343636",
        omnibox: "#343636",
        icon: "#C4C7C7",
        text: "#E3E2E2",
        accent: "#BAC3FF",
      },
    },
  },
  {
    id: "default",
    name: "Default",
    swatch: "#D3E3FD",
    colors: {
      light: {
        frame: "#D3E3FD",
        toolbar: "#FFFFFF",
        tab: "#FFFFFF",
        omnibox: "#EDF2FA",
        icon: "#474747",
        text: "#1F1F1F",
        accent: "#0B57D0",
      },
      dark: chromeDark,
    },
  },
  {
    id: "grey",
    name: "Grey",
    swatch: "#E3E3E3",
    colors: {
      light: {
        frame: "#E3E3E3",
        toolbar: "#FFFFFF",
        tab: "#FFFFFF",
        omnibox: "#EFEDED",
        icon: "#474747",
        text: "#1F1F1F",
        accent: "#474747",
      },
      dark: { ...chromeDark, accent: "#C7C7C7" },
    },
  },
  ...(
    [
      ["blue", "Blue", "#8CABE4", "tonal"],
      ["aqua", "Aqua", "#26A69A", "tonal"],
      ["green", "Green", "#00FF00", "tonal"],
      ["citron", "Citron", "#FADF73", "tonal"],
      ["orange", "Orange", "#FF8000", "tonal"],
      ["rose", "Rose", "#F3B2BE", "tonal"],
      ["fuchsia", "Fuchsia", "#FF00FF", "tonal"],
      ["violet", "Violet", "#E5D5FC", "tonal"],
      ["coolGrey", "Cool grey", "#8CABE4", "neutral"],
      ["viridian", "Viridian", "#87BA81", "neutral"],
      ["apricot", "Apricot", "#FCDBC9", "neutral"],
      ["pink", "Pink", "#F3B2BE", "neutral"],
    ] as const
  ).map(([id, name, seed, variant]) => ({
    id,
    name,
    swatch: seededColors({ seed, variant }, false).frame,
    colors: { seed, variant },
  })),
];

/** The theme every browser uses, kept on this computer. The app's own until the user picks another. */
export const browserTheme = stored<string>("parallax.browserTheme", "parallax", (raw, fallback) =>
  browserThemes.some((t) => t.id === raw) ? (raw as string) : fallback,
);

/** `a` mixed with `amount` of `b`, both hex colors. */
function mix(a: string, b: string, amount: number): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [channels(a), channels(b)];
  return `#${x
    .map((c, i) => Math.round(c + (y[i]! - c) * amount))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

/** A hex color's relative luminance, 0 for black to 1 for white. */
function lightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * The text that reads on `accent`: black above the luminance where black and white contrast with
 * it equally, as index.css's --black-or-white picks, else white.
 */
export const accentText = (accent: string) => (lightness(accent) > 0.1791 ? "#1A1C1C" : "#FFFFFF");

/** A seeded theme's colors, as Chrome builds them from the seed's hue. */
export function seededColors({ seed, variant }: Seeded, dark: boolean): BrowserColors {
  const hue = Hct.fromInt(argbFromHex(seed)).hue;
  const chroma =
    variant === "tonal"
      ? { primary: 40, secondary: 16, neutral: 6 }
      : { primary: hue >= 260 && hue <= 315 ? 20 : 12, secondary: 8, neutral: 2 };
  const tone = (palette: TonalPalette, t: number) => hexFromArgb(palette.tone(t)).toUpperCase();
  const primary = TonalPalette.fromHueAndChroma(hue, chroma.primary);
  const secondary = TonalPalette.fromHueAndChroma(hue, chroma.secondary);
  const neutral = TonalPalette.fromHueAndChroma(hue, chroma.neutral);
  if (dark)
    return {
      frame: tone(secondary, 12),
      toolbar: tone(secondary, 25),
      tab: tone(secondary, 25),
      omnibox: tone(secondary, 15),
      icon: tone(secondary, 80),
      text: tone(neutral, 90),
      accent: tone(primary, 80),
    };
  const toolbar = tone(neutral, 98);
  return {
    frame: tone(secondary, 90),
    toolbar,
    tab: toolbar,
    // Surface4: the surface with 12% of the primary color over it.
    omnibox: mix(toolbar, tone(primary, 40), 0.12),
    icon: tone(secondary, 30),
    text: tone(neutral, 10),
    accent: tone(primary, 40),
  };
}

/** Theme `id`'s colors in the light or dark mode, or undefined for the app's own. */
export function colorsOf(id: string, dark: boolean): BrowserColors | undefined {
  const colors = browserThemes.find((t) => t.id === id)?.colors;
  if (!colors) return undefined;
  if ("seed" in colors) return seededColors(colors, dark);
  return dark ? colors.dark : colors.light;
}

/**
 * The CSS that paints a browser's UI in `colors`: the app's tokens, which its utilities read, over
 * its part of the page, and the browser's own for the tab, address bar, and toolbar.
 */
export const themeStyle = (colors: BrowserColors) =>
  ({
    "--pane": colors.frame,
    "--surface": colors.toolbar,
    "--background": colors.toolbar,
    "--foreground": colors.text,
    "--muted-foreground": colors.icon,
    "--faint-foreground": `color-mix(in srgb, ${colors.icon} 70%, transparent)`,
    "--hover": `color-mix(in srgb, ${colors.text} 7%, transparent)`,
    "--selected": colors.omnibox,
    "--accent": colors.accent,
    "--accent-foreground": accentText(colors.accent),
    "--border": `color-mix(in srgb, ${colors.text} 12%, transparent)`,
    "--ring": colors.accent,
    "--browser-tab": colors.tab,
    "--browser-omnibox": colors.omnibox,
    "--browser-toolbar": colors.toolbar,
  }) as CSSProperties;

// Whether the app paints dark, by the class theme.ts sets on <html>.
const subscribeDark = (listener: () => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const isDark = () => document.documentElement.classList.contains("dark");

/** The style a browser's UI takes for the picked theme in the app's mode, or none for the app's. */
export function useBrowserTheme(): CSSProperties | undefined {
  const id = browserTheme.use();
  const dark = useSyncExternalStore(subscribeDark, isDark);
  const colors = colorsOf(id, dark);
  return colors && themeStyle(colors);
}
