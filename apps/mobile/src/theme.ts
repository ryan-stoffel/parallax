// Parallax Light and Dark, as apps/desktop/src/renderer/index.css has them (theme.test.ts keeps
// them in step), and its type: the system's font for text, Sora for the brand, and
// JetBrains Mono Nerd Font for code. Pure, for the test; ui.tsx picks one by the appearance.
export const light = {
  background: "#ffffff",
  surface: "#ffffff",
  foreground: "#171717",
  mutedForeground: "#525252",
  faintForeground: "#666666",
  border: "rgba(0, 0, 0, 0.09)",
  selected: "rgba(0, 0, 0, 0.065)",
  accent: "#2b5cff",
  danger: "#d4330f",
  warning: "#a16207",
  code: "#f7f7f7",
  sidebar: "#f7f7f7",
  hover: "rgba(0, 0, 0, 0.04)",
  added: "#15803d",
  projectViolet: "#7c3aed",
  projectRed: "#dc2626",
  projectOrange: "#ea580c",
  projectYellow: "#a16207",
  projectGreen: "#15803d",
  projectTeal: "#0d9488",
  projectSky: "#0284c7",
  projectPink: "#db2777",
  projectGray: "#71717a",
  markBlue: "#2b5cff",
  markCoral: "#ff4a1f",
  markOverlap: "#1e1b4b",
};

export const dark: typeof light = {
  ...light,
  background: "#000000",
  surface: "#141414",
  foreground: "#ededed",
  mutedForeground: "#a3a3a3",
  faintForeground: "#8a8a8a",
  border: "rgba(255, 255, 255, 0.08)",
  selected: "rgba(255, 255, 255, 0.08)",
  accent: "#5b80ff",
  danger: "#ff6b4a",
  warning: "#f59e0b",
  code: "#0f0f0f",
  sidebar: "#000000",
  hover: "rgba(255, 255, 255, 0.05)",
  added: "#4ade80",
  projectViolet: "#a78bfa",
  projectRed: "#f87171",
  projectOrange: "#fb923c",
  projectYellow: "#facc15",
  projectGreen: "#4ade80",
  projectTeal: "#2dd4bf",
  projectSky: "#38bdf8",
  projectPink: "#f472b6",
  projectGray: "#a1a1aa",
  markOverlap: "#e4e4e7",
};

export type Colors = typeof light;

/** Undefined is the system's font, as the desktop's `-apple-system`. */
export const font = {
  regular: undefined,
  brand: "Sora-Medium",
  mono: "JetBrainsMonoNF-Regular",
  monoBold: "JetBrainsMonoNF-Bold",
};
