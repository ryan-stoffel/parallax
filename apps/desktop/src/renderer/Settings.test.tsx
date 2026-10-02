// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, SshHost, ParallaxBridge } from "../preload/bridge";
import type { SettingsSection } from "./App";
import { models } from "./models";
import { Settings } from "./Settings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
    connectionState: async (hostId) => states[hostId]!,
    onConnectionState: () => () => {},
    hosts: async () => [mini],
    onHosts: () => () => {},
    request: request as unknown as ParallaxBridge["request"],
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.useRealTimers();
});

async function renderSettings(name: SettingsSection = "providers") {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Settings section={name} theme="system" onThemeChange={() => {}} />));
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
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.startsWith(name),
  )!;
const pane = () => visible('[role="tabpanel"]');
// The Work key's row.
const work = () =>
  [...section("Anthropic API keys").querySelectorAll("div")].find((d) =>
    d.textContent?.startsWith("Work"),
  )!;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

test("lists the host's CLIs, and shows the chosen one's account, API keys, and models", async () => {
  await renderSettings();
  expect(tabs()).toEqual([
    "Claude Code2.1.281Signed in · Max",
    "Codex0.156.1Not signed in",
    "CursorNot installed",
  ]);
  expect(tab("Claude Code").getAttribute("aria-selected")).toBe("true");
  expect(pane().getAttribute("aria-labelledby")).toBe(tab("Claude Code").id);
  expect(rows("Account")).toEqual(["Signed in · Max"]);
  expect(rows("Anthropic API keys")).toEqual(["WorkAnthropic API key · sk-ant-...abcdRemove"]);
  expect(rows("Models")).toEqual(
    models.filter((m) => m.provider === "Claude").map((m) => m.name + m.id),
  );

  // Down moves to the next tab and chooses it.
  await act(async () =>
    tab("Claude Code").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(tab("Codex"));
  expect(rows("Account")).toEqual(["Not signed inSign in"]);
  expect(rows("OpenAI API keys")).toEqual([]);

  // Cursor takes no API key (0004), and links to its install page.
  await click(tab("Cursor"));
  expect(rows("Account")).toEqual([
    "Not installedInstall Cursor on this host, then refresh.Install",
  ]);
  expect(pane().querySelector('[aria-label$="API keys"]')).toBeNull();
  const install = section("Account").querySelector("a")!;
  expect(install.href).toBe("https://cursor.com/docs/cli/installation");
  expect(install.target).toBe("_blank");
  expect(request.mock.calls.every(([host]) => host === "local")).toBe(true);
});

test("a sign-in stays open while another tab is chosen", async () => {
  await renderSettings();
  await click(tab("Codex"));
  await click(button(pane(), "Sign in"));
  const terminal = section("Codex sign-in terminal");
  expect(terminal).toBeDefined();

  await click(tab("Claude Code"));
  expect(terminal.closest("[hidden]")).not.toBeNull();
  await click(tab("Codex"));
  expect(section("Codex sign-in terminal")).toBe(terminal);
});

test("opening a sign-in closes the other one, since the window runs one terminal", async () => {
  answers["accounts/list"] = () => ({
    result: {
      checkedAt: "2026-09-28T12:00:00Z",
      clis: [
        { cli: "claude", installed: true, signedIn: false },
        { cli: "codex", installed: true, signedIn: false },
      ],
    },
  });
  await renderSettings();
  await click(button(pane(), "Sign in"));
  await click(tab("Codex"));
  await click(button(pane(), "Sign in"));
  const terminals = [...document.querySelectorAll('[aria-label$="sign-in terminal"]')];
  expect(terminals.map((t) => t.getAttribute("aria-label"))).toEqual(["Codex sign-in terminal"]);
});

test("keys still show when the CLIs can't be checked", async () => {
  answers["accounts/list"] = () => ({ error: { code: -32000, message: "probe failed" } });
  await renderSettings();
  expect(tabs()).toEqual([]);
  expect(rows("API keys")).toEqual(["WorkAnthropic API key · sk-ant-...abcdRemove"]);
});

test("the host picker shows another host's state", async () => {
  await renderSettings();
  const picker = section("Host") as HTMLSelectElement;
  await act(async () => {
    picker.value = mini.id;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(tabs()).toEqual([]);
  expect(document.body.textContent).toContain("Disconnected");
});

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
  expect(form.querySelector('[role="alert"]')!.textContent).toBe(
    "This host's keychain isn't available: the keychain is locked or access was denied.",
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

test("a key another client already removed goes when removed", async () => {
  answers["accounts/keys/remove"] = () => ({
    error: { code: -32000, message: "account not found", data: { kind: "accountNotFound" } },
  });
  await renderSettings();
  await click(button(work(), "Remove"));
  await click(button(work(), "Remove"));
  expect(rows("Anthropic API keys")).toEqual([]);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test("Refresh probes the CLIs again, without undoing a remove made meanwhile", async () => {
  let probed = () => {};
  answers["accounts/refresh"] = () =>
    new Promise((resolve) => {
      probed = () =>
        resolve({
          result: {
            checkedAt: "2026-09-28T12:10:00Z",
            clis: [{ cli: "claude", installed: true, signedIn: false }],
          },
        });
    });
  answers["accounts/keys/remove"] = () => ({ result: {} });
  await renderSettings();
  await click(document.querySelector<HTMLElement>('[aria-label="Refresh"]')!);
  await click(button(work(), "Remove"));
  await click(button(work(), "Remove"));
  await act(async () => probed());
  await settle();
  expect(calls("accounts/refresh")).toHaveLength(1);
  expect(tabs()).toEqual(["Claude CodeNot signed in"]);
  expect(rows("Anthropic API keys")).toEqual([]);
});

test("shows each account's usage and limits for the chosen period, and keeps them live", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-28T12:00:00Z"), toFake: ["setTimeout", "Date"] });
  const tokens = (input: number, output = 0) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  let used = 12;
  answers["usage/get"] = () => ({
    result: {
      accounts: [
        {
          accountId: "claude",
          today: { ...tokens(1000, 200), costUsdMicros: 500_000 },
          week: { ...tokens(40_000, 2000), costUsdMicros: 900_000 },
          limits: [
            {
              window: "five_hour",
              usedPercent: used,
              resetsAt: "2026-09-28T14:00:00Z",
              capturedAt: "2026-09-28T11:59:00Z",
            },
          ],
        },
        { accountId: "k-work", today: tokens(0), week: tokens(3_000_000), limits: [] },
        { accountId: "k-gone", today: tokens(5), week: tokens(5), limits: [] },
      ],
    },
  });
  await renderSettings();
  expect(document.body.textContent).toContain("Checked just now");
  expect(rows("Usage")).toEqual([
    "1.2K tokens today, about $0.505-hour limit · 12% used · resets in 2 h",
  ]);
  expect(rows("Anthropic API keys")).toEqual([
    "WorkAnthropic API key · sk-ant-...abcdNo usage todayRemove",
  ]);

  await click(section("Usage period").querySelector<HTMLInputElement>('[value="week"]')!);
  expect(rows("Usage")).toEqual([
    "42K tokens this week, about $0.905-hour limit · 12% used · resets in 2 h",
  ]);
  expect(rows("Anthropic API keys")).toEqual([
    "WorkAnthropic API key · sk-ant-...abcd3M tokens this weekRemove",
  ]);
  await click(tab("Codex"));
  expect(rows("Usage")).toEqual(["No usage this week"]);

  // A run hits the limit: the next poll shows it.
  used = 100;
  await click(tab("Claude Code"));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await settle();
  expect(calls("usage/get")).toHaveLength(2);
  expect(rows("Usage")[0]).toContain("5-hour limit reached · resets in 2 h");
});
