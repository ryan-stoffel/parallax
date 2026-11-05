import { expect, test, vi } from "vitest";

import { begin } from "./fakeReact";
import type { Computer } from "./fleet";
import { useOffers } from "./offers";

vi.mock("react", async (actual) => ({
  ...(await actual<object>()),
  ...(await import("./fakeReact")).hooks,
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
    begin();
    return useOffers(computer(connectedNow));
  };

  render(false);
  await Promise.resolve();
  down = false;
  render(true);
  await vi.waitFor(() => expect(render(true).map((o) => o.id)).toEqual(["work"]));
});
