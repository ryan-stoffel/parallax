// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, SshHost, WispBridge } from "../preload/bridge";
import { Settings } from "./Settings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mini: SshHost = { id: "h-mini", name: "Mac mini", destination: "mini" };
const states: Record<string, ConnectionState> = {
  local: { status: "connected", wispd: "0.1.0", protocol: 1 },
  [mini.id]: {
    status: "failed",
    retrying: false,
    error: { reason: "exited", message: "wispd exited." },
  },
};
const secret = "sk-proj-THE-SECRET-0123456789abcdef";

type Answer = { result: unknown } | { error: { code: number; message: string; data?: object } };
let answers: Record<string, (params: Record<string, unknown>) => Answer>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method]?.(params) ?? { error: { code: -32601, message: "no" } };
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
          { cli: "claude", installed: true, version: "2.1.281", plan: "Max", signedIn: true },
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
  window.wisp = {
    platform: "darwin",
    connectionState: async (hostId) => states[hostId]!,
    onConnectionState: () => () => {},
    hosts: async () => [mini],
    onHosts: () => () => {},
    request: request as unknown as WispBridge["request"],
  } as Partial<WispBridge> as WispBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function renderProviders() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <Settings section="providers" addingHost={false} theme="system" onThemeChange={() => {}} />,
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
const section = (name: string) => document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
const rows = (name: string) =>
  [...section(name).querySelectorAll(":scope > div:last-child > div")].map((r) => r.textContent);
const button = (within: Element, name: string) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

test("lists each connected host's CLIs and keys, and links a missing CLI to its install page", async () => {
  await renderProviders();
  expect(rows("This Mac")).toEqual([
    "Claude Code2.1.281 · MaxSigned in",
    "Codex0.156.1Not signed in",
    "CursorNot installedInstall",
    "WorkAnthropic API key · sk-ant-...abcdRemove",
  ]);
  const install = section("This Mac").querySelector("a")!;
  expect(install.href).toBe("https://cursor.com/docs/cli/installation");
  expect(install.target).toBe("_blank");

  expect(section("Mac mini").textContent).toContain("Disconnected");
  expect(request.mock.calls.every(([host]) => host === "local")).toBe(true);
});

test("adds a key, clearing it from its field after each try, and never gets it back", async () => {
  await renderProviders();
  await click(button(section("This Mac"), "Add API key"));
  const form = document.querySelector<HTMLFormElement>('form[aria-label="Add API key"]')!;
  const keyField = form.querySelector<HTMLInputElement>('[name="key"]')!;
  const submit = async () => {
    form.querySelector<HTMLSelectElement>('[name="provider"]')!.value = "openai";
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
  expect(rows("This Mac").at(-1)).toBe("PersonalOpenAI API key · sk-proj-...cdefRemove");
  expect(document.body.innerHTML).not.toContain("THE-SECRET");
});

test("removes a key only once it's confirmed", async () => {
  answers["accounts/keys/remove"] = () => ({ result: {} });
  await renderProviders();
  const work = () =>
    [...section("This Mac").querySelectorAll("div")].find((d) =>
      d.textContent?.startsWith("Work"),
    )!;

  await click(button(work(), "Remove"));
  expect(work().textContent).toContain("Remove this key?");
  await click(button(work(), "Cancel"));
  expect(calls("accounts/keys/remove")).toEqual([]);

  await click(button(work(), "Remove"));
  await click(button(work(), "Remove"));
  expect(calls("accounts/keys/remove")).toEqual([{ host: "local", params: { id: "k-work" } }]);
  expect(section("This Mac").textContent).not.toContain("Work");
});

test("Refresh probes the CLIs again", async () => {
  answers["accounts/refresh"] = () => ({
    result: {
      checkedAt: "2026-09-28T12:10:00Z",
      clis: [{ cli: "claude", installed: true, signedIn: false }],
    },
  });
  await renderProviders();
  await click(button(section("This Mac"), "Refresh"));
  expect(calls("accounts/refresh")).toHaveLength(1);
  expect(rows("This Mac")[0]).toBe("Claude CodeInstalledNot signed in");
});
