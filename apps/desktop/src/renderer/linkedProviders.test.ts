// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";
import {
  linkable,
  linkProviders,
  reconcile,
  removeEverywhere,
  saveEverywhere,
  unlinkProviders,
  useProviderLink,
} from "./linkedProviders";
import { loadProviders } from "./providers";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const instance = (id: string, rest: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id,
  kind: "codex",
  name: id,
  enabled: true,
  args: [],
  env: [],
  models: [],
  ...rest,
});
const info = (i: ProviderInstance, rest: Partial<ProviderInfo> = {}) =>
  ({ instance: i, models: [], installed: true, ...rest }) as unknown as ProviderInfo;

test("a list holds no secret or CLI path, and its homes work on any computer", () => {
  const entry = linkable(
    instance("work", {
      program: "/opt/homebrew/bin/codex",
      home: "/Users/ada/.codex-work",
      env: [
        { name: "API_KEY", value: "sk-secret", secret: true },
        { name: "STORED_KEY", secret: true },
        { name: "BASE_URL", value: "https://example.test", secret: false },
      ],
    }),
  );
  expect(JSON.stringify(entry)).not.toContain("sk-secret");
  expect(entry.program).toBeUndefined();
  expect(entry.home).toBe("~/.codex-work");
  expect(entry.env).toEqual([{ name: "BASE_URL", value: "https://example.test", secret: false }]);
  const home = (h: string) => linkable(instance("w", { home: h })).home;
  expect(home("/home/ada/.w")).toBe("~/.w");
  expect(home("/root/.w")).toBe("~/.w");
  expect(home("C:\\Users\\ada\\.w\\x")).toBe("~/.w/x");
  expect(home("~/.w")).toBe("~/.w");
  // A folder elsewhere gets one of its own, since it may not be allowed on another computer.
  expect(home("/srv/codex")).toBe("~/.w");
  expect(linkable(instance("o", { kind: "ollamaCloud", home: "/Users/a/o" })).home).toBeUndefined();
});

test("a program the other computer can run stays in the list", () => {
  expect(linkable(instance("a", { kind: "acp", program: "/opt/agent" })).program).toBe(
    "/opt/agent",
  );
  expect(linkable(instance("o", { kind: "opencode", program: "opencode2" })).program).toBe(
    "opencode2",
  );
  const on2 = instance("o", { kind: "opencode", program: "opencode2" });
  // Back on 1.x, a computer leaves 2.x, but a program chosen for it stays.
  expect(reconcile([instance("o", { kind: "opencode" })], [info(on2)]).saves).toEqual([
    instance("o", { kind: "opencode" }),
  ]);
  const custom = instance("o", { kind: "opencode", program: "/opt/oc" });
  expect(reconcile([instance("o", { kind: "opencode" })], [info(custom)]).saves).toEqual([]);
});

test("a computer's secret stays one, in its place, even if the list has that name as plain", () => {
  const have = instance("codex", {
    env: [
      { name: "B_KEY", secret: true },
      { name: "A_KEY", secret: true },
      { name: "OLD", value: "x", secret: false },
    ],
  });
  const want = instance("codex", {
    env: [
      { name: "A_KEY", value: "plain", secret: false },
      { name: "NEW", value: "y", secret: false },
    ],
  });
  expect(reconcile([want], [info(have)]).saves[0]!.env).toEqual([
    { name: "B_KEY", secret: true },
    { name: "A_KEY", secret: true },
    { name: "NEW", value: "y", secret: false },
  ]);
});

test("a list with nothing on turns nothing off", () => {
  const { saves } = reconcile([instance("a", { enabled: false })], [info(instance("b"))]);
  expect(saves).toEqual([instance("a", { enabled: false })]);
});

test("a computer adds what's missing, updates what differs, and turns others off", () => {
  const wanted = [instance("claude", { kind: "claude", name: "Claude" }), instance("new")];
  const { saves, conflicts } = reconcile(wanted, [
    info(instance("claude", { kind: "claude", name: "Old", program: "/usr/bin/claude" })),
    info(instance("pi", { kind: "pi" })),
    info(instance("off", { kind: "pi", enabled: false })),
    info(instance("hub-codex"), { hub: "home" }),
  ]);
  expect(conflicts).toEqual([]);
  expect(saves).toEqual([
    // Its own CLI path stays.
    instance("claude", { kind: "claude", name: "Claude", program: "/usr/bin/claude" }),
    instance("new"),
    instance("pi", { kind: "pi", enabled: false }),
  ]);
});

test("a computer already in line saves nothing, and keeps its own secrets and home", () => {
  const wanted = linkable(instance("codex", { env: [{ value: "1", name: "A", secret: false }] }));
  const have = instance("codex", {
    home: "/home/grace/.codex",
    env: [
      { name: "A", value: "1", secret: false },
      { name: "OWN_KEY", secret: true },
    ],
  });
  expect(reconcile([wanted], [info(have)])).toEqual({ saves: [], conflicts: [] });
});

