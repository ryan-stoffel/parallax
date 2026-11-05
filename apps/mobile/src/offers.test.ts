import { expect, test, vi } from "vitest";

import { useOffers } from "./offers";
import type { Computer } from "./fleet";

// Just enough of React to run the hook's effects, since these tests run without a renderer.
const react = vi.hoisted(() => {
  const slots: unknown[] = [];
  let at = 0;
  return {
    begin: () => void (at = 0),
    useState: (first?: unknown) => {
      const i = at++;
      if (!(i in slots)) slots[i] = first;
      return [slots[i], (next: unknown) => void (slots[i] = next)];
    },
    useEffect: (run: () => void, deps: unknown[]) => {
      const i = at++;
      const before = slots[i] as unknown[] | undefined;
      if (before && deps.every((d, j) => Object.is(d, before[j]))) return;
      slots[i] = deps;
      run();
    },
  };
});
vi.mock("react", async (actual) => ({
  ...(await actual<object>()),
  useState: react.useState,
  useEffect: react.useEffect,
}));

test("a computer's provider list asked during a short drop is asked again once it's back", async () => {
  let down = true;
  const request = vi.fn(async () =>
    down
      ? { error: { code: -32603, message: "not connected" } }
      : {
          result: {
            providers: [
              {
                instance: { id: "work", name: "Work", kind: "codex", enabled: true, models: [] },
                models: [],
              },
            ],
          },
        },
  );
  vi.stubGlobal("window", { parallax: { request } });
  const computer = (connectedNow: boolean) =>
    ({
      machine: { id: "a" },
      shownConnected: true,
      connectedNow,
      view: { capabilities: { providers: {} } },
    }) as unknown as Computer;
  const render = (connectedNow: boolean) => {
    react.begin();
    return useOffers(computer(connectedNow));
  };

  render(false);
  await Promise.resolve();
  down = false;
  render(true);
  await vi.waitFor(() => expect(render(true).map((o) => o.id)).toEqual(["work"]));
});
