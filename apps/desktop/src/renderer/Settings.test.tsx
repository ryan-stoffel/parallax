// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, SshHost, ParallaxBridge } from "../preload/bridge";
import type {
  Hub,
  ProviderInfo,
  ProviderInstance,
  ProviderKind,
} from "../protocol/generated/protocol";
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
let answers: Record<string, (params: Record<string, unknown>) => Answer | Promise<Answer>>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = (await answers[method]?.(params)) ?? { error: { code: -32601, message: "no" } };
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
  });

  const dialog = () => document.querySelector("dialog")!;
  const next = async () => {
    await act(async () => dialog().querySelector("form")!.requestSubmit());
    await settle();
  };

  test("a second account of a provider is warned about, and the first isn't", async () => {
    await renderSettings();
    await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
    await click(button(dialog(), "CodexOpenAI's agent"));
    expect(dialog().querySelector('[role="note"]')?.textContent).toContain(
      "already has a Codex account.",
    );
    await next();
    await next();
    expect(saved()).toMatchObject({ id: "codex-2", kind: "codex" });

    // A row by its instance's id, since Claude's shows its email blurred.
    const mark = (id: string) =>
      document
        .querySelector(`[role="tab"][aria-controls$="-${id}-pane"]`)!
        .parentElement!.querySelector('button[aria-label="Several accounts"]');
    expect(mark("claude")).toBeNull();
    expect(mark("codex")).toBeNull();
    expect(mark("codex-2")).not.toBeNull();
    const popover = document.getElementById(mark("codex-2")!.getAttribute("popovertarget")!)!;
    expect(popover.textContent).toContain("aren't supported");
    expect(popover.textContent).toContain("CLIProxyAPI hub");
    expect([...popover.querySelectorAll("a")].map((a) => a.href)).toEqual([
      "https://help.router-for.me/",
      "https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af",
    ]);
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
  describe("with hubs", () => {
    const capabilities = { providers: {}, hubs: {} };
    let hubs: Hub[];
    const home: Hub = {
      id: "home-hub",
      name: "Home hub",
      url: "https://hub.example:8317",
      enabled: true,
      hasManagementKey: true,
      claude: "home-hub-claude",
      codex: "home-hub-codex",
      reachable: true,
      claudeModels: [{ id: "claude-opus-5-5", name: "claude-opus-5-5" }],
      codexModels: [
        { id: "gpt-6-sol", name: "gpt-6-sol" },
        { id: "gemini-3-pro", name: "gemini-3-pro" },
      ],
      accounts: [
        {
          id: "claude-ada.json",
          provider: "claude",
          email: "ada@example.com",
          disabled: false,
          limits: [{ window: "five_hour", usedPercent: 42, capturedAt: "2026-09-28T12:00:00Z" }],
        },
        {
          id: "codex-old.json",
          provider: "codex",
          plan: "pro",
          disabled: true,
          limits: [],
        },
      ],
      checkedAt: "2026-09-28T12:00:00Z",
    };
    const type = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const labeled = (name: string) =>
      [...dialog().querySelectorAll("label")]
        .find((l) => l.textContent?.startsWith(name))!
        .querySelector("input")!;

    beforeEach(() => {
      hubs = [];
      for (const id of ["local", mini.id])
        states[id] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities };
      answers["hubs/list"] = () => ({ result: { hubs } });
      answers["hubs/save"] = (p) => {
        hubs = [{ ...home, ...p }];
        return { result: { hubs } };
      };
      // A hub's own instances, which only its page edits.
      listed.push({
        ...listed[0]!,
        instance: instance("home-hub-claude", "claude", "Home hub"),
        hub: "home-hub",
      });
    });
    afterEach(() => {
      states[mini.id] = {
        status: "failed",
        retrying: false,
        error: { reason: "exited", message: "plxd exited." },
      };
    });

    test("adds a hub to every computer with hubs at once, and shows its page", async () => {
      await renderSettings();
      expect(tab("Home hub")).toBeUndefined();
      await click(document.querySelector<HTMLElement>('[aria-label="Add hub"]')!);
      expect(dialog().textContent).toContain("Theo's setup guide");
      await type(labeled("Name"), "Home hub");
      await type(labeled("URL"), "https://hub.example:8317");
      await type(labeled("Access key"), "hub-access");
      await type(labeled("Management key"), "hub-manage");
      const boxes = [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      expect(boxes.map((b) => [b.parentElement!.textContent, b.checked])).toEqual([
        ["This Mac", true],
        ["Mac mini", true],
      ]);
      expect(button(dialog(), "Add to 2 computers")).toBeDefined();
      await next();

      const saves = calls("hubs/save");
      expect(saves.map((s) => s.host)).toEqual(["local", mini.id]);
      expect(saves[1]!.params).toEqual(saves[0]!.params);
      expect(saves[0]!.params).toEqual({
        id: "home-hub",
        name: "Home hub",
        url: "https://hub.example:8317",
        enabled: true,
        accessKey: "hub-access",
        managementKey: "hub-manage",
      });
      expect(document.querySelector("dialog")).toBeNull();

      expect(tab("Home hub").getAttribute("aria-selected")).toBe("true");
      const page = visible('[role="tabpanel"]');
      expect(page.textContent).toContain("Connected · 3 models");
      expect(page.textContent).toContain("gemini-3-pro");
      expect(page.textContent).toContain("5-hour limit · 42% used");
      expect(page.textContent).toContain("Off on the hub");
      expect(page.textContent).not.toContain("ada@example.com");

      answers["hubs/remove"] = () => ({ result: { hubs: [] } });
      await click(document.querySelector<HTMLElement>('[aria-label="Remove Home hub"]')!);
      await click(button(document.body, "Remove"));
      expect(calls("hubs/remove")).toEqual([{ host: "local", params: { id: "home-hub" } }]);
      expect(tab("Home hub")).toBeUndefined();
    });

    test("the several-accounts warning opens Add hub", async () => {
      listed.push({ ...listed[1]!, instance: instance("codex-2", "codex", "Codex 2") });
      await renderSettings();
      const mark = document
        .querySelector('[role="tab"][aria-controls$="-codex-2-pane"]')!
        .parentElement!.querySelector<HTMLElement>('button[aria-label="Several accounts"]')!;
      const popover = document.getElementById(mark.getAttribute("popovertarget")!)!;
      await click(button(popover, "Set up a hub"));
      expect(dialog().textContent).toContain("Add hub");
    });

    test("a retry after one computer fails saves the same hub only to that one", async () => {
      let tries = 0;
      answers["hubs/save"] = (p) => {
        // The first try's second save, the Mac mini's, fails.
        if (++tries === 2) return { error: { code: -32000, message: "keychain locked" } };
        hubs = [{ ...home, ...p }];
        return { result: { hubs } };
      };
      await renderSettings();
      await click(document.querySelector<HTMLElement>('[aria-label="Add hub"]')!);
      await type(labeled("URL"), "https://hub.example:8317");
      await type(labeled("Access key"), "hub-access");
      await next();
      expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
        "Mac mini: keychain locked",
      );
      await next();
      expect(calls("hubs/save").map((s) => [s.host, s.params["id"]])).toEqual([
        ["local", "home-hub"],
        [mini.id, "home-hub"],
        [mini.id, "home-hub"],
      ]);
      expect(document.querySelector("dialog")).toBeNull();
    });

    describe("with hubAccounts", () => {
      const page = () => visible('[role="tabpanel"]');
      const open = vi.fn();
      // The status answers in order, then the last one again.
      let statuses: { status: string; problem?: string }[];
      beforeEach(() => {
        states["local"] = {
          status: "connected",
          plxd: "0.1.0",
          protocol: 1,
          capabilities: { ...capabilities, hubAccounts: {} },
        };
        hubs = [home];
        open.mockClear();
        window.open = open;
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        answers["hubs/accounts/signIn"] = (p) => ({
          result: { url: `https://example.com/oauth/${String(p["service"])}`, state: "s1" },
        });
        statuses = [{ status: "waiting" }];
        answers["hubs/accounts/status"] = () => ({
          result: statuses.length > 1 ? statuses.shift() : statuses[0],
        });
      });
      const poll = async () => {
        await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
        await settle();
      };
      const addAccount = async (service: "Claude" | "Codex") => {
        await renderSettings();
        await click(tab("Home hub"));
        await click(button(page(), "Add account"));
        expect(page().textContent).toContain("not a VPS");
        await click(button(page(), service));
      };

      test("adds an account whose browser the hub's forwarder catches", async () => {
        statuses = [{ status: "waiting" }, { status: "done" }];
        await addAccount("Claude");
        expect(calls("hubs/accounts/signIn")[0]!.params).toEqual({
          hub: "home-hub",
          service: "claude",
        });
        expect(open).toHaveBeenCalledWith("https://example.com/oauth/claude", "_blank");
        expect(page().textContent).toContain("Waiting for the browser");
        await poll();
        expect(page().textContent).toContain("Waiting for the browser");
        const lists = calls("hubs/list").length;
        await poll();
        expect(page().textContent).toContain("Signed in");
        expect(calls("hubs/accounts/status")).toHaveLength(2);
        expect(calls("hubs/list").slice(lists)).toEqual([
          { host: "local", params: { refresh: true } },
        ]);
      });

      test("adds an account from the pasted address after checking it's this sign-in's", async () => {
        answers["hubs/accounts/callback"] = () => ({ result: { status: "waiting" } });
        await addAccount("Codex");
        const address = page().querySelector<HTMLInputElement>(
          '[aria-label="Address after signing in"]',
        )!;
        await type(address, "http://localhost:1455/auth/callback?code=c&state=other");
        await click(button(page(), "Send"));
        expect(page().querySelector('[role="alert"]')?.textContent).toBe(
          "That address is from another sign-in.",
        );
        expect(calls("hubs/accounts/callback")).toEqual([]);

        const pasted = "http://localhost:1455/auth/callback?code=c&state=s1";
        await type(address, pasted);
        await click(button(page(), "Send"));
        expect(calls("hubs/accounts/callback")[0]!.params).toEqual({
          hub: "home-hub",
          state: "s1",
          redirectUrl: pasted,
        });
        statuses = [{ status: "done" }];
        await poll();
        expect(page().textContent).toContain("The hub added the ChatGPT account.");
      });

      test("shows a failed sign-in, and cancels one", async () => {
        statuses = [{ status: "failed", problem: "The sign-in timed out. Start it again." }];
        await addAccount("Claude");
        await poll();
        expect(page().textContent).toContain("Sign-in failed");
        expect(page().textContent).toContain("The sign-in timed out.");

        statuses = [{ status: "waiting" }];
        answers["hubs/accounts/cancel"] = () => ({ result: { status: "cancelled" } });
        await click(button(page(), "Try again"));
        await click(button(page(), "Cancel"));
        expect(calls("hubs/accounts/cancel")[0]!.params).toEqual({ hub: "home-hub", state: "s1" });
        expect(page().textContent).toContain("Sign-in cancelled");
      });

      test("turns an account off, and removes one after a confirm", async () => {
        answers["hubs/accounts/setEnabled"] = (p) => {
          hubs = [
            {
              ...home,
              accounts: home.accounts.map((a) =>
                a.id === p["account"] ? { ...a, disabled: !p["enabled"] } : a,
              ),
            },
          ];
          return { result: { hubs } };
        };
        answers["hubs/accounts/remove"] = (p) => {
          hubs = [{ ...home, accounts: home.accounts.filter((a) => a.id !== p["account"]) }];
          return { result: { hubs } };
        };
        await renderSettings();
        await click(tab("Home hub"));
        expect(page().textContent).not.toContain("Off on the hub");
        const use = () => page().querySelector<HTMLElement>('[aria-label="Use ada@example.com"]')!;
        expect(use().getAttribute("aria-checked")).toBe("true");
        await click(use());
        expect(calls("hubs/accounts/setEnabled")[0]!.params).toEqual({
          hub: "home-hub",
          account: "claude-ada.json",
          enabled: false,
        });
        expect(use().getAttribute("aria-checked")).toBe("false");

        await click(page().querySelector<HTMLElement>('[aria-label="Remove ada@example.com"]')!);
        expect(page().textContent).toContain("Remove it from the hub?");
        expect(calls("hubs/accounts/remove")).toEqual([]);
        await click(button(page(), "Remove"));
        expect(calls("hubs/accounts/remove")[0]!.params).toEqual({
          hub: "home-hub",
          account: "claude-ada.json",
        });
        expect(page().querySelector('[aria-label="Use ada@example.com"]')).toBeNull();
      });
    });

    test("Add provider won't take a hub instance's id", async () => {
      await renderSettings();
      await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
      await click(button(dialog(), "Claude CodeAnthropic's agent"));
      await type(
        [...dialog().querySelectorAll("label")]
          .find((l) => l.textContent?.startsWith("Id"))!
          .querySelector("input")!,
        "home-hub-claude",
      );
      expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
        "Another provider on this host has it.",
      );
    });
  });
});
