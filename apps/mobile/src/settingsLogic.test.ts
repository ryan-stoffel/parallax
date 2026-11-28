import { expect, test } from "vitest";

import type { ProviderInstance } from "../../desktop/src/protocol/generated/protocol";
import { presets } from "../../desktop/src/renderer/providerKinds";
import { newInstance, versionLine } from "./settingsLogic";

const preset = (name: string) => presets.find((p) => p.name === name)!;
const instance = (id: string, name: string, kind = id) =>
  ({ id, kind, name, enabled: true, args: [], env: [], models: [] }) as ProviderInstance;

test("a built-in agent takes its kind's id while it's free, else a numbered one", () => {
  expect(newInstance(preset("Codex"), [])).toMatchObject({ id: "codex", name: "Codex" });
  const taken = newInstance(preset("Codex"), [instance("codex", "Codex")]);
  expect(taken).toMatchObject({ id: "codex-2", name: "Codex 2" });
});

test("a model service's secret is filled in, and its other variables kept", () => {
  const made = newInstance(preset("OpenRouter"), [], { ANTHROPIC_AUTH_TOKEN: "sk-or-1" });
  expect(made).toMatchObject({ id: "openrouter", kind: "openRouter", enabled: true, models: [] });
  expect(made.env).toEqual([
    { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", secret: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or-1", secret: true },
  ]);
  // Its program is the kind's own, which plxd picks.
  expect(made.program).toBeUndefined();
});

test("the version line names the installed build, with Parallax for a native module that gives no name", () => {
  expect(versionLine({ name: "Parallax (Nightly)", version: "1.0.0", build: "12" })).toBe("Parallax (Nightly) 1.0.0 (12)");
  expect(versionLine({ name: "Parallax", version: "1.0.0", build: "" })).toBe("Parallax 1.0.0");
  expect(versionLine({ version: "1.0.0", build: "12" })).toBe("Parallax 1.0.0 (12)");
});
