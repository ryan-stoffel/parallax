import { useLayoutEffect } from "react";

import { needsTransparentWindow, type WindowMaterial } from "../preload/bridge";
import { merged, stored } from "./stored";
import {
  customColorsCss,
  themeCss,
  useAddedThemes,
  type AddedExtension,
  type Mode,
  type Tokens,
} from "./vscodeThemes";

export type Appearance = {
  /**
   * The theme for each mode, Parallax's or an added one's id (vscodeThemes.ts); Light, Dark, or
   * System picks which shows (theme.ts). An id no longer added shows Parallax's.
   */
  lightTheme: string;
  darkTheme: string;
  /** Colors changed over each theme, by its id, as VS Code's `workbench.colorCustomizations`. */
  colors: Record<string, Tokens>;
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
  /**
   * The window's background: opaque, clear (the desktop shows through), or blurred (macOS and
   * Windows 11 blur what shows through).
   */
  windowMaterial: WindowMaterial;
  /** How much of the theme's background covers what shows through, in percent. */
  backgroundOpacity: number;
};

export const defaults: Appearance = {
  lightTheme: "parallax-light",
  darkTheme: "parallax-dark",
  colors: {},
  contrast: "system",
  uiFont: "",
  uiSize: 13,
  codeFont: "",
  codeSize: 12,
  wordWrap: true,
  motion: "system",
  diffColors: "redGreen",
  windowMaterial: "opaque",
  backgroundOpacity: 75,
};

export const uiSizes = [11, 12, 13, 14, 15, 16, 17, 18, 20];
export const codeSizes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24];

/**
 * Fonts that ship with Parallax (index.css) beside the default, Inter, so every computer has them.
 */
export const bundledFonts = {
  ui: ["Geist Variable"],
  code: ["Geist Mono Variable", "Fira Code Variable", "Source Code Pro Variable"],
};

/**
 * Common fonts, for where the system's list can't be read: those installed are offered instead.
 */
const commonFonts = [
  "Helvetica Neue",
  "Arial",
  "Avenir Next",
  "Segoe UI",
  "Roboto",
  "Ubuntu",
  "Noto Sans",
  "Verdana",
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Consolas",
  "Source Code Pro",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Courier New",
];

function canvas() {
  return document.createElement("canvas").getContext("2d");
}

/**
 * Whether `name` is installed: text in it measures unlike each generic fallback's. False where
 * there's no canvas to measure with.
 */
function isInstalled(name: string): boolean {
  const ctx = canvas();
  if (!ctx) return false;
  const sample = "mmmmmmmmmmlli10OQ@#";
  return ["monospace", "serif", "sans-serif"].some((generic) => {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${name}", ${generic}`;
    return ctx.measureText(sample).width !== base;
  });
}

/** Whether `name`'s narrow and wide letters measure the same. */
function isMonospace(ctx: CanvasRenderingContext2D, name: string) {
  ctx.font = `24px "${name}", sans-serif`;
  return ctx.measureText("iiiiil").width === ctx.measureText("MMMMMW").width;
}

/** This computer's fonts by family, monospace ones apart. `complete` is false for the fallback. */
export type SystemFonts = { mono: string[]; other: string[]; complete: boolean };

let systemFonts: Promise<SystemFonts> | undefined;
/**
 * Every font family installed here, read once with the Local Font Access API. Where that's refused,
 * as before a click gives the page a user gesture, it's the installed `commonFonts`, and the next
 * call tries again.
 */
export function loadSystemFonts(): Promise<SystemFonts> {
  systemFonts ??= (async () => {
    const query = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> })
      .queryLocalFonts;
    let families: string[] = [];
    try {
      families = ((await query?.()) ?? []).map((f) => f.family);
    } catch {
      // Refused: the common fonts below.
    }
    const complete = families.length > 0;
    if (!complete) families = commonFonts.filter(isInstalled);
    families = [...new Set(families)].sort((a, b) => a.localeCompare(b));
    const ctx = canvas();
    const mono = ctx ? families.filter((f) => isMonospace(ctx, f)) : [];
    const result = { mono, other: families.filter((f) => !mono.includes(f)), complete };
    if (!complete) systemFonts = undefined;
    return result;
  })();
  return systemFonts;
}

// Before the window background had three choices, `blur` turned it on, beside a `windowOpacity`
// that faded the whole window. A saved blur carries over; both fields are dropped.
const appearance = stored("parallax.appearance", defaults, (raw, fallback) => {
  const {
    blur,
    windowOpacity: _,
    ...rest
  } = merged(raw, {
    ...fallback,
    blur: false,
    windowOpacity: 100,
  });
  return blur === true && !(raw as Partial<Appearance>).windowMaterial
    ? { ...rest, windowMaterial: "blur" as const }
    : rest;
});

/** Changes and saves part of the appearance, for every window of this computer. */
export const setAppearance = (change: Partial<Appearance>) =>
  appearance.set({ ...appearance.get(), ...change });

