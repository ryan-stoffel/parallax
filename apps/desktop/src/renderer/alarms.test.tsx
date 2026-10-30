// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import { useConnectionAlarms } from "./alarms";
import type { Host } from "./hosts";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.showPopover = () => {};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const hosts: Host[] = [
  { id: "account:Q2s9vX1k7d0b8Lr4mT6pWc3eYh5uNz2aFgJ_iK-oPqR", name: "mac-mini" },
  { id: "lan:studio", name: "studio" },
];

function Alarms() {
  useConnectionAlarms(hosts);
  return <Notifications />;
}

test("an account computer refused for want of a session raises no error, and another host's refusal does", async () => {
  let changed: (hostId: string, state: ConnectionState) => void = () => {};
  const parallax: Partial<ParallaxBridge> = {
    connectionState: async () => ({ status: "connecting" }),
    onConnectionState: (listener) => ((changed = listener), () => {}),
  };
  Object.assign(window, { parallax });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Alarms />));

  const refused = (message: string): ConnectionState => ({
    status: "failed",
    error: { reason: "refused", message },
    retrying: false,
  });
  await act(async () =>
    changed(hosts[0]!.id, refused("mac-mini hasn't let this computer in yet.")),
  );
  expect(document.body.textContent).not.toContain("Couldn't connect to mac-mini");
  await act(async () =>
    changed(hosts[1]!.id, refused("studio doesn't know this computer anymore.")),
  );
  expect(document.body.textContent).toContain("Couldn't connect to studio");
});
