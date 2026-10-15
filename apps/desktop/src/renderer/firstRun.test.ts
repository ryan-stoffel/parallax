// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";

import type { ProviderInfo, ProviderKind } from "../protocol/generated/protocol";
import { plan } from "./firstRun";

const info = (
  kind: ProviderKind,
  found: Partial<ProviderInfo> & { enabled?: boolean } = {},
): ProviderInfo => {
  const { enabled = false, ...rest } = found;
  return {
    instance: { id: kind, kind, name: kind, enabled, args: [], env: [], models: [] },
    installed: true,
    models: [],
    permissions: [],
    efforts: false,
    coordinator: false,
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

test("leaves instances that aren't onboarding's agents alone", () => {
  const { remove, save } = plan([
    info("claude", { signedIn: true }),
    info("openRouter", { enabled: true, installed: false, signedIn: false }),
  ]);
  expect(remove).toEqual([]);
  expect(save.map((i) => i.id)).toEqual(["claude"]);
});
