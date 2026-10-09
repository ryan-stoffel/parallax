// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, Profile, SshHost, ParallaxBridge } from "../preload/bridge";
import type { ProviderInfo, ProviderInstance, ProviderKind } from "../protocol/generated/protocol";
import type { SettingsSection } from "./App";
import { models } from "./models";
import { behaviorDefaults, behaviorPrefs, setBehaviorPrefs } from "./prefs";
import { Settings } from "./Settings";
import { accessDefaults, accessPrefs } from "./accessPrefs";
import { sidebarDefaults, sidebarPrefs } from "./sidebarPrefs";
import { appShortcut } from "./ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.hidePopover = () => {};

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
    openTargetIcons: async () => ({}),
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
  act(() => unmount());
  vi.useRealTimers();
});

async function renderSettings(name: SettingsSection = "providers") {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(<Settings section={name} listed={[]} theme="system" onThemeChange={() => {}} />),
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
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.trim().startsWith(name),
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
const change = (element: HTMLSelectElement | HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });

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
    models.filter((m) => m.provider === "claude").map((m) => m.name + m.id),
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

test("a provider's switch turns it off on this computer, and back on", async () => {
  await renderSettings();
  const toggle = () =>
    document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use Codex"]')!;
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  await click(toggle());
  expect(tabs()[1]).toBe("Codex0.156.1Off");
  expect(JSON.parse(localStorage.getItem("parallax.disabledProviders")!)).toEqual(["codex"]);
  await click(toggle());
  expect(tabs()[1]).toBe("Codex0.156.1Not signed in");
});

test("a shortcut can be added, refused when another command has it, removed, and reset", async () => {
  await renderSettings("keybinds");
  const row = () => button(document.body, "Reset all").closest("section")!;
  const press = async (init: KeyboardEventInit) => {
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="New shortcut for Open Usage"]',
    )!;
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })),
    );
  };
  await click(
    document.querySelector<HTMLButtonElement>('[aria-label="Add a shortcut to Open Usage"]')!,
  );
  await press({ key: "s", code: "KeyS", metaKey: true });
  expect(row().querySelector('[role="alert"]')!.textContent).toBe(
    "⌘S already runs Toggle sidebar.",
  );
  await press({ key: "y", code: "KeyY", metaKey: true });
  const usage = (init: KeyboardEventInit) => appShortcut(new KeyboardEvent("keydown", init));
  expect(usage({ code: "KeyY", metaKey: true })).toBe("usage");

  await click(
    document.querySelector<HTMLButtonElement>('[aria-label="Remove ⌥⌘U from Open Usage"]')!,
  );
  expect(usage({ code: "KeyU", metaKey: true, altKey: true })).toBeUndefined();
  await click(button(row(), "Reset all"));
  expect(usage({ code: "KeyU", metaKey: true, altKey: true })).toBe("usage");
  expect(usage({ code: "KeyY", metaKey: true })).toBeUndefined();
});

test("Source control shows the host's GitHub CLI and its account", async () => {
  states["local"] = {
    status: "connected",
    plxd: "0.1.0",
    protocol: 1,
    capabilities: { githubStatus: {} },
  };
  answers["github/status"] = () => ({
    result: { installed: true, version: "2.100.0", signedIn: true, account: "ryan", checkedAt: "" },
  });
  await renderSettings("sourceControl");
  expect(rows("Hosting")).toEqual(["GitHubgh 2.100.0Signed in as @ryan"]);
  states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
});

test("Source control on a plxd without githubSetup links to gh's install page", async () => {
  states["local"] = {
    status: "connected",
    plxd: "0.1.0",
    protocol: 1,
    capabilities: { githubStatus: {} },
  };
  answers["github/status"] = () => ({ result: { installed: false, checkedAt: "" } });
  await renderSettings("sourceControl");
  expect(rows("Hosting")).toEqual([
    "GitHubNot installed. Install the GitHub CLI on this host to open pull requests.Install",
  ]);
  expect(section("Hosting").querySelector("a")!.href).toBe("https://cli.github.com/");
  states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
});

