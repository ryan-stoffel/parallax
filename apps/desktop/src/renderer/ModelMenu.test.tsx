// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Hub } from "../protocol/generated/protocol";
import { loadHubs, setHubAccountEnabled } from "./hubs";
import { ModelMenu } from "./ModelMenu";
import type { Catalog, Instance, Model } from "./models";
import { planOf } from "./PlanBadge";
import { loadProviders } from "./providers";

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
  known: [],
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
const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const choice = (name: string) => radios().find((r) => r.parentElement!.textContent === name);
// Each account line's email and plan.
const accounts = () =>
  [...document.querySelectorAll(".model-menu li:not(:has(button))")].map((li) => li.textContent);

test("a provider's accounts share one rail button and a control that picks one", () => {
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
  expect(radios().map((r) => r.parentElement!.textContent)).toEqual(["personal", "Work", "Home"]);
  // It opens on the first account, with who that is and its plan.
  expect(listed()).toEqual(["gpt-a"]);
  expect(accounts()).toEqual(["personal@example.testPlus"]);

  act(() => choice("Work")!.click());
  expect(listed()).toEqual(["gpt-b"]);
  expect(accounts()).toEqual(["work@example.testPro"]);
  // A row names only its model.
  expect(document.querySelector('ul [role="menuitemradio"]')?.textContent).toBe("gpt-b");
});

test("a lone account shows its email and plan, and favorites say whose a model is", () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const lone: Catalog = {
    hostId: "local",
    known: [],
    instances: [catalog.instances[0]!, catalog.instances[1]!],
    models: catalog.models.slice(0, 2),
  };
  act(() => root!.render(<ModelMenu catalog={lone} value={lone.models[1]!} onChange={() => {}} />));
  expect(radios()).toHaveLength(0);
  expect(accounts()).toEqual(["personal@example.testPlus"]);

  act(() => button("Favorite gpt-a")!.click());
  act(() => button("Favorites")!.click());
  expect(document.querySelector('ul [role="menuitemradio"]')?.textContent).toBe(
    "gpt-apersonal@example.test",
  );
  act(() => button("Unfavorite gpt-a")!.click());
});

test("an account that can't be picked is disabled in the control, saying why", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
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
  expect(choice("personal")!.disabled).toBe(true);
  expect(choice("personal")!.parentElement!.title).toBe("Signed out");
  expect(listed()).toEqual(["gpt-b"]);
});

test("accounts whose emails start the same keep their full names", () => {
  const same: Catalog = {
    hostId: "local",
    known: [],
    instances: [codex("a", "ryan@one.test"), codex("b", "ryan@two.test")],
    models: [model("a", "gpt-a"), model("b", "gpt-b")],
  };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ModelMenu catalog={same} value={same.models[0]!} onChange={() => {}} />));
  expect(radios().map((r) => r.parentElement!.textContent)).toEqual([
    "ryan@one.test",
    "ryan@two.test",
  ]);
});

test("each provider's plans have their label and tier, and an unknown one its id", () => {
  expect(planOf("claude", "max")).toEqual({ label: "Max", tier: 2 });
  expect(planOf("claude", "claude_ultra")).toEqual({ label: "Ultra", tier: 3 });
  expect(planOf("codex", "plus")).toEqual({ label: "Plus", tier: 1 });
  expect(planOf("codex", "promax")).toEqual({ label: "Pro Max", tier: 3 });
  expect(planOf("codex", "self_serve_business")).toEqual({ label: "Self Serve Business" });
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
  Object.assign(window, {
    parallax: { request: vi.fn().mockResolvedValue({ result: { hubs: [] } }) },
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ModelMenu catalog={hub} value={hub.models[0]!} onChange={() => {}} />));
  expect(button("Disabled")).toBeUndefined();
  act(() => button("CLIProxyAPI")!.click());
  expect(listed()).toEqual(["claude-upstream"]);
  expect(radios().map((r) => r.parentElement!.textContent)).toEqual(["Claude Code", "Codex"]);
  expect(document.querySelectorAll("fieldset label svg")).toHaveLength(2);
  act(() => choice("Codex")!.click());
  expect(listed()).toEqual(["gpt-upstream"]);
  // Removing the active source must recover to an existing group's models immediately.
  act(() =>
    root!.render(<ModelMenu catalog={catalog} value={catalog.models[0]!} onChange={() => {}} />),
  );
  expect(listed()).toEqual(["opus"]);
});

