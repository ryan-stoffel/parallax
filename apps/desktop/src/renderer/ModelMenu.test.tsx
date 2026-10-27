// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { ModelMenu } from "./ModelMenu";
import type { Catalog, Instance, Model } from "./models";
import { redactedPlaceholder } from "./Redacted";

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
    { ...codex("codex", "personal@example.test"), plan: "plus" },
    { ...codex("codex-2", "Work"), account: "work@example.test", plan: "pro" },
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
  [...document.querySelectorAll('ul [role="menuitemradio"]')].map(
    (item) => item.querySelector("span span")?.textContent,
  );
const header = () => button("Choose account")?.textContent;

test("a provider's accounts and pool share one rail button, with a pool-first account menu", () => {
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
  act(() => button("Choose account")!.click());
  const bar = document.querySelector('[role="menu"][aria-label="Account"]')!;
  expect([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
    "Codex pool",
    "hidden email",
    "Work",
  ]);
  // It opens on the pool, and says it's a pool and what it does.
  expect(listed()).toEqual(["gpt-pool"]);
  expect(header()).toBe("Codex poolPoolPicks from 2 accounts by usage left");

  // An account's header names it, its plan, and its email, and its rows only their models.
  act(() => button("Work")!.click());
  expect(document.querySelector('[role="menu"][aria-label="Account"]')).toBeNull();
  expect(listed()).toEqual(["gpt-b"]);
  expect(header()).toBe("WorkProwork@example.test");
  expect(document.querySelector('ul [role="menuitemradio"]')?.textContent).toBe("gpt-b");
});

test("a lone account still shows its blurred email and plan, and favorites say whose a model is", () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const lone: Catalog = {
    hostId: "local",
    instances: [catalog.instances[0]!, catalog.instances[1]!],
    models: catalog.models.slice(0, 2),
  };
  act(() => root!.render(<ModelMenu catalog={lone} value={lone.models[1]!} onChange={() => {}} />));
  expect(button("Choose account")).toBeUndefined();
  const hidden = `${redactedPlaceholder("personal@example.test")}Email hidden, hover or focus to show`;
  expect(document.body.textContent).toContain(`${hidden}Plus`);
  expect(document.body.textContent).not.toContain("personal@example.test");

  act(() => button("Favorite gpt-a")!.click());
  act(() => button("Favorites")!.click());
  expect(document.querySelector('ul [role="menuitemradio"]')?.textContent).toBe(`gpt-a${hidden}`);
  act(() => button("Unfavorite gpt-a")!.click());
});

test("account keyboard navigation stays in the selector and returns focus on close", () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() =>
    root!.render(
      <ModelMenu
        catalog={catalog}
        unavailable={{ codex: "Signed out" }}
        value={catalog.models[0]!}
        onChange={() => {}}
      />,
    ),
  );
  act(() => button("Codex")!.click());
  const chooser = button("Choose account")!;
  const press = (key: string) => {
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  };
  chooser.focus();
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Codex pool"));
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Work"));
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Codex pool"));
  press("ArrowUp");
  expect(document.activeElement).toBe(button("Work"));
  act(() => (document.activeElement as HTMLButtonElement).click());
  expect(document.activeElement).toBe(chooser);
  expect(listed()).toEqual(["gpt-b"]);
  press("ArrowUp");
  expect(document.activeElement).toBe(button("Work"));
  press("Escape");
  expect(document.activeElement).toBe(chooser);
  expect(document.querySelector('[role="menu"][aria-label="Account"]')).toBeNull();
});
