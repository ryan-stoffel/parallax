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
  background: "#161616",
  surface: "#1f1f1f",
  foreground: "#ececec",
  mutedForeground: "#a3a3a3",
  faintForeground: "#8f8f8f",
  border: "rgba(255, 255, 255, 0.08)",
  selected: "rgba(255, 255, 255, 0.08)",
  accent: "#5b80ff",
  danger: "#ff6b4a",
  warning: "#f59e0b",
  code: "#101010",
};

export type Colors = typeof light;

export const font = { regular: "Sora-Regular", medium: "Sora-Medium", mono: "Menlo" };
