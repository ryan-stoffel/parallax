// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { ModelMenu } from "./ModelMenu";
import type { Catalog, Instance, Model } from "./models";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const codex = (id: string, name: string, members?: string[]): Instance => ({
  id,
  name,
  kind: "codex",
  enabled: true,
  permissions: [],
  efforts: true,
  coordinator: false,
  ...(members && { members }),
});
const model = (provider: string, id: string): Model => ({
  id,
  name: id,
  provider,
  contexts: [],
});

// Two Codex accounts and their pool, and Claude (PLX-1033).
const catalog: Catalog = {
  hostId: "local",
  instances: [
    { ...codex("claude", "Claude"), kind: "claude" },
    codex("codex", "Codex"),
    codex("codex-2", "Codex 2"),
    codex("pool", "Codex pool", ["codex", "codex-2"]),
  ],
  models: [
    model("claude", "opus"),
    model("codex", "gpt-a"),
    model("codex-2", "gpt-b"),
    model("pool", "gpt-pool"),
  ],
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) ??
  [...document.querySelectorAll("button")].find((b) => b.textContent === name);
const listed = () =>
  [...document.querySelectorAll('[role="menuitemradio"]')].map(
    (item) => item.querySelector("span span")?.textContent,
  );

test("a provider's accounts and pool share one rail button, with the pool first in its bar", () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() =>
    root!.render(<ModelMenu catalog={catalog} value={catalog.models[0]!} onChange={() => {}} />),
  );

  expect(button("Claude")).toBeDefined();
  // One Codex button, named for the kind, not three named for each instance.
  expect(button("Codex")?.getAttribute("aria-pressed")).not.toBeNull();
  expect(document.querySelectorAll('button[aria-label="Codex 2"]')).toHaveLength(0);

  act(() => button("Codex")!.click());
  const bar = document.querySelector('[role="group"][aria-label="Account"]')!;
  expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "Codex pool",
    "Codex",
    "Codex 2",
  ]);
  // It opens on the pool, and says what a pool does.
  expect(listed()).toEqual(["gpt-pool"]);
  expect(document.body.textContent).toContain(
    "Each thread starts on the account with the most left.",
  );

  act(() => button("Codex 2")!.click());
  expect(listed()).toEqual(["gpt-b"]);
});
