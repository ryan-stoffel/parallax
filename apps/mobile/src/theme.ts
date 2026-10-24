// Parallax Light and Dark, as apps/desktop/src/renderer/index.css has them (theme.test.ts keeps
// them in step), and the desktop's type: the system's font for text, Sora for the brand, and
// JetBrains Mono Nerd Font for code. Pure, for the test; ui.tsx picks one by the appearance.
export const light = {
  background: "#ffffff",
  surface: "#ffffff",
  foreground: "#1e1b4b",
  mutedForeground: "#4a4868",
  faintForeground: "#64627e",
  border: "rgba(30, 27, 75, 0.1)",
  selected: "rgba(30, 27, 75, 0.07)",
  accent: "#2b5cff",
  danger: "#d4330f",
  warning: "#b45309",
  code: "#f6f6f9",
  sidebar: "#f6f6f9",
  hover: "rgba(30, 27, 75, 0.045)",
  added: "#15803d",
  projectViolet: "#7c3aed",
  markBlue: "#2b5cff",
  markCoral: "#ff4a1f",
  markOverlap: "#1e1b4b",
};

export const dark: typeof light = {
  ...light,
  background: "#0b0b10",
  surface: "#17171f",
  foreground: "#ededf4",
  mutedForeground: "#a6a5b9",
  faintForeground: "#878699",
  border: "rgba(237, 237, 244, 0.08)",
  selected: "rgba(237, 237, 244, 0.08)",
  accent: "#5b80ff",
  danger: "#ff6b4a",
  warning: "#f59e0b",
  code: "#121218",
  sidebar: "#121218",
  hover: "rgba(237, 237, 244, 0.045)",
  added: "#4ade80",
  projectViolet: "#a78bfa",
  markOverlap: "#e4e4e7",
};

export type Colors = typeof light;

/** Undefined is the system's font, as the desktop's `-apple-system`. */
export const font = {
  regular: undefined,
  medium: undefined,
  brand: "Sora-Medium",
  mono: "JetBrainsMonoNF-Regular",
  monoBold: "JetBrainsMonoNF-Bold",
};
