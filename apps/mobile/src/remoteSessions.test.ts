import { expect, test, vi } from "vitest";

import { begin } from "./fakeReact";
import { useRemoteSessions } from "./remoteSessions";

vi.mock("react", async (actual) => ({
  ...(await actual<object>()),
  ...(await import("./fakeReact")).hooks,
}));

test("paired devices asked for during a short drop are asked for again once it's back", async () => {
  let down = true;
  const sessions = [{ id: "s", name: "iPad" }];
  const request = vi.fn(async () =>
    down
      ? { error: { code: -32603, message: "not connected" } }
      : { result: { sessions, listening: false, pairing: false } },
  );
  vi.stubGlobal("window", { parallax: { request } });
  const render = (connectedNow: boolean) => {
    begin();
    return useRemoteSessions("a", true, connectedNow);
  };

  render(false);
  await Promise.resolve();
  down = false;
  render(true);
  await vi.waitFor(() => expect(render(true).status?.sessions).toEqual(sessions));
});