test("an id of another kind is reported, not overwritten", () => {
  const { saves, conflicts } = reconcile([instance("x")], [info(instance("x", { kind: "pi" }))]);
  expect(saves).toEqual([]);
  expect(conflicts).toEqual(["x"]);
});

// Two computers that answer from their own lists, reached through the real hook.
function computers(lists: Record<string, ProviderInstance[]>) {
  const connected = {
    status: "connected",
    plxd: "1",
    protocol: 1,
    capabilities: { providers: {} },
  };
  const request = vi.fn(async (host: string, method: string, params: Record<string, unknown>) => {
    const list = lists[host]!;
    if (method === "providers/save") {
      const saved = params["instance"] as ProviderInstance;
      lists[host] = list.some((i) => i.id === saved.id)
        ? list.map((i) => (i.id === saved.id ? saved : i))
        : [...list, saved];
    }
    if (method === "providers/remove") lists[host] = list.filter((i) => i.id !== params["id"]);
    return {
      result: { providers: lists[host]!.map((i) => info(i)), checkedAt: "2026-11-01T00:00:00Z" },
    };
  });
  Object.assign(window, {
    parallax: {
      request,
      connectionState: async () => connected,
      onConnectionState: () => () => {},
    },
  });
  return request;
}
const hosts = [
  { id: "mini", name: "Mac mini" },
  { id: "laptop", name: "Laptop" },
] as never;
let unmount: () => void = () => {};
afterEach(() => {
  act(() => unlinkProviders());
  act(() => unmount());
});
const reach = async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const Reach = () => {
    useProviderLink(hosts);
    return null;
  };
  await act(async () => root.render(createElement(Reach)));
  await act(async () => {});
  unmount = () => root.unmount();
};
const saved = (request: ReturnType<typeof computers>, host: string) =>
  request.mock.calls.filter(([h, m]) => h === host && m === "providers/save");

test("linking uses the chosen computer's list, and later changes reach every computer", async () => {
  const lists = {
    mini: [instance("claude", { kind: "claude" }), instance("codex")],
    laptop: [instance("codex"), instance("pi", { kind: "pi" })],
  };
  const request = computers(lists);
  await reach();
  await loadProviders("mini");
  await act(async () => {
    await linkProviders("mini");
  });
  // The source changes nothing; the other gains Claude and turns Pi off, keeping it.
  expect(saved(request, "mini")).toEqual([]);
  expect(lists.laptop.map((i) => [i.id, i.enabled])).toEqual([
    ["codex", true],
    ["pi", false],
    ["claude", true],
  ]);

  await act(async () => {
    await saveEverywhere("mini", instance("codex", { name: "Work" }));
  });
  await act(async () => {});
  await vi.waitFor(() => expect(lists.laptop.find((i) => i.id === "codex")?.name).toBe("Work"));

  await act(async () => {
    await removeEverywhere("laptop", "claude");
  });
  await vi.waitFor(() => expect(lists.mini.map((i) => i.id)).toEqual(["codex"]));
  expect(lists.laptop.map((i) => i.id)).toEqual(["codex", "pi"]);
});

test("linking needs a provider that's on, so it can't turn everything off elsewhere", async () => {
  const lists = { mini: [instance("off", { enabled: false })], laptop: [instance("codex")] };
  const request = computers(lists);
  await reach();
  await loadProviders("mini");
  await act(async () => {
    await linkProviders("mini");
  });
  expect(saved(request, "laptop")).toEqual([]);
});

test("removing leaves another computer's provider of a different kind under that id", async () => {
  const lists = {
    mini: [instance("work"), instance("codex")],
    laptop: [instance("work", { kind: "pi" }), instance("codex")],
  };
  computers(lists);
  await reach();
  await loadProviders("mini");
  await act(async () => {
    await linkProviders("mini");
  });
  await act(async () => {
    await removeEverywhere("mini", "work");
  });
  await act(async () => {});
  await vi.waitFor(() => expect(lists.mini.map((i) => i.id)).toEqual(["codex"]));
  expect(lists.laptop.map((i) => [i.id, i.kind])).toEqual([
    ["work", "pi"],
    ["codex", "codex"],
  ]);
});

test("a save then a remove, in quick succession, ends removed everywhere", async () => {
  const lists = { mini: [instance("codex")], laptop: [instance("codex")] };
  computers(lists);
  await reach();
  await loadProviders("mini");
  await act(async () => {
    await linkProviders("mini");
  });
  await act(async () => {
    await saveEverywhere("mini", instance("new"));
    await removeEverywhere("mini", "new");
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(lists.laptop.map((i) => i.id)).toEqual(["codex"]);
});

test("while not linked, a change stays on its own computer", async () => {
  const lists = { mini: [instance("codex")], laptop: [instance("codex")] };
  const request = computers(lists);
  await reach();
  await act(async () => {
    await saveEverywhere("mini", instance("codex", { name: "Work" }));
  });
  expect(saved(request, "laptop")).toEqual([]);
});
