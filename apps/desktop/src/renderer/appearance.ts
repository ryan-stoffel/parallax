import { useLayoutEffect } from "react";

import { merged, stored } from "./stored";

export type Appearance = {
  /** "system" follows the OS's Increase contrast. */
  contrast: "system" | "standard" | "more";
  /** A font family name, or empty for the system's. */
  uiFont: string;
  /** The interface's text size in px; the page zooms to it from the 13 px it's drawn at. */
  uiSize: number;
  codeFont: string;
  /** Code's text size in px, the terminal's as it is, the rest zoomed from 12 px. */
  codeSize: number;
  /** Whether long lines wrap in code blocks, diffs, and file previews. */
  wordWrap: boolean;
  /** "system" follows the OS's Reduce motion. Either way `.reduce-motion` on <html> says so. */
  motion: "system" | "reduce";
  /** The pair that marks added and removed, done and failed. */
  diffColors: "redGreen" | "blueOrange";
};

export const defaults: Appearance = {
  contrast: "system",
  uiFont: "",
  uiSize: 13,
  codeFont: "",
  codeSize: 12,
  wordWrap: true,
  motion: "system",
  diffColors: "redGreen",
};

export const uiSizes = [11, 12, 13, 14, 15, 16, 18, 20];
export const codeSizes = [10, 11, 12, 13, 14, 15, 16, 18];

/**
 * The fonts Appearance offers, those installed here among these, after the system's. Typing a
 * name under Advanced takes any other.
 */
const uiCandidates = [
  "Inter",
  "Helvetica Neue",
  "Arial",
  "Avenir Next",
  "Segoe UI",
  "Roboto",
  "Atkinson Hyperlegible",
  "Lexend",
  "IBM Plex Sans",
  "Open Sans",
  "Verdana",
  "Ubuntu",
  "Noto Sans",
];
const codeCandidates = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Consolas",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Courier New",
];

/**
 * Whether `name` is installed: text in it measures unlike each generic fallback's. False where
 * there's no canvas to measure with.
 */
function isInstalled(name: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  const sample = "mmmmmmmmmmlli10OQ@#";
  return ["monospace", "serif", "sans-serif"].some((generic) => {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${name}", ${generic}`;
    return ctx.measureText(sample).width !== base;
  });
}

let installed: { ui: string[]; code: string[] } | undefined;
/** The candidate fonts installed on this computer, measured once. */
export function installedFonts() {
  installed ??= { ui: uiCandidates.filter(isInstalled), code: codeCandidates.filter(isInstalled) };
  return installed;
}

const appearance = stored("parallax.appearance", defaults, merged);

/** Changes and saves part of the appearance, for every window of this computer. */
export const setAppearance = (change: Partial<Appearance>) =>
  appearance.set({ ...appearance.get(), ...change });

/** The appearance, kept current. */
export const useAppearance = appearance.use;

// A font name the user typed, kept to what a CSS family name can hold.
const family = (name: string) => name.replace(/["';{}\\]/g, "").trim();

/**
 * Paints `appearance` on <html>: the fonts as variables index.css reads, and classes for
 * contrast, motion, and diff colors.
 */
export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  const ui = family(appearance.uiFont);
  const code = family(appearance.codeFont);
  if (ui) root.style.setProperty("--ui-font", `"${ui}"`);
  else root.style.removeProperty("--ui-font");
  if (code) root.style.setProperty("--code-font", `"${code}"`);
  else root.style.removeProperty("--code-font");
  root.style.setProperty("--code-size", String(appearance.codeSize));
  root.style.setProperty("--code-zoom", String(appearance.codeSize / 12));
  root.classList.toggle("word-wrap", appearance.wordWrap);
  const more =
    appearance.contrast === "more" ||
    (appearance.contrast === "system" && matchMedia("(prefers-contrast: more)").matches);
  root.classList.toggle("contrast-more", more);
  root.classList.toggle(
    "reduce-motion",
    appearance.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  root.classList.toggle("diff-blue-orange", appearance.diffColors === "blueOrange");
}

/**
 * Keeps the saved appearance applied: the page and its zoom. Call once, at the
 * app root.
 */
export function useAppearanceEffects() {
  const current = useAppearance();
  // Layout effect, so the first paint already has the saved appearance.
  useLayoutEffect(() => {
    applyAppearance(current);
    // The OS's Increase contrast and Reduce motion, which "system" follows.
    const media = ["(prefers-contrast: more)", "(prefers-reduced-motion: reduce)"].map(matchMedia);
    const apply = () => applyAppearance(current);
    for (const m of media) m.addEventListener("change", apply);
    return () => {
      for (const m of media) m.removeEventListener("change", apply);
    };
  }, [current]);
  useLayoutEffect(() => window.parallax.setZoom(current.uiSize / 13), [current.uiSize]);
}
