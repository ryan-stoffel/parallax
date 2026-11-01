import { expect, test } from "vite-plus/test";

import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";
import { hubModelName, isNew } from "./catalog";
import { catalogOf, instanceModels } from "./models";
import { knownModel } from "./Subagents";

const info = (instance: Partial<ProviderInstance>, rest: Partial<ProviderInfo> = {}) =>
  ({
    instance: { kind: "acp", name: "", enabled: true, args: [], env: [], models: [], ...instance },
    installed: true,
    models: [],
    permissions: ["edit"],
    efforts: false,
    orchestrator: false,
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
    { id: "gemini-3", name: "Gemini 3 (found)", provider: "gemini", contexts: [], custom: true },
  ]);
});

test("a hub's instances offer only the hub's models, with readable names and unchanged upstream IDs", () => {
  const hub = (id: string, kind: string, models: string[]) =>
    info(
      { id, kind: kind as ProviderInstance["kind"], name: "Work Codex" },
      { hub: "home", models: models.map((m) => ({ id: m, name: m })) },
    );
  const catalog = catalogOf(
    "local",
    [
      hub("home-claude", "claude", ["claude-opus-5-5"]),
      hub("home-codex", "codex", ["gpt-6-sol", "gemini-3-pro"]),
    ],
    {},
    [],
  );
  expect(catalog.instances.map((i) => i.hubName)).toEqual(["Work Codex", "Work Codex"]);
  expect(catalog.models.map((m) => [m.provider, m.id, m.name])).toEqual([
    ["home-claude", "claude-opus-5-5", "Claude Opus 5.5"],
    ["home-codex", "gpt-6-sol", "GPT 6 Sol"],
    ["home-codex", "gemini-3-pro", "Gemini 3 Pro"],
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

test("a reported model is its exact id before a longer one's prefix (PLX-495)", () => {
  expect(knownModel("claude-opus-5-5-medium")?.provider).toBe("cursor");
  expect(knownModel("claude-opus-5-5[1m]")?.provider).toBe("claude");
  expect(knownModel("claude-haiku-4-5-20251001")?.provider).toBe("claude");
  // A dated id is never taken for a shorter model (PLX-715).
  expect(knownModel("claude-sonnet-5-5-20261001")?.name).toBe("Claude Sonnet 5.5");
  expect(knownModel("claude-haiku-5-5-20261001")?.name).toBe("Claude Haiku 5.5");
});

test("a model is New for the week after its release", () => {
  const m = { id: "m", name: "M", provider: "claude", contexts: [], released: "2026-10-20" };
  expect(isNew(m, Date.parse("2026-10-20"))).toBe(true);
  expect(isNew(m, Date.parse("2026-10-26T23:59:59Z"))).toBe(true);
  expect(isNew(m, Date.parse("2026-10-27"))).toBe(false);
  expect(isNew({ ...m, released: undefined }, Date.parse("2026-10-20"))).toBe(false);
});

test("an account named by its email keeps it in the catalog", () => {
  const listed = [
    info({ id: "codex", kind: "codex", name: "Codex" }, { account: "ryan@example.com" }),
    info({ id: "work", kind: "codex", name: "Work" }, { account: "work@example.com" }),
  ];
  const [signedIn, named] = catalogOf("local", listed, {}, []).instances;
  expect(signedIn!.name).toBe("ryan@example.com");
  expect(named!.name).toBe("Work");
});

test("the catalog offers only instances that are on and can run", () => {
  const model = { models: [{ id: "m", name: "M" }] };
  const providers = [
    info({ id: "ready", kind: "codex" }, { ...model, signedIn: true }),
    info({ id: "unknown", kind: "pi" }, model),
    info({ id: "off", kind: "pi", enabled: false }, { ...model, signedIn: true }),
    info({ id: "out", kind: "claude" }, { ...model, signedIn: false }),
    info({ id: "missing", kind: "opencode" }, { ...model, installed: false }),
    info({ id: "free", kind: "cursor" }, { ...model, note: "[plan_required] Upgrade to Pro." }),
  ];
  const offered = (list: ProviderInfo[]) => [
    ...new Set(catalogOf("local", list, {}, []).models.map((m) => m.provider)),
  ];
  expect(offered(providers)).toEqual(["ready", "unknown"]);
  // Signed out of everything, the composer still has a model to send with.
  expect(offered([info({ id: "out", kind: "claude" }, { ...model, signedIn: false })])).toEqual([
    "out",
  ]);
});

test("a hub lists agent models newest first, without its image models", () => {
  const models = instanceModels(
    info(
      { id: "hub-codex", kind: "codex" },
      {
        hub: "home",
        models: [
          "gpt-oss-120b",
          "gpt-image-2.5",
          "gpt-5.6-sol",
          "codex-auto-review",
          "gpt-6.1-terra",
        ].map((id) => ({ id, name: id })),
      },
    ),
  );
  expect(models.map((m) => m.name)).toEqual(["GPT 6.1 Terra", "GPT 5.6 Sol", "GPT OSS 120B"]);
});

test("discovered models define availability and names without a catalog edit", () => {
  const models = instanceModels(
    info(
      { id: "codex", kind: "codex" },
      {
        models: [
          { id: "brand-new-model", name: "An upstream name" },
          { id: "gpt-6-sol", name: "Upstream Sol" },
        ],
      },
    ),
  );
  expect(models.map((m) => [m.id, m.name])).toEqual([
    ["brand-new-model", "An upstream name"],
    ["gpt-6-sol", "Upstream Sol"],
  ]);
  expect(models[1]!.fast).toBe(true);
  expect(isNew({ ...models[0]!, released: "2099-01-01" }, Date.parse("2026-10-31"))).toBe(false);
});

test("hub display names format raw slugs without rewriting routes, dates, or custom labels", () => {
  for (const [id, expected] of [
    ["gpt-6.1-terra", "GPT 6.1 Terra"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
    ["claude-3-5-haiku-20241022", "Claude 3.5 Haiku"],
    ["gemini-3-pro-preview", "Gemini 3 Pro Preview"],
    ["gpt-oss-120b", "GPT OSS 120B"],
    ["team/gpt-6.1-terra", "team/GPT 6.1 Terra"],
    ["gemini-3-pro-2026-10-31", "Gemini 3 Pro 2026-10-31"],
  ])
    expect(hubModelName({ id: id!, name: id! })).toBe(expected);
  expect(hubModelName({ id: "gpt-6.1-terra", name: "Terra (recommended)" })).toBe(
    "Terra (recommended)",
  );
  expect(hubModelName({ id: "gpt-6.1-terra", name: "my-custom-alias" })).toBe("my-custom-alias");
  expect(hubModelName({ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" })).toBe("GPT-6.1 Terra");
});
