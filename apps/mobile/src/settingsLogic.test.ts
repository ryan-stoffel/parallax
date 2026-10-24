import { expect, test } from "vitest";

import type { ProviderInstance } from "../../desktop/src/protocol/generated/protocol";
import { presets } from "../../desktop/src/renderer/providerKinds";
import { newInstance, withVar } from "./settingsLogic";

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

test("setting a variable replaces it in place, or adds it at the end", () => {
  const env = [
    { name: "A", value: "1", secret: false },
    { name: "B", value: "2", secret: false },
  ];
  expect(withVar(env, "A", "3", true).map((v) => [v.name, v.value, v.secret])).toEqual([
    ["A", "3", true],
    ["B", "2", false],
  ]);
  expect(withVar(env, "C", "4", false).map((v) => v.name)).toEqual(["A", "B", "C"]);
});