/** The appearance, kept current. */
export const useAppearance = appearance.use;

/** The theme each mode shows: the picked one, or Parallax's where it's no longer added. */
export function shownThemes(appearance: Appearance, added: AddedExtension[]): Record<Mode, string> {
  const ids = new Set(added.flatMap((e) => e.themes.map((t) => t.id)));
  return {
    light: ids.has(appearance.lightTheme) ? appearance.lightTheme : "parallax-light",
    dark: ids.has(appearance.darkTheme) ? appearance.darkTheme : "parallax-dark",
  };
}

/**
 * Whether this window shows what's behind it with `material`: blurred where the OS can blur, and
 * clear where the window was created see-through.
 */
export function seesThrough(material: WindowMaterial) {
  const bridge = window.parallax;
  if (!bridge || material === "opaque") return false;
  if (needsTransparentWindow(material, bridge.platform)) return bridge.transparent === true;
  return bridge.canBlur === true;
}

/**
 * How much of the theme's background covers what shows through, in percent. macOS's vibrancy and
 * Windows' acrylic tint what they blur with a material of their own, so the theme covers 2/5 of
 * `opacity` over them: at the full setting the two together hid the blur (PLX-1117). Linux's blur
 * is its compositor's, of a clear window, so it takes `opacity` as Clear does.
 */
export function tint(material: WindowMaterial, opacity: number, platform: string): number {
  if (material === "opaque") return 100;
  return needsTransparentWindow(material, platform) ? opacity : opacity * 0.4;
}

// A font name the user typed, kept to what a CSS family name can hold.
const family = (name: string) => name.replace(/["';{}\\]/g, "").trim();

/**
 * Paints `appearance` on <html>: the fonts as variables index.css reads, and classes for
 * the color theme, contrast, motion, and diff colors. `onboarding` ignores the OS's Reduce
 * motion, which Windows reports whenever its Animation effects are off (PLX-881), so the tour
 * plays unless Parallax's own setting asks for less.
 */
export function applyAppearance(appearance: Appearance, onboarding = false) {
  const root = document.documentElement;
  const ui = family(appearance.uiFont);
  const code = family(appearance.codeFont);
  root.classList.remove(...[...root.classList].filter((name) => name.startsWith("theme-")));
  root.classList.add(`theme-${appearance.lightTheme}`, `theme-${appearance.darkTheme}`);
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
    appearance.motion === "reduce" ||
      (!onboarding && matchMedia("(prefers-reduced-motion: reduce)").matches),
  );
  root.classList.toggle("diff-blue-orange", appearance.diffColors === "blueOrange");
  // index.css mixes the panes' colors with transparent by --tint, over what shows through.
  const through = seesThrough(appearance.windowMaterial);
  root.classList.toggle("translucent", through);
  const covered = through
    ? tint(appearance.windowMaterial, appearance.backgroundOpacity, window.parallax.platform)
    : 100;
  root.style.setProperty("--tint", `${covered}%`);
}

/**
 * Keeps the saved appearance applied: the page, its zoom, and the added themes' CSS with the
 * colors changed over them, with the OS's Reduce motion ignored while `onboarding`. Call once,
 * at the app root.
 */
export function useAppearanceEffects(onboarding = false) {
  const current = useAppearance();
  const added = useAddedThemes();
  // After index.css in <head>, so a theme's tokens win over Parallax's. Changed colors win over
  // both (customColorsCss).
  useLayoutEffect(() => {
    const modes: Record<string, Mode> = { "parallax-light": "light", "parallax-dark": "dark" };
    for (const t of added.flatMap((e) => e.themes)) modes[t.id] = t.mode;
    const style = document.createElement("style");
    style.textContent = `${themeCss(added)}\n${customColorsCss(current.colors, modes)}`;
    document.head.append(style);
    return () => style.remove();
  }, [added, current.colors]);
  // Layout effect, so the first paint already has the saved appearance.
  useLayoutEffect(() => {
    // The shown themes' classes, so Parallax's changed colors apply where a picked theme is gone.
    const { light, dark } = shownThemes(current, added);
    const shown = { ...current, lightTheme: light, darkTheme: dark };
    applyAppearance(shown, onboarding);
    // The OS's Increase contrast and Reduce motion, which "system" follows.
    const media = ["(prefers-contrast: more)", "(prefers-reduced-motion: reduce)"].map(matchMedia);
    const apply = () => applyAppearance(shown, onboarding);
    for (const m of media) m.addEventListener("change", apply);
    return () => {
      for (const m of media) m.removeEventListener("change", apply);
    };
  }, [current, added, onboarding]);
  useLayoutEffect(() => window.parallax.setZoom(current.uiSize / 13), [current.uiSize]);
  useLayoutEffect(
    () => window.parallax.setWindowLook?.({ material: current.windowMaterial }),
    [current.windowMaterial],
  );
}