test("Source control installs gh, signs it in with a code, and follows the browser's approval", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  states["local"] = {
    status: "connected",
    plxd: "0.1.0",
    protocol: 1,
    capabilities: { githubStatus: {}, githubSetup: {} },
  };
  const signIn = { code: "AB12-CD34", url: "https://github.com/login/device", expiresAt: "" };
  let status: Record<string, unknown> = { installed: false, checkedAt: "" };
  answers["github/status"] = () => ({ result: status });
  answers["github/install"] = () => {
    status = { installed: false, installing: true, checkedAt: "" };
    return { result: status };
  };
  answers["github/signIn"] = () => {
    status = { ...status, signingIn: signIn };
    return { result: signIn };
  };
  answers["github/signInCancel"] = () => {
    status = { ...status, signingIn: undefined };
    return { result: {} };
  };
  const open = vi.fn();
  window.open = open;
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const poll = async () => {
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await settle();
  };

  await renderSettings("sourceControl");
  expect(rows("Hosting")).toEqual([
    "GitHubNot installed. Parallax can install the GitHub CLI on this host.Install",
  ]);
  await click(button(section("Hosting"), "Install"));
  expect(rows("Hosting")).toEqual(["GitHubInstalling the GitHub CLI…Installing"]);

  status = { installed: true, version: "2.102.0", managed: true, signedIn: false, checkedAt: "" };
  await poll();
  expect(rows("Hosting")).toEqual([
    "GitHubgh 2.102.0 · installed by ParallaxNot signed in.Sign in",
  ]);

  await click(button(section("Hosting"), "Sign in"));
  expect(open).toHaveBeenCalledWith("https://github.com/login/device", "_blank");
  const [row, code] = rows("Hosting");
  expect(row).toBe(
    "GitHubgh 2.102.0 · installed by ParallaxWaiting for you to approve the code on GitHub…Cancel",
  );
  expect(code).toContain("Enter this code at github.com/login/device.");
  expect(section("Hosting").querySelector('[aria-label="One-time code"]')!.textContent).toBe(
    "AB12-CD34",
  );
  await click(button(section("Hosting"), "Copy"));
  expect(writeText).toHaveBeenCalledWith("AB12-CD34");

  // Cancel goes back to Sign in.
  await click(button(section("Hosting"), "Cancel"));
  expect(calls("github/signInCancel")).toHaveLength(1);
  expect(rows("Hosting")).toEqual([
    "GitHubgh 2.102.0 · installed by ParallaxNot signed in.Sign in",
  ]);

  // Approving in the browser shows on the next read, with setup-git's note.
  await click(button(section("Hosting"), "Sign in"));
  status = {
    installed: true,
    version: "2.102.0",
    managed: true,
    signedIn: true,
    account: "ryan",
    setupNote: "Signed in, but `gh auth setup-git` failed.",
    checkedAt: "",
  };
  await poll();
  expect(rows("Hosting")).toEqual([
    "GitHubgh 2.102.0 · installed by ParallaxSigned in as @ryanSigned in, but `gh auth setup-git` failed.",
  ]);
  // Nothing is pending, so polling stops.
  const reads = calls("github/status").length;
  await poll();
  expect(calls("github/status")).toHaveLength(reads);
  vi.unstubAllGlobals();
  states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
});

