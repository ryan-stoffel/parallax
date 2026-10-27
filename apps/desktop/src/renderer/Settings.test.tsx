// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, SshHost, ParallaxBridge } from "../preload/bridge";
import type { ProviderInfo, ProviderInstance, ProviderKind } from "../protocol/generated/protocol";
import type { SettingsSection } from "./App";
import { Notifications } from "./notifications";
import { Settings } from "./Settings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};

// xterm.js needs a real canvas; the stand-in only marks where the terminal is.
vi.mock("./SignInTerminal", () => ({
  SignInTerminal: ({ name }: { name: string }) => (
    <div role="group" aria-label={`${name} sign-in terminal`} />
  ),
}));

const mini: SshHost = { id: "h-mini", name: "Mac mini", destination: "mini" };
const states: Record<string, ConnectionState> = {
  local: { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} },
  [mini.id]: {
    status: "failed",
    retrying: false,
    error: { reason: "exited", message: "plxd exited." },
  },
};
const secret = "sk-proj-THE-SECRET-0123456789abcdef";

type Answer = { result: unknown } | { error: { code: number; message: string; data?: object } };
let answers: Record<
  string,
  (params: Record<string, unknown>, host: string) => Answer | Promise<Answer>
>;
const request = vi.fn(async (host: string, method: string, params: Record<string, unknown>) => {
  const answer = (await answers[method]?.(params, host)) ?? {
    error: { code: -32601, message: "no" },
  };
  return "result" in answer ? { ...answer, logId: "log" } : answer;
});
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([host, , params]) => ({ host, params }));

beforeEach(() => {
  request.mockClear();
  answers = {
    "accounts/list": () => ({
      result: {
        checkedAt: "2026-09-28T12:00:00Z",
        clis: [
          { cli: "claude", installed: true, version: "2.1.281", plan: "max", signedIn: true },
          { cli: "codex", installed: true, version: "0.156.1", signedIn: false },
          { cli: "cursor", installed: false },
        ],
      },
    }),
    "accounts/keys/list": () => ({
      result: {
        accounts: [
          {
            id: "k-work",
            provider: "anthropic",
            label: "Work",
            createdAt: "2026-09-28T12:00:00Z",
            maskedKey: "sk-ant-...abcd",
          },
        ],
      },
    }),
  };
  window.parallax = {
    platform: "darwin",
    version: async () => "0.0.0-local",
    terminalApp: async () => null,
    terminalApps: async () => [],
    openTargetIcons: async () => ({}),
    command: async () => ({ state: "unavailable", path: "", onPath: true }),
    connectionState: async (hostId) => states[hostId]!,
    onConnectionState: () => () => {},
    hosts: async () => [mini],
    onHosts: () => () => {},
    onConnect: () => () => {},
    onDevices: () => () => {},
    onLocalName: (listener: (name: string) => void) => {
      listener("This Mac");
      return () => {};
    },
    setZoom: () => {},
    request: request as unknown as ParallaxBridge["request"],
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
  vi.useRealTimers();
});

async function renderSettings(
  name: SettingsSection = "providers",
  listed: ComponentProps<typeof Settings>["listed"] = [],
) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <Settings section={name} listed={listed} theme="system" onThemeChange={() => {}} />
        <Notifications />
      </>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
// The first match outside a hidden tab panel.
const visible = (selector: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((e) => !e.closest("[hidden]"))!;
const section = (name: string) => visible(`[aria-label="${name}"]`);
const rows = (name: string) =>
  [...section(name).querySelectorAll(":scope > div:last-child > div")].map((r) => r.textContent);
const button = (within: Element, name: string) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent === name)!;
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.trim().startsWith(name),
  )!;
/** The newest notification's text, which an action's result is. */
const notice = () =>
  document.querySelector('[aria-label="Notifications"] > div')?.textContent ?? undefined;
// The Work key's row.
const work = () =>
  [...section("Anthropic API keys").querySelectorAll("div")].find((d) =>
    d.textContent?.startsWith("Work"),
  )!;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

