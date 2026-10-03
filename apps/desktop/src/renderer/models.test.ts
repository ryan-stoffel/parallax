import { expect, test } from "vite-plus/test";

import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";
import { catalogOf, instanceModels } from "./models";

const info = (instance: Partial<ProviderInstance>, rest: Partial<ProviderInfo> = {}) =>
  ({
    instance: { kind: "acp", name: "", enabled: true, args: [], env: [], models: [], ...instance },
    installed: true,
    models: [],
    permissions: ["edit"],
    efforts: false,
    coordinator: false,
    ...rest,
  }) as ProviderInfo;

test("a host's catalog is its instances' models, in this device's order, without hidden ones", () => {
  const listed = [
    info({ id: "codex", kind: "codex", name: "Codex" }, { efforts: true }),
    info(
      { id: "router", kind: "openRouter", name: "OpenRouter", enabled: false },
      { models: [{ id: "qwen/qwen3", name: "Qwen 3" }] },
    ),
    info(
      { id: "gemini", name: "Gemini", models: [{ id: "gemini-3", name: "Gemini 3" }] },
      { models: [{ id: "gemini-3", name: "Gemini 3 (found)" }] },
    ),
  ];
  const catalog = catalogOf(
    "mini",
    listed,
    {
      "mini/codex": { order: ["gpt-5.5", "gpt-6-sol"], hidden: ["gpt-6.1-sol"] },
      // Another host's choices don't apply.
      "local/router": { hidden: ["qwen/qwen3"] },
    },
    ["codex"],
  );

  expect(catalog.instances.map((i) => [i.id, i.name, i.enabled, i.efforts])).toEqual([
    ["codex", "Codex", true, true],
    ["router", "OpenRouter", false, false],
    ["gemini", "Gemini", true, false],
  ]);
  const codex = catalog.models.filter((m) => m.provider === "codex");
  // Ordered ones first, then the rest in the built-in order, with their context and fast data.
  expect(codex.slice(0, 3).map((m) => m.id)).toEqual(["gpt-5.5", "gpt-6-sol", "gpt-6-astra"]);
  expect(codex.some((m) => m.id === "gpt-6.1-sol")).toBe(false);
  expect(codex[0]).toMatchObject({ contexts: [272_000], fast: true });
  // A model plxd found and the user added is listed once, as plxd named it, and is custom.
  expect(catalog.models.filter((m) => m.provider !== "codex")).toEqual([
    { id: "qwen/qwen3", name: "Qwen 3", provider: "router", contexts: [] },
    { id: "gemini-3", name: "Gemini 3 (found)", provider: "gemini", contexts: [], custom: true },
  ]);
});

test("an older plxd's catalog is the built-in one, turned off as this computer says", () => {
  const catalog = catalogOf("local", undefined, {}, ["cursor"]);
  expect(catalog.instances.map((i) => [i.id, i.enabled])).toEqual([
    ["claude", true],
    ["codex", true],
    ["cursor", false],
  ]);
  expect(catalog.models[0]).toMatchObject({ id: "claude-opus-5-5", provider: "claude" });
});

test("an instance that lists no models offers its agent's default, which sends no model", () => {
  const models = instanceModels(info({ id: "amp", name: "Amp" }));
  expect(models.map((m) => [m.id, m.name, m.provider])).toEqual([["", "Default model", "amp"]]);
});