test("Source control shows why an install failed, and offers Install again", async () => {
  states["local"] = {
    status: "connected",
    plxd: "0.1.0",
    protocol: 1,
    capabilities: { githubStatus: {}, githubSetup: {} },
  };
  answers["github/status"] = () => ({
    result: {
      installed: false,
      setupNote: "The downloaded gh_2.102.0_macOS_arm64.zip doesn't match gh's checksum.",
      checkedAt: "",
    },
  });
  await renderSettings("sourceControl");
  expect(rows("Hosting")).toEqual([
    "GitHubNot installed. Parallax can install the GitHub CLI on this host.The downloaded gh_2.102.0_macOS_arm64.zip doesn't match gh's checksum.Install",
  ]);
  states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
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

test("Storage turns a host's merged worktree cleanup off", async () => {
  window.parallax.storage = async () => [];
  states["local"] = {
    status: "connected",
    plxd: "0.1.0",
    protocol: 1,
    capabilities: { worktreeCleanup: {} },
  };
  answers["thread/list"] = () => ({ result: { repos: [], threads: [] } });
  answers["host/settings/get"] = () => ({ result: { autoResume: true, cleanWorktrees: true } });
  answers["host/settings/set"] = () => ({ result: { autoResume: true, cleanWorktrees: false } });
  await renderSettings("storage");
  const toggle = document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Clean up merged worktrees"]',
  )!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(toggle);
  expect(calls("host/settings/set")).toEqual([
    { host: "local", params: { cleanWorktrees: false } },
  ]);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
});

test("Schedules lists a host's tasks and pauses one", async () => {
  states["local"] = {
    status: "connected",
    plxd: "0.1.0",
    protocol: 1,
    capabilities: { schedules: {} },
  };
  const task = {
    id: "task-1",
    title: "Build check",
    prompt: "Check the build again.",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    thread: "t-1",
    lastRunStatus: "failed",
    lastRunError: "no thread",
    runCount: 2,
    createdAt: "2026-10-09T04:00:00Z",
  };
  answers["schedule/list"] = () => ({ result: { tasks: [task] } });
  answers["schedule/save"] = () => ({ result: { ...task, enabled: false } });
  await renderSettings("schedules");
  const tasks = section("Scheduled tasks");
  expect(tasks.textContent).toContain("Build check");
  expect(tasks.textContent).toContain(
    "Weekdays at 09:00 · Not scheduled · Last run failed: no thread",
  );
  await click(
    document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable Build check"]')!,
  );
  expect(calls("schedule/save")).toEqual([
    {
      host: "local",
      params: expect.objectContaining({ id: "task-1", enabled: false, thread: "t-1" }),
    },
  ]);
  states["local"] = { status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} };
});

test("Connections renames this computer", async () => {
  const renameLocal = vi.fn(async () => undefined);
  window.parallax.renameLocal = renameLocal;
  await renderSettings("connections");
  await click(document.querySelector<HTMLButtonElement>('[aria-label="Rename this computer"]')!);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Computer name"]')!;
  expect(input.value).toBe("This Mac");
  input.value = "macbook";
  await act(async () => input.form!.requestSubmit());
  expect(renameLocal).toHaveBeenCalledWith("macbook");
});

test("Connections installs plxd on an SSH host without it, in one click", async () => {
  const installPlxd = vi.fn(async () => undefined);
  Object.assign(window.parallax, { installPlxd, version: async () => "2610.10903.13317-nightly" });
  const before = states[mini.id]!;
  states[mini.id] = {
    status: "failed",
    retrying: false,
    error: { reason: "notFound", message: "Parallax couldn't find plxd on mini.", exitCode: 127 },
  };
  try {
    await renderSettings("connections");
    expect(document.body.textContent).toContain(
      "plxd isn't on Mac mini. Install downloads plxd 2610.10903.13317-nightly there from GitHub, checks its SHA256",
    );
    await click(button(document.body, "Install plxd"));
    expect(installPlxd).toHaveBeenCalledWith(mini.id);
  } finally {
    states[mini.id] = before;
  }
});

