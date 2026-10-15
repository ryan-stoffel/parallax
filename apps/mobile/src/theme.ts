// Parallax Light and Dark, as apps/desktop/src/renderer/index.css has them (theme.test.ts keeps
// them in step), and the desktop's type: Sora, and the system's monospace for code. Pure, for the
// test; ui.tsx picks one by the system's appearance.
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
  markBlue: "#2b5cff",
  markCoral: "#ff4a1f",
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
};

export type Colors = typeof light;

export const font = { regular: "Sora-Regular", medium: "Sora-Medium", mono: "Menlo" };
