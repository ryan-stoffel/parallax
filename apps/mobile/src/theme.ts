// Parallax Light and Dark, as apps/desktop/src/renderer/index.css has them (theme.test.ts keeps
// them in step), and the desktop's type: Sora, and the system's monospace for code. Pure, for the
// test; ui.tsx picks one by the system's appearance.
export const light = {
  background: "#fcfcfc",
  surface: "#ffffff",
  foreground: "#27272a",
  mutedForeground: "#52525b",
  faintForeground: "#66666e",
  border: "rgba(24, 24, 27, 0.09)",
  selected: "rgba(24, 24, 27, 0.07)",
  accent: "#2b5cff",
  danger: "#c42b2b",
  warning: "#d97706",
  code: "#f4f4f5",
  markBlue: "#2b5cff",
  markCoral: "#ff4a1f",
};

export const dark: typeof light = {
  ...light,
  background: "#0a0a0a",
  surface: "#161616",
  foreground: "#f4f4f5",
  mutedForeground: "#a3a3a3",
  faintForeground: "#858585",
  border: "rgba(255, 255, 255, 0.07)",
  selected: "rgba(255, 255, 255, 0.07)",
  accent: "#4b78ff",
  danger: "#ff8f8a",
  warning: "#f59e0b",
  code: "#131313",
};

export type Colors = typeof light;

export const font = { regular: "Sora-Regular", medium: "Sora-Medium", mono: "Menlo" };
