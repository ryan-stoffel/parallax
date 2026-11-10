// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, SshHost, ParallaxBridge } from "../preload/bridge";
import type { Host } from "./hosts";
import type { ThreadsView } from "./threads";
import type {
  Hub,
  ProviderInfo,
  ProviderInstance,
  ProviderKind,
} from "../protocol/generated/protocol";
import { bindingOf, resetBindings, setWhen, whenOf } from "./keybindings";
import type { SettingsSection } from "./App";
import { Notifications } from "./notifications";
import {
  behaviorDefaults,
  behaviorPrefs,
  newThreadDefaults,
  newThreadPrefs,
  setBehaviorPrefs,
} from "./prefs";
import { Settings } from "./Settings";
import { searchSettings } from "./settings/search";

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
  openHost = "local",
  focus?: { anchor: string },
) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <Settings
          section={name}
          listed={listed}
          theme="system"
          onThemeChange={() => {}}
          openHost={openHost}
          focus={focus}
        />
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

test("Add keybinding gives a command its keys and the When on the form, in place of its own", async () => {
  setWhen("cycleAppearance", "!terminalFocus");
  try {
    await renderSettings("keybinds");
    await click(button(document.body, "Add keybinding"));
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (o) => o.textContent === "Appearance: Cycle",
      )!,
    );
    const recorder = document.querySelector<HTMLElement>(
      '[aria-label="Change the keys for the new keybinding"]',
    )!;
    await click(recorder);
    await act(async () =>
      document.querySelector('[aria-label="Press the keys for the new keybinding"]')!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "y",
          code: "KeyY",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    await click(button(document.body, "Save"));
    expect(bindingOf("cycleAppearance")).toBe("Ctrl+Shift+KeyY");
    expect(whenOf("cycleAppearance")).toBe("always");
  } finally {
    resetBindings();
  }
});

test("search opens an orchestrator's pane for what only it has", async () => {
  const orchestrator = { id: "o1", name: "Ember", repoPath: "/src/ember" };
  const view = {
    state: { orchestrators: [orchestrator], repos: [] },
    updateOrchestrator: vi.fn(),
  } as unknown as ThreadsView;
  const listed = [{ host: { id: "local", name: "This Mac" } as Host, view }];
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const show = (focus?: { anchor: string }) =>
    act(() =>
      root.render(
        <Settings
          section="orchestrators"
          listed={listed}
          theme="system"
          onThemeChange={() => {}}
          openHost="local"
          focus={focus}
        />,
      ),
    );
  show();
  expect(document.body.textContent).toContain("New orchestrators");
  expect(document.querySelector('[aria-label="Name"]')).toBeNull();
  show({ anchor: "base-branch" });
  await settle();
  expect(document.querySelector('[aria-label="Name"]')).not.toBeNull();
  act(() => root.unmount());
});

test("Threads' Text generation holds the naming model, title instructions, and response streaming, where search finds them (PLX-1523)", async () => {
  await renderSettings("threads");
  expect(section("New threads").textContent).not.toContain("Naming model");
  const text = section("Text generation");
  for (const title of ["Naming model", "Thread title instructions", "Response streaming"]) {
    const found = searchSettings(title)[0]!;
    expect(found).toMatchObject({ section: "threads", title, place: "Threads › Text generation" });
    expect(text.querySelector(`[data-setting="${found.anchor}"]`)).not.toBeNull();
  }

  const box = text.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(box.value).toBe("");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Start with the ticket id.",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(newThreadPrefs.get().namingInstructions).toBe("Start with the ticket id.");

  expect(behaviorPrefs.get().responseStreaming).toBe("live");
  await click(
    [...text.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (o) => o.textContent === "Wait for the full response",
    )!,
  );
  expect(behaviorPrefs.get().responseStreaming).toBe("full");
  expect(text.textContent).toContain("A reply's text appears once the reply is complete.");

  newThreadPrefs.set(newThreadDefaults);
  setBehaviorPrefs(behaviorDefaults);
});

test("Worktrees starts on All computers, says where they differ, and sets them all", async () => {
  const failed = states[mini.id]!;
  const capabilities = { branchPrefix: {}, worktreeCleanup: {} };
  states["local"] = { ...states["local"]!, capabilities } as ConnectionState;
  states[mini.id] = { ...states["local"]! } as ConnectionState;
  answers["host/settings/get"] = () => ({
    result: { autoResume: false, cleanWorktrees: true, branchPrefix: "parallax/" },
  });
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (host, method, params) =>
    host === mini.id && method === "host/settings/get"
      ? ({
          result: { autoResume: false, cleanWorktrees: false, branchPrefix: "ryan/" },
          logId: "l",
        } as never)
      : original(host, method, params),
  );
  answers["host/settings/set"] = (p) => ({
    result: { autoResume: false, cleanWorktrees: true, branchPrefix: "parallax/", ...p },
  });
  await renderSettings("worktrees");

  const row = () => document.querySelector('[data-setting="clean-up-merged-worktrees"]')!;
  expect(row().textContent).toContain("Differs across computers");
  await click(row().querySelector<HTMLElement>('[role="switch"]')!);
  expect(
    calls("host/settings/set")
      .map((c) => c.host)
      .sort(),
  ).toEqual([mini.id, "local"].sort());

  request.mockImplementation(original);
  states[mini.id] = failed;
  delete answers["host/settings/set"];
});

