// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { ModelMenu } from "./ModelMenu";
import type { Catalog, Instance, Model } from "./models";
import { redactedPlaceholder } from "./Redacted";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const codex = (id: string, name: string): Instance => ({
  id,
  name,
  kind: "codex",
  enabled: true,
  permissions: [],
  efforts: true,
  orchestrator: false,
});
const model = (provider: string, id: string): Model => ({
  id,
  name: id,
  provider,
  contexts: [],
});

// Three Codex accounts, and Claude.
const catalog: Catalog = {
  hostId: "local",
  instances: [
    { ...codex("claude", "Claude"), kind: "claude" },
    { ...codex("codex", "personal@example.test"), plan: "plus" },
    { ...codex("codex-2", "Work"), account: "work@example.test", plan: "pro" },
    codex("codex-3", "Home"),
  ],
  models: [
    model("claude", "opus"),
    model("codex", "gpt-a"),
    model("codex-2", "gpt-b"),
    model("codex-3", "gpt-c"),
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

test("a provider's accounts share one rail button, with an account menu", () => {
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
    "hidden email",
    "Work",
    "Home",
  ]);
  // It opens on the first account.
  expect(listed()).toEqual(["gpt-a"]);
  expect(header()).toBe(
    `${redactedPlaceholder("personal@example.test")}Email hidden, hover or focus to showPlus`,
  );

  // An account's header names it, its email, and its plan, and its rows only their models.
  act(() => button("Work")!.click());
  expect(document.querySelector('[role="menu"][aria-label="Account"]')).toBeNull();
  expect(listed()).toEqual(["gpt-b"]);
  expect(header()).toBe("Workwork@example.testPro");
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
  expect(document.activeElement).toBe(button("Work"));
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Home"));
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Work"));
  press("ArrowUp");
  expect(document.activeElement).toBe(button("Home"));
  act(() => (document.activeElement as HTMLButtonElement).click());
  expect(document.activeElement).toBe(chooser);
  expect(listed()).toEqual(["gpt-c"]);
  press("ArrowUp");
  expect(document.activeElement).toBe(button("Home"));
  press("Escape");
  expect(document.activeElement).toBe(chooser);
  expect(document.querySelector('[role="menu"][aria-label="Account"]')).toBeNull();
});

test("the button names only the chosen model, not its account", () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() =>
    root!.render(<ModelMenu catalog={catalog} value={catalog.models[2]!} onChange={() => {}} />),
  );
  expect(button("Model: gpt-b")?.textContent).toBe("gpt-b");
});
