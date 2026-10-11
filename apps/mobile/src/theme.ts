// Parallax Light and Dark, as apps/desktop/src/renderer/index.css has them (theme.test.ts keeps
// them in step), and the desktop's type: Sora, and the system's monospace for code. Pure, for the
// test; ui.tsx picks one by the system's appearance.
export const light = {
  background: "#ffffff",
  surface: "#ffffff",
  foreground: "#181818",
  mutedForeground: "#4f4f4f",
  faintForeground: "#636363",
  border: "rgba(0, 0, 0, 0.09)",
  selected: "rgba(0, 0, 0, 0.07)",
  accent: "#2563eb",
  danger: "#c42b2b",
  warning: "#d97706",
  code: "#f7f7f8",
  markBlue: "#2b5cff",
  markCoral: "#ff4a1f",
};

export const dark: typeof light = {
  ...light,
  background: "#0d0d0d",
  surface: "#171717",
  foreground: "#ececec",
  mutedForeground: "#a8a8a8",
  faintForeground: "#868686",
  border: "rgba(255, 255, 255, 0.08)",
  selected: "rgba(255, 255, 255, 0.08)",
  accent: "#3b82f6",
  danger: "#ff8f8a",
  warning: "#f59e0b",
  code: "#151515",
};

export type Colors = typeof light;

export const font = { regular: "Sora-Regular", medium: "Sora-Medium", mono: "Menlo" };