test("About copies its version, and its bug report link fills the version in", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await renderSettings("about");
  await click(document.querySelector<HTMLElement>('[aria-label="Copy version 0.0.0-local"]')!);
  expect(writeText).toHaveBeenCalledWith("0.0.0-local");
  const bug = [...document.querySelectorAll("a")].find((a) =>
    a.textContent?.startsWith("Report a bug"),
  )!;
  expect(new URL(bug.href).searchParams.get("template")).toBe("bug-report.yml");
  expect(new URL(bug.href).searchParams.get("version")).toBe("0.0.0-local");
});

describe("About's updates card (PLX-1522)", () => {
  const card = () => document.querySelector<HTMLElement>('[data-setting="check-for-updates"]')!;
  const updateButton = () => card().querySelector("button")!;
  // The card's title and its detail line.
  const lines = () => [...card().querySelectorAll("p")].map((p) => p.textContent);
  const idle = ["Updates", "Parallax checks for new releases on its own."];
  type UpdateState = import("../preload/bridge").UpdateState;
  // Sends everything listening the updater's state, as main does.
  const listeners = new Set<(state: UpdateState) => void>();
  const publish = async (state: UpdateState) => {
    act(() => listeners.forEach((listener) => listener(state)));
    await settle();
  };
  beforeEach(() => {
    listeners.clear();
    window.parallax.updatable = true;
    window.parallax.onUpdateState = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
  });

  test("checks when pressed, reading Checking… until the check ends", async () => {
    let answer = (_line: string) => {};
    const update = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    window.parallax.update = update;
    await renderSettings("about");
    expect(lines()).toEqual(idle);
    expect(updateButton().textContent).toBe("Check for updates");

    await click(updateButton());
    expect(lines()[0]).toBe("Checking for updates…");
    expect(updateButton().textContent).toBe("Checking…");
    expect(updateButton().querySelector(".animate-spin")).not.toBeNull();
    expect(updateButton().disabled).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);

    await act(async () => answer("Up to date"));
    expect(lines()).toEqual([
      "Parallax is up to date",
      "0.0.0-local is the latest. Checked just now.",
    ]);
    expect(updateButton().textContent).toBe("Check for updates");
    expect(updateButton().disabled).toBe(false);
  });

  test("names an update, its download, and its restart", async () => {
    const available = { version: "2611.2.3-nightly", notes: "", url: "https://example.com/new" };
    await renderSettings("about");
    await publish({ available });
    expect(lines()).toEqual(["Parallax 2611.2.3-nightly is available"]);
    expect(card().querySelector("a")!.href).toBe("https://example.com/new");
    expect(updateButton().textContent).toBe("Download");

    await publish({ available, progress: 40 });
    expect(lines()).toEqual(["Downloading 2611.2.3-nightly…"]);
    expect(card().querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("40");
    expect(updateButton().disabled).toBe(true);

    await publish({ available, ready: "Parallax 2611.2.3-nightly to install" });
    expect(lines()).toEqual([
      "Parallax 2611.2.3-nightly is ready to install",
      "Parallax restarts to finish.",
    ]);
    expect(updateButton().textContent).toBe("Restart to install");
    expect(updateButton().disabled).toBe(false);
  });

  test("never restarts on its own: the sidebar's Update button reviews it", async () => {
    const { UpdateButton } = await import("./Update");
    const downloaded = {
      available: { version: "2611.2.3-nightly", notes: "", url: "https://example.com" },
      ready: "Parallax 2611.2.3-nightly to install",
    };
    const update = vi.fn(async () => "Restarting to install Parallax 2611.2.3-nightly…");
    window.parallax.update = update;

    // Without the sidebar's button, it says where to restart.
    await renderSettings("about");
    await publish(downloaded);
    await click(updateButton());
    expect(lines()[1]).toBe("Restart from the Update button in the sidebar.");

    // With it, a press opens its review dialog.
    HTMLElement.prototype.togglePopover = () => false;
    const sidebar = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => sidebar.render(<UpdateButton />));
    await settle();
    await publish(downloaded);
    const review = document.querySelector<HTMLDialogElement>("dialog")!;
    expect(review.open).toBe(false);
    await click(updateButton());
    expect(review.open).toBe(true);
    expect(review.textContent).toContain("Updates available");
    expect(lines()[1]).toBe("Parallax restarts to finish.");
    expect(update).not.toHaveBeenCalled();
    act(() => sidebar.unmount());
  });

  test("shows a failed check's line until the updater says otherwise", async () => {
    const failed = "Can't reach GitHub to check for updates.";
    let answer = (_line: string) => {};
    window.parallax.update = () => new Promise<string>((resolve) => (answer = resolve));
    await renderSettings("about");
    await click(updateButton());
    await publish({ note: failed });
    await act(async () => answer(failed));
    expect(lines()).toEqual(["Couldn't check for updates", failed]);
    expect(card().querySelector('[role="alert"]')!.textContent).toBe(failed);
    expect(updateButton().textContent).toBe("Try again");

    // A later check that works clears it, and the press's answer with it.
    await publish({});
    expect(lines()).toEqual(idle);
  });

  test("has no button, and says why, in a build that can't update", async () => {
    const off = "Updates aren't available in this build";
    await renderSettings("about");
    await publish({ note: "Updates work only in the AppImage.", unsupported: true });
    expect(lines()).toEqual([off, "Updates work only in the AppImage."]);
    expect(card().querySelector("button")).toBeNull();

    act(() => unmount());
    window.parallax.updatable = false;
    await renderSettings("about");
    expect(lines()).toEqual([off, "Only the packaged app updates itself."]);
    expect(card().querySelector("button")).toBeNull();
  });
});

