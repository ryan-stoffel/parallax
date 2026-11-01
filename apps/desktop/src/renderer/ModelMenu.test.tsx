// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Hub } from "../protocol/generated/protocol";
import { loadHubs, setHubAccountEnabled } from "./hubs";
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

test("a hub has one rail entry and provider-logo choices separate from local providers", () => {
  const hub: Catalog = {
    ...catalog,
    instances: [
      ...catalog.instances,
      {
        ...codex("hub-claude", "CLIProxyAPI"),
        kind: "claude",
        hub: "home",
        hubName: "CLIProxyAPI",
      },
      { ...codex("hub-codex", "CLIProxyAPI"), hub: "home", hubName: "CLIProxyAPI" },
      { ...codex("disabled", "Disabled"), kind: "pi", enabled: false },
    ],
    models: [
      ...catalog.models,
      model("hub-claude", "claude-upstream"),
      model("hub-codex", "gpt-upstream"),
      model("disabled", "invisible"),
    ],
  };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ModelMenu catalog={hub} value={hub.models[0]!} onChange={() => {}} />));
  expect(button("Disabled")).toBeUndefined();
  act(() => button("CLIProxyAPI")!.click());
  expect(listed()).toEqual(["claude-upstream"]);
  act(() => button("Choose provider")!.click());
  const chooser = document.querySelector('[role="menu"][aria-label="Account"]')!;
  expect([...chooser.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
    "Claude Code",
    "Codex",
  ]);
  expect(chooser.querySelectorAll("button svg").length).toBeGreaterThanOrEqual(2);
  act(() => chooser.querySelector<HTMLButtonElement>('[aria-label="Codex"]')!.click());
  expect(listed()).toEqual(["gpt-upstream"]);
  // Removing the active source must recover to an existing group's models immediately.
  act(() =>
    root!.render(<ModelMenu catalog={catalog} value={catalog.models[0]!} onChange={() => {}} />),
  );
  expect(listed()).toEqual(["opus"]);
});

test("hub providers show matching enabled account emails beneath their names, loaded on opening", async () => {
  const metadata: Hub = {
    id: "home",
    name: "CLIProxyAPI",
    url: "http://localhost:8317",
    enabled: true,
    hasManagementKey: true,
    reachable: true,
    claude: "hub-claude",
    codex: "hub-codex",
    claudeModels: [],
    codexModels: [],
    checkedAt: "2026-10-31T00:00:00Z",
    accounts: [
      { id: "c", provider: "claude", email: "claude@example.test", disabled: false, limits: [] },
      { id: "a", provider: "codex", email: "personal@example.test", disabled: false, limits: [] },
      { id: "b", provider: "codex", email: "work@example.test", disabled: false, limits: [] },
      { id: "off", provider: "codex", email: "disabled@example.test", disabled: true, limits: [] },
      { id: "no-email", provider: "codex", disabled: false, limits: [] },
    ],
  };
  const request = vi.fn().mockResolvedValue({ result: { hubs: [metadata] } });
  Object.assign(window, { parallax: { request } });
  const hub: Catalog = {
    hostId: "hub-emails-test",
    instances: [
      {
        ...codex("hub-claude", "CLIProxyAPI"),
        kind: "claude",
        hub: "home",
        hubName: "CLIProxyAPI",
      },
      { ...codex("hub-codex", "CLIProxyAPI"), hub: "home", hubName: "CLIProxyAPI" },
    ],
    models: [model("hub-claude", "Claude Opus 5.5"), model("hub-codex", "GPT 6.1 Terra")],
  };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ModelMenu catalog={hub} value={hub.models[0]!} onChange={() => {}} />));
  expect(request).not.toHaveBeenCalled();
  const opened = () =>
    document
      .querySelector(".model-menu")!
      .dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
  await act(async () => {
    opened();
    opened();
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("hub-emails-test", "hubs/list", {
    refresh: false,
  });
  act(() => button("Choose provider")!.click());
  const choices = document.querySelector('[role="menu"][aria-label="Account"]')!;
  const codexRow = choices.querySelector<HTMLButtonElement>('[aria-label="Codex"]')!;
  expect(codexRow.querySelectorAll(".redacted")).toHaveLength(2);
  expect(codexRow.textContent).toContain(redactedPlaceholder("personal@example.test"));
  expect(codexRow.textContent).toContain(redactedPlaceholder("work@example.test"));
  expect(codexRow.textContent).not.toContain(redactedPlaceholder("disabled@example.test"));
  expect(choices.querySelector('[aria-label="Claude Code"] .redacted')).not.toBeNull();
  act(() => codexRow.click());
  expect(button("Choose provider")!.querySelectorAll(".redacted")).toHaveLength(2);
  expect(listed()).toEqual(["GPT 6.1 Terra"]);
  expect(document.body.textContent).not.toContain("Accounts are routed by the hub");
  await act(async () => {
    opened();
  });
  expect(request).toHaveBeenCalledTimes(1);
  // Without management metadata there is no invented account identity or helper message.
  request.mockResolvedValue({
    result: { hubs: [{ ...metadata, accounts: [], hasManagementKey: false }] },
  });
  await act(async () => {
    await loadHubs("hub-emails-test", true);
  });
  expect(button("Choose provider")!.querySelectorAll(".redacted")).toHaveLength(0);
  // An older metadata request must not undo a newer account settings response.
  let finishOld!: (answer: { result: { hubs: Hub[] } }) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const stale = loadHubs("hub-emails-test", true);
  request.mockResolvedValueOnce({ result: { hubs: [metadata] } });
  await act(async () => {
    await setHubAccountEnabled("hub-emails-test", "home", "b", true);
  });
  await act(async () => {
    finishOld({ result: { hubs: [] } });
    await stale;
  });
  expect(button("Choose provider")!.querySelectorAll(".redacted")).toHaveLength(1);
  act(() => button("Choose provider")!.click());
  expect(document.querySelectorAll('[aria-label="Codex"] .redacted')).toHaveLength(2);
});
