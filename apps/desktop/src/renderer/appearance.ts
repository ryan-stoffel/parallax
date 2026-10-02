import { useLayoutEffect } from "react";

import { merged, stored } from "./stored";

/**
 * A color preset: the app icon's two circles (the front one, then the back one) and the accent
 * each mode derives from the front one. Every accent keeps 4.5:1 on its mode's background and
 * surface (appearance.test.ts), so links and highlights stay readable.
 */
export type Preset = {
  id: string;
  name: string;
  marks: [front: string, back: string];
  accent: { light: string; dark: string };
};

export const presets: Preset[] = [
  {
    id: "parallax",
    name: "Parallax",
    marks: ["#2b5cff", "#ff4a1f"],
    accent: { light: "#2563eb", dark: "#3b82f6" },
  },
  {
    id: "ocean",
    name: "Ocean",
    marks: ["#0891b2", "#6366f1"],
    accent: { light: "#0e7490", dark: "#22d3ee" },
  },
  {
    id: "grove",
    name: "Grove",
    marks: ["#16a34a", "#eab308"],
    accent: { light: "#15803d", dark: "#4ade80" },
  },
  {
    id: "ember",
    name: "Ember",
    marks: ["#f97316", "#dc2626"],
    accent: { light: "#c2410c", dark: "#fb923c" },
  },
  {
    id: "iris",
    name: "Iris",
    marks: ["#7c3aed", "#ec4899"],
    accent: { light: "#7c3aed", dark: "#a78bfa" },
  },
  {
    id: "graphite",
    name: "Graphite",
    marks: ["#71717a", "#d4d4d8"],
    accent: { light: "#52525b", dark: "#a1a1aa" },
  },
];

export type Appearance = {
  preset: string;
  /** "system" follows the OS's Increase contrast. */
  contrast: "system" | "standard" | "more";
  /** The page's zoom, 1 being 100%. */
  zoom: number;
  /** A font family name, or empty for the system's. */
  uiFont: string;
  codeFont: string;
  /** "system" follows the OS's Reduce motion. Either way `.reduce-motion` on <html> says so. */
  motion: "system" | "reduce";
  /** The pair that marks added and removed, done and failed. */
  diffColors: "redGreen" | "blueOrange";
};

export const defaults: Appearance = {
  preset: "parallax",
  contrast: "system",
  zoom: 1,
  uiFont: "",
  codeFont: "",
  motion: "system",
  diffColors: "redGreen",
};

export const zooms = [0.9, 1, 1.1, 1.25, 1.5];

const appearance = stored("parallax.appearance", defaults, merged);

/** Changes and saves part of the appearance, for every window of this computer. */
export const setAppearance = (change: Partial<Appearance>) =>
  appearance.set({ ...appearance.get(), ...change });

/** The appearance, kept current. */
export const useAppearance = appearance.use;

export const presetOf = (id: string) => presets.find((p) => p.id === id) ?? presets[0]!;

// A font name the user typed, kept to what a CSS family name can hold.
const family = (name: string) => name.replace(/["';{}\\]/g, "").trim();

/**
 * Paints `appearance` on <html>: the preset's colors as variables index.css reads, and classes
 * for contrast, motion, and diff colors.
 */
export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  const preset = presetOf(appearance.preset);
  root.style.setProperty("--mark-blue", preset.marks[0]);
  root.style.setProperty("--mark-coral", preset.marks[1]);
  root.style.setProperty("--preset-accent-light", preset.accent.light);
  root.style.setProperty("--preset-accent-dark", preset.accent.dark);
  const ui = family(appearance.uiFont);
  const code = family(appearance.codeFont);
  if (ui) root.style.setProperty("--ui-font", `"${ui}"`);
  else root.style.removeProperty("--ui-font");
  if (code) root.style.setProperty("--code-font", `"${code}"`);
  else root.style.removeProperty("--code-font");
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
 * Draws the app icon in `preset`'s colors as a PNG data: URL: the two circles on a dark tile,
 * the overlap the front color at 80% over the back one, as design/icon's flat renders are.
 */
export function drawIcon(preset: Preset, size = 512): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const s = size / 1024;
  // macOS's icon grid: an 824 pt tile in the middle of 1024.
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.roundRect(100 * s, 100 * s, 824 * s, 824 * s, 185 * s);
  ctx.fill();
  // Parallax.icon's circles, on its 1024 canvas's diagonal, at its 0.92 group scale, in the tile.
  const k = 0.92 * (824 / 1024);
  const circle = (center: number) => {
    const at = (512 + (center - 512) * k) * s;
    ctx.beginPath();
    ctx.arc(at, at, 330 * k * s, 0, Math.PI * 2);
  };
  const [front, back] = preset.marks;
  ctx.fillStyle = front;
  circle(400);
  ctx.fill();
  ctx.fillStyle = back;
  circle(624);
  ctx.fill();
  ctx.save();
  circle(624);
  ctx.clip();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = front;
  circle(400);
  ctx.fill();
  ctx.restore();
  return canvas.toDataURL("image/png");
}

/**
 * Keeps the saved appearance applied: the page, its zoom, and the app icon. Call once, at the
 * app root.
 */
export function useAppearanceEffects() {
  const current = useAppearance();
  // Layout effect, so the first paint already has the preset's colors.
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
  useLayoutEffect(() => window.parallax.setZoom(current.zoom), [current.zoom]);
  useLayoutEffect(() => {
    // The default preset keeps the bundled icon, which macOS draws in glass.
    const preset = presetOf(current.preset);
    window.parallax.setAppIcon(preset.id === "parallax" ? null : (drawIcon(preset) ?? null));
  }, [current.preset]);
}