test("Projects lists each with its icon, and an icon picked there goes to every copy", async () => {
  const repo = { id: "r1", name: "ember", path: "/src/ember", icon: { name: "rocket" } };
  const updates: [string, unknown][] = [];
  const viewOf = (host: string, id: string) =>
    ({
      state: { orchestrators: [], repos: [{ ...repo, id }] },
      capabilities: { threadAttention: {} },
      updateRepo: async (r: string, change: unknown) => void updates.push([`${host}/${r}`, change]),
    }) as unknown as ThreadsView;
  await renderSettings("projects", [
    { host: { id: "local", name: "This Mac" } as Host, view: viewOf("local", "r1") },
    { host: { id: mini.id, name: mini.name } as Host, view: viewOf(mini.id, "r9") },
  ]);
  const row = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("emberThis Mac · /src/ember"),
  )!;
  expect(row.querySelector("svg")).not.toBeNull();
  expect(document.querySelector('[data-setting="project-icon"]')).toBeNull();

  await click(row);
  expect(document.querySelector('[data-setting="project-icon"]')!.textContent).toContain("Rocket");
  await click(button(document.body, "Choose icon"));
  const picker = document.querySelector('[role="group"][aria-label="Choose an icon"]')!;
  await click(picker.querySelector<HTMLElement>('[role="option"]')!);
  expect(updates.map(([where]) => where)).toEqual(["local/r1", `${mini.id}/r9`]);
});

