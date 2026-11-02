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

test("a list never holds a secret's value or a CLI's path, and its homes are portable", () => {
  const entry = linkable(
    instance("work", {
      program: "/opt/homebrew/bin/codex",
      home: "/Users/ada/.codex-work",
      env: [
        { name: "API_KEY", value: "sk-secret", secret: true },
        { name: "BASE_URL", value: "https://example.test", secret: false },
      ],
    }),
  );
  expect(JSON.stringify(entry)).not.toContain("sk-secret");
  expect(entry.program).toBeUndefined();
  expect(entry.home).toBe("~/.codex-work");
  expect(entry.env).toEqual([
    { name: "API_KEY", secret: true },
    { name: "BASE_URL", value: "https://example.test", secret: false },
  ]);
  expect(linkable(instance("w", { home: "/home/ada/.w" })).home).toBe("~/.w");
  expect(linkable(instance("w", { home: "C:\\Users\\ada\\.w\\x" })).home).toBe("~/.w/x");
  expect(linkable(instance("w", { home: "/srv/codex" })).home).toBe("/srv/codex");
  expect(linkable(instance("o", { kind: "ollamaCloud", home: "/Users/a/o" })).home).toBeUndefined();
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
  const wanted = linkable(instance("codex", { env: [{ name: "A", value: "1", secret: false }] }));
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
  expect(lists.mini.map((i) => i.id)).toEqual(["codex"]);
  expect(lists.laptop.map((i) => i.id)).toEqual(["codex", "pi"]);
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
