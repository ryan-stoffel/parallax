import { expect, test } from "vite-plus/test";

import { AmpLogo, ClineLogo, HermesLogo } from "./logos";
import { kindOf, logoOf } from "./providers";

test("an instance shows its kind's logo, and a known ACP agent its own", () => {
  expect(logoOf({ kind: "hermes", name: "Hermes (Nous Portal)" })).toBe(HermesLogo);
  expect(logoOf({ kind: "acp", name: "Amp", program: "amp-acp" })).toBe(AmpLogo);
  expect(logoOf({ kind: "acp", name: "My agent", program: "cline" })).toBe(ClineLogo);
  expect(logoOf({ kind: "acp", name: "Kiro CLI" })).toBe(kindOf("acp").Logo);
});
