// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";

import type { ProvidersListResult } from "../protocol/generated/protocol";
import { discoveredAt, listedProviders, loadProviders, saveProvider } from "./providers";

const result = (enabled: boolean, ids = ["gpt-6-sol"]): ProvidersListResult => ({
  providers: [
    {
      instance: {
        id: "codex",
        kind: "codex",
        name: "Codex",
        enabled,
        args: [],
        env: [],
        models: [],
      },
      models: ids.map((id) => ({ id, name: id })),
      installed: true,
      permissions: [],
      efforts: true,
      orchestrator: false,
    },
  ],
  checkedAt: "2026-10-31T00:00:00Z",
});

test("an old refresh cannot restore a provider disabled by a save", async () => {
  let resolve!: (value: { result: ProvidersListResult }) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ result: result(false) });
  Object.assign(window, { parallax: { request } });
  const oldLoad = loadProviders("race-test", true);
  await saveProvider("race-test", result(false).providers[0]!.instance);
  resolve({ result: result(true) });
  await oldLoad;
  expect(listedProviders("race-test")!.providers[0]!.instance.enabled).toBe(false);
});

test("discovery dates persist without making shipped models new or resetting new ones", async () => {
  Object.assign(window, {
    parallax: {
      request: vi.fn().mockResolvedValue({ result: result(true, ["gpt-6-sol", "upstream-new"]) }),
    },
  });
  await loadProviders("discover-test", true);
  expect(discoveredAt("discover-test", "codex", "gpt-6-sol")).toBe("1970-01-01");
  const first = discoveredAt("discover-test", "codex", "upstream-new");
  expect(first).toBeDefined();
  await loadProviders("discover-test", true);
  expect(discoveredAt("discover-test", "codex", "upstream-new")).toBe(first);
  expect(localStorage.getItem("parallax.modelDiscoveries")).toContain("upstream-new");
});

test("catalog waits for configured providers and shares periodic refresh across consumers", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useCatalog } = await import("./models");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ result: result(true, ["live-only"]) });
  Object.assign(window, {
    parallax: {
      request,
      onConnectionState: () => () => {},
      connectionState: () =>
        Promise.resolve({ status: "connected", capabilities: { providers: true } }),
    },
  });
  const seen: string[][] = [];
  function Consumer() {
    const catalog = useCatalog("refresh-test");
    seen.push(catalog.models.map((m) => m.id));
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render([0, 1].map((key) => <Consumer key={key} />)));
    expect(seen[0]).toEqual([]);
    expect(seen.at(-1)).toEqual(["live-only"]);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(request).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    vi.advanceTimersByTime(60_000);
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