test("adds a key, clearing it from its field after each try, and never gets it back", async () => {
  await renderSettings();
  await click(tab("Codex"));
  await click(button(section("OpenAI API keys"), "Add API key"));
  const form = document.querySelector<HTMLFormElement>('form[aria-label="Add API key"]')!;
  const keyField = form.querySelector<HTMLInputElement>('[name="key"]')!;
  const submit = async () => {
    form.querySelector<HTMLInputElement>('[name="label"]')!.value = "Personal";
    keyField.value = secret;
    await act(async () => form.requestSubmit());
    await settle();
  };

  answers["accounts/keys/add"] = () => ({
    error: {
      code: -32000,
      message: "the keychain is locked or access was denied",
      data: { kind: "keychainUnavailable" },
    },
  });
  await submit();
  expect(notice()).toBe(
    "Couldn't add the API keyThis host's keychain isn't available: the keychain is locked or access was denied.",
  );
  expect(keyField.value).toBe("");

  answers["accounts/keys/add"] = (p) => ({
    result: {
      account: {
        id: p["id"],
        provider: p["provider"],
        label: p["label"],
        createdAt: "2026-09-28T12:05:00Z",
        maskedKey: "sk-proj-...cdef",
      },
    },
  });
  await submit();
  const [first, retry] = calls("accounts/keys/add");
  expect(retry).toEqual(first);
  expect(first!.params).toMatchObject({ provider: "openai", label: "Personal", key: secret });
  expect(document.querySelector("form")).toBeNull();
  expect(rows("OpenAI API keys")).toEqual(["PersonalOpenAI API key · sk-proj-...cdefRemove"]);
  expect(document.body.innerHTML).not.toContain("THE-SECRET");
});

test("removes a key only once it's confirmed", async () => {
  answers["accounts/keys/remove"] = () => ({ result: {} });
  await renderSettings();
  await click(button(work(), "Remove"));
  expect(work().textContent).toContain("Remove this key?");
  await click(button(work(), "Cancel"));
  expect(calls("accounts/keys/remove")).toEqual([]);

  await click(button(work(), "Remove"));
  await click(button(work(), "Remove"));
  expect(calls("accounts/keys/remove")).toEqual([{ host: "local", params: { id: "k-work" } }]);
  expect(rows("Anthropic API keys")).toEqual([]);
});

test("Storage deletes only a host's archived threads, after asking", async () => {
  window.parallax.storage = async () => [];
  answers["thread/list"] = () => ({
    result: {
      repos: [],
      threads: [
        { id: "t-old", repo: "r", archived: true, createdAt: "" },
        { id: "t-live", repo: "r", createdAt: "" },
      ],
    },
  });
  answers["thread/delete"] = () => ({ result: {} });
  await renderSettings("storage");
  const archived = section("Archived threads");
  expect(archived.textContent).toContain("1 archived thread");
  await click(button(archived, "Delete all"));
  expect(calls("thread/delete")).toEqual([]);
  await click(button(archived, "Delete all"));
  expect(calls("thread/delete")).toEqual([{ host: "local", params: { runId: "t-old" } }]);
});

