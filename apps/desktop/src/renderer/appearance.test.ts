import { expect, test } from "vite-plus/test";

import { presets } from "./appearance";

// WCAG 2's contrast ratio between two #rrggbb colors.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("every preset's accent keeps 4.5:1 on its scheme's background and surface", () => {
  // index.css's --background and --surface in each scheme.
  const grounds = { light: ["#ffffff"], dark: ["#0d0d0d", "#171717"] };
  for (const p of presets)
    for (const mode of ["light", "dark"] as const)
      for (const ground of grounds[mode])
        expect(
          contrast(p.accent[mode], ground),
          `${p.name} ${mode} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
});
