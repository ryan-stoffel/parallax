// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";

import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";
import { agents, plan } from "./firstRun";

/** An agent's instance as setup adds it, with `found` and any `change` the user made. */
const info = (
  id: string,
  found: Partial<ProviderInfo> & { enabled?: boolean } = {},
  change: Partial<ProviderInstance> = {},
): ProviderInfo => {
  const { enabled = false, ...rest } = found;
  const agent = agents.find((a) => a.id === id)!;
  return {
    instance: {
      id,
      kind: agent.kind,
      name: agent.name,
      enabled,
      args: agent.args ?? [],
      env: agent.env ?? [],
      models: [],
      ...change,
    },
    installed: true,
    models: [],
    permissions: [],
    efforts: false,
    orchestrator: false,
    ...rest,
  };
};

test("turns on what's ready, turns off what's signed out, and removes what isn't installed", () => {
  const { remove, save } = plan([
    info("claude", { enabled: true, signedIn: false }),
    info("codex", { signedIn: true }),
    info("opencode"),
    info("pi", { installed: false }),
    info("hermes", { installed: false, installing: true }),
  ]);
  expect(remove).toEqual(["pi"]);
  // Turning on first, so the host always keeps one on.
  expect(save.map((i) => [i.id, i.enabled])).toEqual([
    ["codex", true],
    ["opencode", true],
    ["claude", false],
  ]);
});

test("with none ready, leaves the host's instances on", () => {
  const { remove, save } = plan([
    info("claude", { enabled: true, signedIn: false }),
    info("cursor", { installed: false }),
  ]);
  expect(remove).toEqual(["cursor"]);
  expect(save).toEqual([]);
});

test("leaves alone any instance the user made or changed", () => {
  const work = info("claude", { installed: false }, { id: "claude-work", program: "/opt/claude" });
  const keyed = info(
    "codex",
    { enabled: true, signedIn: false },
    { env: [{ name: "OPENAI_API_KEY", secret: true }] },
  );
  const { remove, save } = plan([work, keyed, info("opencode")]);
  expect(remove).toEqual([]);
  expect(save.map((i) => [i.id, i.enabled])).toEqual([["opencode", true]]);
});