describe("on a plxd with providers", () => {
  const instance = (id: string, kind: ProviderKind, name: string): ProviderInstance => ({
    id,
    kind,
    name,
    enabled: true,
    args: [],
    env: [],
    models: [],
  });
  let listed: ProviderInfo[];
  const result = () => ({ result: { providers: listed, checkedAt: "2026-09-28T12:00:00Z" } });
  // The instance the last `providers/save` sent.
  const saved = () => calls("providers/save").at(-1)!.params["instance"];

  beforeEach(() => {
    states["local"] = { ...states["local"]!, capabilities: { providers: {} } } as ConnectionState;
    listed = [
      {
        instance: instance("claude", "claude", "Claude Code"),
        installed: true,
        version: "2.1.281",
        signedIn: true,
        account: "ryan@example.com",
        models: [],
        permissions: ["edit"],
        efforts: true,
        coordinator: true,
        login: ["claude", "auth", "login"],
      },
      {
        instance: instance("codex", "codex", "Codex"),
        installed: true,
        signedIn: false,
        models: [],
        permissions: ["edit"],
        efforts: true,
        coordinator: false,
        login: ["codex", "login"],
      },
    ];
    answers["providers/list"] = result;
    answers["providers/save"] = (p) => {
      const next = p["instance"] as ProviderInstance;
      const i = listed.findIndex((each) => each.instance.id === next.id);
      const entry = { ...(listed[i] ?? listed[1]!), instance: next };
      listed = i < 0 ? [...listed, entry] : listed.map((each, j) => (j === i ? entry : each));
      return result();
    };
    window.parallax.acpRegistry = async () => [
      {
        id: "pi-acp",
        name: "pi ACP",
        version: "0.0.34",
        description: "Pi over ACP",
        distribution: { npx: { package: "pi-acp@0.0.34" } },
      },
      {
        id: "gemini",
        name: "Gemini CLI",
        version: "0.62.0",
        description: "Google's agent in the terminal",
        repository: "https://github.com/google-gemini/gemini-cli",
        distribution: { npx: { package: "@google/gemini-cli@0.62.0", args: ["--acp"] } },
      },
    ];
  });
  afterEach(() => {
    states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
    states[mini.id] = {
      status: "failed",
      retrying: false,
      error: { reason: "exited", message: "plxd exited." },
    };
  });

  const dialog = () => document.querySelector("dialog")!;
  const next = async () => {
    await act(async () => dialog().querySelector("form")!.requestSubmit());
    await settle();
  };

  test.each([false, true])(
    "pool setup requires accountPools capability (%s)",
    async (supported) => {
      if (supported)
        states["local"] = {
          ...states["local"]!,
          capabilities: { providers: {}, accountPools: {} },
        } as ConnectionState;
      await renderSettings();
      await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
      await click(button(dialog(), "CodexOpenAI's agent"));
      expect(dialog().textContent?.includes("Several accounts")).toBe(supported);
      expect(dialog().textContent?.includes("Create pool")).toBe(supported);
    },
  );

  const poolAccounts = () => {
    states["local"] = {
      ...states["local"]!,
      capabilities: { providers: {}, accountPools: {} },
    } as ConnectionState;
    listed.push(
      {
        ...listed[1]!,
        instance: { ...instance("work", "codex", "Work"), home: "~/.codex-work" },
        signedIn: true,
        account: "work@example.test",
      },
      {
        ...listed[1]!,
        instance: { ...instance("backup", "codex", "Backup"), home: "~/.codex-backup" },
        signedIn: true,
      },
      {
        ...listed[1]!,
        instance: { ...instance("pool", "codex", "Codex pool"), members: ["codex", "work"] },
      },
    );
  };
  const providerNames = () =>
    [...document.querySelectorAll('[role="tablist"][aria-label="Providers"] [role="tab"]')].map(
      (t) => t.textContent,
    );

  test("pool members are managed inside their pool without standalone provider rows", async () => {
    poolAccounts();
    await renderSettings();
    expect(providerNames()).toHaveLength(3);
    expect(tab("Codex")).toBe(tab("Codex pool"));
    expect(tab("Work")).toBeUndefined();
    await click(tab("Codex pool"));
    await click(button(section("Accounts"), "Sign in"));
    expect(visible('[role="tabpanel"] h2').textContent).toBe("Codex");
    expect(tab("Codex pool").getAttribute("aria-selected")).toBe("true");
    expect(visible('[aria-label="Codex sign-in terminal"]')).toBeDefined();
    expect(providerNames()).toHaveLength(3);
    await click(button(document.body, "Back to Codex pool"));
    const workSettings = document.querySelector<HTMLElement>('[aria-label="Settings for Work"]')!;
    workSettings.focus();
    await click(workSettings);
    expect(document.activeElement).toBe(button(document.body, "Back to Codex pool"));
    expect(visible('[role="tabpanel"] h2').textContent).toBe("Work");
    expect(providerNames()).toHaveLength(3);
    expect(document.querySelector('[aria-label="Work sign-in terminal"]')).toBeNull();
    expect(document.querySelector('[aria-label="Codex sign-in terminal"]')).not.toBeNull();
    await click(button(document.body, "Back to Codex pool"));
    expect(document.activeElement).toBe(workSettings);
  });

  test("a disabled pool member can be enabled inside its settings without a standalone row", async () => {
    poolAccounts();
    listed[1] = { ...listed[1]!, instance: { ...listed[1]!.instance, enabled: false } };
    await renderSettings();
    await click(tab("Codex pool"));
    await click(visible('[aria-label="Settings for Codex"]'));
    const toggle = visible('[role="switch"][aria-label="Use Codex"]');
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    await click(toggle);
    expect(saved()).toMatchObject({ id: "codex", enabled: true });
    expect(visible('[role="switch"][aria-label="Use Codex"]').getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(providerNames()).toHaveLength(3);
    expect(tab("Codex")).toBe(tab("Codex pool"));
    expect(tab("Codex pool").getAttribute("aria-selected")).toBe("true");
  });

  test("joining a pool hides a standalone account and leaving restores it", async () => {
    poolAccounts();
    await renderSettings();
    expect(tab("Backup")).toBeDefined();
    await click(tab("Codex pool"));
    await click(visible('[aria-label="Pool Backup"]'));
    expect(tab("Backup")).toBeUndefined();
    expect(listed.find((p) => p.instance.id === "pool")?.instance.members).toEqual([
      "codex",
      "work",
      "backup",
    ]);
    await click(visible('[aria-label="Pool Codex"]'));
    expect(tab("Codex").textContent).toMatch(/^Codex(?! pool)/);
    expect(listed.find((p) => p.instance.id === "pool")?.instance.members).toEqual([
      "work",
      "backup",
    ]);
  });

  test("copies another computer's missing accounts, then its pools, and keeps its own", async () => {
    states[mini.id] = { ...states["local"]!, capabilities: { providers: {} } } as ConnectionState;
    const codex = listed[1]!;
    const theirs = [
      { ...codex, instance: { ...codex.instance, name: "Mini's Codex" } },
      {
        ...codex,
        instance: { ...instance("pool", "codex", "Codex pool"), members: ["codex", "work"] },
      },
      {
        ...codex,
        instance: {
          ...instance("work", "codex", "Work"),
          home: "/Users/ryan/.codex-work",
          env: [{ name: "OPENAI_API_KEY", secret: true }],
        },
      },
    ];
    const ours = answers["providers/list"]!;
    answers["providers/list"] = (params, host) =>
      host === mini.id
        ? { result: { providers: theirs, checkedAt: "2026-09-28T12:00:00Z" } }
        : ours(params, host);
    await renderSettings();
    await click(document.querySelector<HTMLElement>('[aria-label="Copy from another computer"]')!);
    await click(button(visible('[role="menu"][aria-label="Copy from"]'), "Mac mini"));
    expect(calls("providers/save")).toEqual([
      { host: "local", params: { instance: { ...theirs[2]!.instance, home: "~/.codex-work" } } },
      { host: "local", params: { instance: theirs[1]!.instance } },
    ]);
    expect(listed.find((p) => p.instance.id === "codex")?.instance.name).toBe("Codex");
    expect(notice()).toContain("Copied 2 from Mac mini");
  });

  test("adds a model service with its key as a secret", async () => {
    await renderSettings();
    await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
    // A card goes on to its identity.
    await click(button(dialog(), "OpenRouterClaude Code on any model"));
    const id = [...dialog().querySelectorAll("input")][1]!;
    expect(id.value).toBe("openrouter");
    await next();
    const key = dialog().querySelector<HTMLInputElement>(
      '[aria-label="Value of ANTHROPIC_AUTH_TOKEN"]',
    )!;
    expect(key.type).toBe("password");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        key,
        "sk-or-1",
      );
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await next();
    expect(saved()).toEqual({
      id: "openrouter",
      kind: "openRouter",
      name: "OpenRouter",
      enabled: true,
      args: [],
      env: [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", secret: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or-1", secret: true },
      ],
      models: [],
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(tab("OpenRouter").getAttribute("aria-selected")).toBe("true");
  });
});