test("Storage deletes only a host's archived threads, after asking", async () => {
  window.parallax.storage = async () => [];
  answers["thread/list"] = () => ({
    result: {
      repos: [],
      threads: [
        { id: "t-old", repo: "r", archived: true, createdAt: "" },
        // An orchestrator's thread goes only with its orchestrator (0093).
        { id: "t-orchestrator", repo: "o", archived: true, orchestrator: "o", createdAt: "" },
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

test("Providers opens on the host the window has open, not always this computer", async () => {
  const failed = states[mini.id]!;
  states[mini.id] = { ...states["local"]!, capabilities: { providers: {} } } as ConnectionState;
  answers["providers/list"] = () => ({
    result: { providers: [], checkedAt: "2026-09-28T12:00:00Z" },
  });
  await renderSettings("providers", [], mini.id);
  expect(calls("providers/list").at(-1)!.host).toBe(mini.id);
  states[mini.id] = failed;
});

test("Link providers across computers says which computer's list it would use", async () => {
  const failed = states[mini.id]!;
  states[mini.id] = { ...states["local"]!, capabilities: { providers: {} } } as ConnectionState;
  answers["providers/list"] = () => ({
    result: { providers: [], checkedAt: "2026-09-28T12:00:00Z" },
  });
  await renderSettings("providers", [], mini.id);
  expect(document.querySelector('[aria-label="Link providers across computers"]')).not.toBeNull();
  expect(document.body.textContent).toContain("Use Mac mini's providers on every computer.");
  states[mini.id] = failed;
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
        orchestrator: true,
        login: ["claude", "auth", "login"],
      },
      {
        instance: instance("codex", "codex", "Codex"),
        installed: true,
        signedIn: false,
        models: [],
        permissions: ["edit"],
        efforts: true,
        orchestrator: false,
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

  test("a signed-in provider re-authenticates in its terminal, and labels stay on it", async () => {
    await renderSettings();
    await click(visible('[aria-label="Re-authenticate Claude Code"]'));
    expect(visible('[aria-label="Claude Code sign-in terminal"]')).toBeDefined();

    const box = visible('[aria-label="Add a label"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "Work");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    const row = () => document.querySelector('[role="tab"][aria-controls$="-claude-pane"]')!;
    expect(row().textContent).toContain("Work");
    await click(visible('[aria-label="Remove the label Work"]'));
    expect(row().textContent).not.toContain("Work");
  });

  test("re-authenticating Cursor signs out, then waits on the new sign-in", async () => {
    const cursor = {
      ...listed[0]!,
      instance: instance("cursor", "cursor", "Cursor"),
      login: undefined,
    };
    listed = [cursor];
    answers["cursor/signOut"] = () => {
      listed = [{ ...cursor, signedIn: false }];
      return { result: {} };
    };
    answers["cursor/signIn"] = () => ({ result: { url: "https://cursor.example/login" } });
    answers["cursor/signInCancel"] = () => ({ result: {} });
    const open = window.open;
    window.open = vi.fn();
    try {
      await renderSettings();
      await click(visible('[aria-label="Re-authenticate Cursor"]'));
      await settle();
      expect(calls("cursor/signOut")).toHaveLength(1);
      expect(window.open).toHaveBeenCalledWith("https://cursor.example/login", "_blank");
      expect(document.body.textContent).toContain("Approve the sign-in in your browser.");
    } finally {
      window.open = open;
    }
  });

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

    // A row by its instance's id, since Claude's shows its email.
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

    // Hubs have their own entry under the provider list: a row per hub, whose Manage opens its
    // page under it.
    const manage = () =>
      document.querySelector<HTMLElement>(
        '[aria-label="Manage Home hub"], [aria-label="Close Home hub"]',
      );
    const hubPage = () => visible('[role="region"][aria-label="Home hub"]');

    test("search for Hubs opens its entry, which is otherwise hidden", async () => {
      await renderSettings("providers", [], "local", { anchor: "hubs" });
      expect(tab("Hubs").getAttribute("aria-selected")).toBe("true");
      expect(visible('[data-setting="hubs"]')).toBeDefined();
    });

    test("adds a hub to every computer with hubs at once, and shows its page", async () => {
      await renderSettings();
      await click(tab("Hubs"));
      expect(manage()).toBeNull();
      await click(button(document.body, "Add hub"));
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

      // A hub just added opens its page under its row.
      expect(manage()!.getAttribute("aria-expanded")).toBe("true");
      const page = hubPage();
      expect(page.textContent).toContain("Connected · 3 models");
      expect(page.textContent).toContain("gemini-3-pro");
      expect(page.textContent).toContain("5-hour limit · 42% used");
      expect(page.textContent).toContain("Off on the hub");
      expect(page.textContent).toContain("ada@example.com");

      answers["hubs/remove"] = () => ({ result: { hubs: [] } });
      await click(document.querySelector<HTMLElement>('[aria-label="Remove Home hub"]')!);
      // It asks in its row.
      await click(button(document.querySelector('[data-setting="hubs"]')!, "Remove"));
      expect(calls("hubs/remove")).toEqual([{ host: "local", params: { id: "home-hub" } }]);
      expect(manage()).toBeNull();
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
      await click(button(document.body, "Add hub"));
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
      const page = hubPage;
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
        await click(tab("Hubs"));
        await click(manage()!);
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

      test("a sign-in under way outlives closing its hub's page", async () => {
        statuses = [{ status: "waiting" }];
        await addAccount("Claude");
        expect(page().textContent).toContain("Waiting for the browser");
        await click(manage()!);
        expect(manage()!.getAttribute("aria-expanded")).toBe("false");
        await click(manage()!);
        expect(page().textContent).toContain("Waiting for the browser");
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

      test("a cancel the hub refuses while it saves the account keeps waiting", async () => {
        answers["hubs/accounts/cancel"] = () => ({ result: { status: "waiting" } });
        await addAccount("Claude");
        await click(button(page(), "Cancel"));
        expect(calls("hubs/accounts/cancel")).toHaveLength(1);
        expect(page().textContent).toContain("Waiting for the browser");
        expect(page().textContent).not.toContain("Sign-in cancelled");

        statuses = [{ status: "done" }];
        await poll();
        expect(page().textContent).toContain("Signed in");
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
        await click(tab("Hubs"));
        await click(manage()!);
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