test("Typography's sizes and Word wrap are kept, and Advanced takes any font's name", async () => {
  await renderSettings("appearance");
  const select = (label: string) =>
    document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  change(select("Interface font size"), "16");
  change(select("Monospace font size"), "14");
  await click(
    document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Word wrap"]')!,
  );
  await click(document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Advanced"]')!);
  change(
    document.querySelector<HTMLInputElement>('input[aria-label="Monospace font"]')!,
    "Berkeley Mono",
  );
  expect(JSON.parse(localStorage.getItem("parallax.appearance")!)).toMatchObject({
    uiSize: 16,
    codeSize: 14,
    wordWrap: false,
    codeFont: "Berkeley Mono",
  });
  localStorage.removeItem("parallax.appearance");
});

test("the last provider on can't be turned off", async () => {
  localStorage.setItem("parallax.disabledProviders", JSON.stringify(["codex", "cursor"]));
  vi.resetModules();
  const { Settings: Fresh } = await import("./Settings");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(<Fresh section="providers" listed={[]} theme="system" onThemeChange={() => {}} />),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  const toggle = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="Use ${name}"]`)!;
  expect(toggle("Claude Code").disabled).toBe(true);
  expect(toggle("Codex").disabled).toBe(false);
  localStorage.removeItem("parallax.disabledProviders");
});

test("Account saves a changed name, and shows main's answer when it fails", async () => {
  let publish = (_profile: Profile | null) => {};
  const ryan = { name: "Ryan Stoffel", firstName: "Ryan", lastName: "Stoffel", email: "r@x.dev" };
  const saveName = vi.fn(async () => "Network error" as string | undefined);
  Object.assign(window.parallax, {
    onProfile: (listener: (profile: Profile | null) => void) => {
      publish = listener;
      listener(ryan);
      return () => {};
    },
    saveName,
  });
  await renderSettings("account");
  const first = document.querySelector<HTMLInputElement>('input[aria-label="First name"]')!;
  const save = button(section("Account settings"), "Save");
  expect(first.value).toBe("Ryan");
  expect(save.disabled).toBe(true);

  change(first, " Ry ");
  expect(save.disabled).toBe(false);
  await click(save);
  expect(saveName).toHaveBeenCalledWith(" Ry ", "Stoffel");
  expect(section("Account settings").textContent).toContain("Network error");

  // Once main publishes the saved name, the fields start over from it.
  saveName.mockResolvedValue(undefined);
  await click(save);
  act(() => publish({ ...ryan, name: "Ry Stoffel", firstName: "Ry" }));
  expect(document.querySelector<HTMLInputElement>('input[aria-label="First name"]')!.value).toBe(
    "Ry",
  );
  expect(button(section("Account settings"), "Save").disabled).toBe(true);
  expect(section("Profile").querySelector("h2")!.textContent).toBe("Ry Stoffel");
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

  test("lists the host's instances, and a switch turns one off on the host", async () => {
    await renderSettings();
    expect(tabs()).toEqual(["Claude Code2.1.281Authenticated", "CodexNot authenticated"]);
    expect(rows("Account")[1]).toBe("AccountAuthenticated as ryan@example.com");
    expect(calls("accounts/list")).toEqual([]);

    await click(
      document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use Codex"]')!,
    );
    expect(saved()).toEqual({ ...instance("codex", "codex", "Codex"), enabled: false });
    expect(tabs()[1]).toBe("CodexOff");
    // One stays on, for new threads.
    expect(
      document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use Claude Code"]')!
        .disabled,
    ).toBe(true);
  });

  test("Remove beside Refresh and + removes the chosen provider once it's confirmed", async () => {
    answers["providers/remove"] = (p) => {
      listed = listed.filter((each) => each.instance.id !== p["id"]);
      return result();
    };
    await renderSettings();
    await click(tab("Codex"));
    await click(document.querySelector<HTMLElement>('[aria-label="Remove Codex"]')!);
    expect(calls("providers/remove")).toEqual([]);
    await click(button(document.body, "Cancel"));
    await click(document.querySelector<HTMLElement>('[aria-label="Remove Codex"]')!);
    await click(button(document.body, "Remove"));
    expect(calls("providers/remove")[0]!.params).toEqual({ id: "codex" });
    expect(tabs()).toEqual(["Claude Code2.1.281Authenticated"]);
  });

  test("an agent Parallax installs offers Install when it isn't installed, and a custom binary doesn't", async () => {
    listed[1] = {
      ...listed[1]!,
      instance: instance("pi", "pi", "Pi"),
      installed: false,
      signedIn: undefined,
      note: "pi isn't installed on this host",
    };
    const install = vi.fn(async () => {
      // Installed, Pi has no model to use until it logs in, in its own `pi`.
      listed[1] = {
        ...listed[1]!,
        installed: true,
        signedIn: false,
        note: "Pi has no usable models. Run `pi` and use /login, or configure an API key in ~/.pi/agent.",
        login: ["pi"],
      };
      return undefined;
    });
    window.parallax.install = install;
    await renderSettings();
    expect(tabs()[1]!.trim()).toBe("PiNot installed");
    await click(tab("Pi"));
    // Install takes the account's place, and says what it runs.
    expect(rows("Account")[1]).toBe(
      'InstallPi isn\'t installed on this hostInstallRuns npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent',
    );
    const installButton = visible('[aria-label="Install Pi"]') as HTMLButtonElement;
    expect(
      document.getElementById(installButton.getAttribute("aria-describedby")!)!.textContent,
    ).toBe('Runs npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent');
    await click(installButton);
    expect(install).toHaveBeenCalledWith("local", "pi");
    expect(calls("providers/list").at(-1)!.params).toEqual({ refresh: true });
    expect(rows("Account")[1]).toBe(
      "AccountNot authenticated · Pi has no usable models. Run `pi` and use /login, or configure an API key in ~/.pi/agent.Login",
    );
    listed[1] = { ...listed[1]!, installed: false, note: "pi isn't installed on this host" };

    listed[1] = { ...listed[1]!, instance: { ...listed[1]!.instance, program: "/opt/npx" } };
    unmount();
    await renderSettings();
    await click(tab("Pi"));
    expect(rows("Account")[1]).toBe("AccountPi isn't installed on this host");

    // Pi's installer puts `pi` on the host, not the 0.x one this instance runs.
    const env = [{ name: "PI_ACP_PI_COMMAND", value: "pi-0.73", secret: false }];
    listed[1] = { ...listed[1]!, instance: { ...instance("pi", "pi", "Pi"), env } };
    unmount();
    await renderSettings();
    await click(tab("Pi"));
    expect(rows("Account")[1]).toBe("AccountPi isn't installed on this host");
  });

  test("Cursor's Install starts plxd's install of its SDK, and shows it installing, then why it failed", async () => {
    listed[1] = {
      ...listed[1]!,
      instance: instance("cursor", "cursor", "Cursor"),
      installed: false,
      signedIn: undefined,
      note: undefined,
    };
    answers["cursor/install"] = () => {
      listed[1] = { ...listed[1]!, installing: true, note: "Installing the Cursor SDK…" };
      return { result: {} };
    };
    await renderSettings();
    expect(tabs()[1]!.trim()).toBe("CursorNot installed");
    await click(tab("Cursor"));
    expect(rows("Account")[1]).toBe("InstallNot installedInstall");
    await click(visible('[aria-label="Install Cursor"]')!);
    expect(calls("cursor/install")).toHaveLength(1);
    expect(calls("providers/list").at(-1)!.params).toEqual({ refresh: true });
    expect(rows("Account")[1]).toBe("InstallInstalling Cursor…Installing…");
    expect((visible('[aria-label="Install Cursor"]') as HTMLButtonElement).disabled).toBe(true);

    // The install failed in the background: its note says why, and Install is offered again.
    listed[1] = {
      ...listed[1]!,
      installing: false,
      note: "Couldn't install the Cursor SDK: npm error network offline",
    };
    unmount();
    await renderSettings();
    await click(tab("Cursor"));
    expect(rows("Account")[1]).toBe(
      "InstallCouldn't install the Cursor SDK: npm error network offlineInstall",
    );
  });

  const dialog = () => document.querySelector("dialog")!;
  const next = async () => {
    await act(async () => dialog().querySelector("form")!.requestSubmit());
    await settle();
  };

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

  test("adds an ACP Registry agent that runs with npx", async () => {
    await renderSettings();
    await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
    await click(dialog().querySelector<HTMLElement>('[aria-label="Add Gemini CLI"]')!);
    await next();
    await next();
    expect(saved()).toEqual({
      id: "gemini-cli",
      kind: "acp",
      name: "Gemini CLI",
      enabled: true,
      program: "npx",
      args: ["-y", "@google/gemini-cli@0.62.0", "--acp"],
      env: [],
      models: [],
    });
  });

  test("Claude Code added back takes the id claude, which its startup backend and keys go by", async () => {
    listed = [];
    await renderSettings();
    await click(button(document.body, "Add provider"));
    await click(button(dialog(), "Claude CodeAnthropic's agent"));
    const id = [...dialog().querySelectorAll("input")][1]!;
    expect(id.value).toBe("claude");
  });

  test("an empty host offers Add provider", async () => {
    listed = [];
    await renderSettings();
    expect(tabs()).toEqual([]);
    expect(document.body.textContent).toContain("No providers on This Mac yet.");
    await click(button(document.body, "Add provider"));
    expect(dialog()).not.toBeNull();
  });

  test("a registry agent plxd tunes is added as its kind, with its defaults", async () => {
    await renderSettings();
    await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
    await click(dialog().querySelector<HTMLElement>('[aria-label="Add pi ACP"]')!);
    await next();
    await next();
    expect(saved()).toEqual({
      id: "pi",
      kind: "pi",
      name: "Pi",
      enabled: true,
      args: ["-y", "pi-acp@0.0.34"],
      env: [{ name: "PI_ACP_PI_COMMAND", value: "pi", secret: false }],
      models: [],
    });
  });

  test("Pi and OpenCode ask only for their binary, and OpenCode for its server", async () => {
    const labels = () =>
      [...dialog().querySelectorAll("form > div:nth-child(3) label")].map(
        (l) => l.childNodes[0]!.textContent,
      );
    const type = async (label: string, value: string) => {
      const input = [...dialog().querySelectorAll("label")]
        .find((l) => l.childNodes[0]!.textContent === label)!
        .querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await renderSettings();
    await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
    const card = (blurb: string) =>
      [...dialog().querySelectorAll("button")].find((b) => b.textContent!.endsWith(blurb))!;
    await click(card("A minimal agent"));
    await next();
    expect(labels()).toEqual(["Binary path"]);
    await type("Binary path", "/opt/pi/bin/pi");
    await next();
    expect(saved()).toMatchObject({
      kind: "pi",
      args: ["-y", "pi-acp@0.0.34"],
      env: [{ name: "PI_ACP_PI_COMMAND", value: "/opt/pi/bin/pi", secret: false }],
    });

    await click(document.querySelector<HTMLElement>('[aria-label="Add provider"]')!);
    await click(card("Any model"));
    await next();
    expect(labels()).toEqual(["Binary path", "Server URL", "Server password"]);
    await type("Server URL", "http://127.0.0.1:4096");
    await type("Server password", "hunter2");
    await next();
    expect(saved()).toMatchObject({
      kind: "opencode",
      args: [],
      env: [
        { name: "OPENCODE_SERVER_URL", value: "http://127.0.0.1:4096", secret: false },
        { name: "OPENCODE_SERVER_PASSWORD", value: "hunter2", secret: true },
      ],
    });
  });

  test("a version choice writes its fields, and is read back from them", async () => {
    listed = [
      {
        ...listed[1]!,
        instance: {
          ...instance("pi", "pi", "Pi"),
          args: ["-y", "pi-acp@0.0.34"],
          env: [
            { name: "PI_ACP_PI_COMMAND", value: "pi", secret: false },
            { name: "TOKEN", secret: true },
          ],
        },
      },
    ];
    await renderSettings();
    const version = (label: string) =>
      section("Version").querySelector<HTMLInputElement>(`[value="${label}"]`)!;
    expect(version("1.0").checked).toBe(true);
    await click(version("0.x"));
    expect(saved()).toMatchObject({
      args: ["-y", "pi-acp@0.0.27"],
      env: [
        { name: "TOKEN", secret: true },
        { name: "PI_ACP_PI_COMMAND", value: "pi-0.73", secret: false },
      ],
    });
    expect(version("0.x").checked).toBe(true);
  });

  test("a version choice keeps a custom binary, and drops another version's", async () => {
    const { withVersion, versions } = await import("./providers");
    const [v1, v2] = versions["opencode"]!;
    const fields = { kind: "opencode" as const, args: [], env: [] };
    expect(withVersion({ ...fields, program: "/opt/oc" }, v1!).program).toBe("/opt/oc");
    expect(withVersion({ ...fields, program: "opencode2" }, v1!).program).toBeUndefined();
    expect(withVersion({ ...fields, program: "/opt/oc" }, v2!).program).toBe("opencode2");
  });

  test("a Cursor instance signs in through the browser", async () => {
    listed = [
      {
        instance: instance("cursor", "cursor", "Cursor"),
        installed: true,
        signedIn: false,
        models: [],
        permissions: ["edit", "plan", "auto", "bypass"],
        efforts: false,
        coordinator: false,
      },
    ];
    answers["cursor/signIn"] = () => ({
      result: { url: "https://cursor.com/loginDeepControl?challenge=example" },
    });
    answers["cursor/signInCancel"] = () => ({ result: {} });
    answers["cursor/signOut"] = () => ({ result: {} });
    const open = vi.fn();
    window.open = open;

    await renderSettings();
    expect(pane().textContent).toContain("Cursor SDK");
    expect(pane().textContent).not.toContain("Binary path");
    await click(button(section("Account"), "Sign in"));
    expect(open).toHaveBeenCalledWith(
      "https://cursor.com/loginDeepControl?challenge=example",
      "_blank",
    );
    expect(calls("cursor/signIn")[0]!.params).toEqual({ instance: "cursor" });
    expect(section("Account").textContent).toContain("Approve the sign-in in your browser");

    await click(button(section("Account"), "Cancel"));
    expect(calls("cursor/signInCancel")).toHaveLength(1);
  });

  test("a signed-in Cursor instance can sign out", async () => {
    listed = [
      {
        instance: instance("cursor", "cursor", "Cursor"),
        installed: true,
        signedIn: true,
        account: "ryan@example.com",
        models: [],
        permissions: ["edit", "plan", "auto", "bypass"],
        efforts: false,
        coordinator: false,
      },
    ];
    answers["cursor/signOut"] = () => ({ result: {} });
    await renderSettings();
    expect(section("Account").textContent).toContain("Authenticated as ryan@example.com");
    await click(button(section("Account"), "Sign out"));
    expect(calls("cursor/signOut")[0]!.params).toEqual({ instance: "cursor" });
  });

  test("a Cursor sign-in that fails in the browser stops waiting and says so", async () => {
    const cursor = {
      instance: instance("cursor", "cursor", "Cursor"),
      installed: true,
      signedIn: false,
      models: [],
      permissions: ["edit", "plan", "auto", "bypass"],
      efforts: false,
      coordinator: true,
    } satisfies (typeof listed)[number];
    listed = [cursor];
    answers["cursor/signIn"] = () => ({ result: { url: "https://cursor.com/loginDeepControl" } });
    answers["cursor/signInCancel"] = () => ({ result: {} });
    window.open = vi.fn();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await renderSettings();
    await click(button(section("Account"), "Sign in"));
    expect(section("Account").textContent).toContain("Approve the sign-in in your browser");
    listed = [{ ...cursor, signInError: "Cursor sign-in failed or expired. Start sign-in again." }];
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(pane().textContent).toContain("Cursor sign-in failed or expired");
    expect(section("Account").textContent).not.toContain("Approve the sign-in in your browser");
  });

  test("a Cursor instance with its own CURSOR_API_KEY has no browser sign-in", async () => {
    listed = [
      {
        instance: {
          ...instance("cursor", "cursor", "Cursor"),
          env: [{ name: "CURSOR_API_KEY", secret: true }],
        },
        installed: true,
        signedIn: true,
        models: [],
        permissions: ["edit", "plan", "auto", "bypass"],
        efforts: false,
        coordinator: true,
      },
    ];
    await renderSettings();
    expect(section("Account").textContent).not.toContain("Sign in");
    expect(section("Account").textContent).not.toContain("Sign out");
    expect(pane().textContent).toContain("CURSOR_API_KEY");
  });
});

test("General's sidebar switches turn the Working section and archive pages off", async () => {
  sidebarPrefs.set(sidebarDefaults);
  window.parallax.openTargets = async () => [];
  window.parallax.version = async () => "1.2.3";
  await renderSettings("general");
  const working = document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Working section"]',
  )!;
  const pages = document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Archive pages"]',
  )!;
  expect(working.getAttribute("aria-checked")).toBe("true");
  expect(pages.getAttribute("aria-checked")).toBe("true");
  await click(working);
  await click(pages);
  expect(sidebarPrefs.get()).toEqual({ workingSection: false, pageArchived: false });
  expect(JSON.parse(localStorage.getItem("parallax.sidebar")!)).toEqual({
    workingSection: false,
    pageArchived: false,
  });
  sidebarPrefs.set(sidebarDefaults);
});

test("General's New threads and Behavior settings are kept (PLX-538)", async () => {
  window.parallax.openTargets = async () => [];
  window.parallax.version = async () => "1.2.3";
  await renderSettings("general");
  const sw = (label: string) =>
    document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
  await click(sw("System notifications"));
  expect(behaviorPrefs.get().systemNotifications).toBe(false);
  const select = (label: string) =>
    document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(select("Time format").value).toBe("system");
  expect(section("New threads").textContent).toContain("Permissions");
  setBehaviorPrefs(behaviorDefaults);
});

test("General's Legacy Plan mode switch lists Plan in the Access picker", async () => {
  accessPrefs.set(accessDefaults);
  window.parallax.openTargets = async () => [];
  window.parallax.version = async () => "1.2.3";
  await renderSettings("general");
  const legacy = document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Legacy Plan mode"]',
  )!;
  expect(legacy.getAttribute("aria-checked")).toBe("false");
  await click(legacy);
  expect(accessPrefs.get()).toEqual({ legacyPlan: true });
  accessPrefs.set(accessDefaults);
});

test("General's Terminal row chooses a terminal app, and Open folders in lists it (PLX-585)", async () => {
  let chosen = false;
  window.parallax.openTargets = async () => (chosen ? ["files", "terminal"] : ["files"]);
  window.parallax.chooseTerminalApp = async () => {
    chosen = true;
    return "Ghostty";
  };
  window.parallax.version = async () => "1.2.3";
  await renderSettings("general");
  const choose = document.querySelector<HTMLButtonElement>(
    '[role="menu"][aria-label="Terminal"] [role="menuitemradio"]:last-child',
  )!;
  expect(choose.textContent).toContain("Choose an app…");
  await click(choose);
  expect(document.querySelector('[aria-label="Terminal: Ghostty"]')).not.toBeNull();
  const options = document.querySelectorAll(
    '[role="menu"][aria-label="Open folders in"] [role="menuitemradio"]',
  );
  expect([...options].map((o) => o.textContent)).toEqual(["Finder", "Ghostty"]);
});