test("a hub's runtimes show their enabled accounts, with plans, and follow the hub's list", async () => {
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
      {
        id: "c",
        provider: "claude",
        email: "claude@example.test",
        plan: "max",
        disabled: false,
        limits: [],
      },
      {
        id: "a",
        provider: "codex",
        email: "personal@example.test",
        plan: "plus",
        disabled: false,
        limits: [],
      },
      { id: "b", provider: "codex", email: "work@example.test", disabled: false, limits: [] },
      { id: "off", provider: "codex", email: "disabled@example.test", disabled: true, limits: [] },
      { id: "no-email", provider: "codex", disabled: false, limits: [] },
    ],
  };
  const answers = (hubs: Hub[]) => (_: string, method: string) =>
    Promise.resolve({
      result: method === "providers/list" ? { providers: [], checkedAt: "" } : { hubs },
    });
  const request = vi.fn().mockImplementation(answers([metadata]));
  Object.assign(window, { parallax: { request } });
  const hub: Catalog = {
    hostId: "hub-emails-test",
    known: [],
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
  // Read before the first open, and not again within 30 s.
  await act(async () => {
    root!.render(<ModelMenu catalog={hub} value={hub.models[0]!} onChange={() => {}} />);
  });
  const hubLists = () => request.mock.calls.filter(([, method]) => method === "hubs/list");
  expect(hubLists()).toEqual([["hub-emails-test", "hubs/list", { refresh: false }]]);
  const opened = () =>
    document
      .querySelector(".model-menu")!
      .dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
  await act(async () => {
    opened();
  });
  expect(hubLists()).toHaveLength(1);
  expect(accounts()).toEqual(["claude@example.testMax"]);
  act(() => choice("Codex")!.click());
  expect(listed()).toEqual(["GPT 6.1 Terra"]);
  expect(accounts()).toEqual(["personal@example.testPlus", "work@example.test"]);

  // Turning an account off shows at once, and asks for the host's instances again.
  request.mockClear();
  request.mockImplementation(
    answers([{ ...metadata, accounts: metadata.accounts.filter((a) => a.id !== "b") }]),
  );
  await act(async () => {
    await setHubAccountEnabled("hub-emails-test", "home", "b", false);
  });
  expect(accounts()).toEqual(["personal@example.testPlus"]);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("hub-emails-test", "providers/list", { refresh: true }),
  );

  // Without management metadata no account identity is invented.
  request.mockImplementation(answers([{ ...metadata, accounts: [], hasManagementKey: false }]));
  await act(async () => {
    await loadHubs("hub-emails-test", true);
  });
  expect(accounts()).toEqual([]);

  // An older metadata request must not undo a newer account settings response.
  let finishOld!: (answer: { result: { hubs: Hub[] } }) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const stale = loadHubs("hub-emails-test", true);
  request.mockImplementation(answers([metadata]));
  await act(async () => {
    await setHubAccountEnabled("hub-emails-test", "home", "b", true);
  });
  await act(async () => {
    finishOld({ result: { hubs: [] } });
    await stale;
  });
  expect(accounts()).toEqual(["personal@example.testPlus", "work@example.test"]);
});

test("opening the picker asks a host with listed providers for them again", async () => {
  const request = vi.fn().mockResolvedValue({ result: { providers: [], checkedAt: "" } });
  Object.assign(window, { parallax: { request } });
  const hostCatalog = { ...catalog, hostId: "open-sync-test" };
  await loadProviders("open-sync-test");
  request.mockClear();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <ModelMenu catalog={hostCatalog} value={catalog.models[0]!} onChange={() => {}} />,
    ),
  );
  expect(request).not.toHaveBeenCalled();
  await act(async () => {
    document
      .querySelector(".model-menu")!
      .dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("open-sync-test", "providers/list", {
    refresh: false,
  });
});
