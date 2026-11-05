// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import { useConnectionAlarms } from "./alarms";
import type { Host } from "./hosts";
import { Notifications } from "./notifications";
import { RECONNECT_GRACE_MS } from "./reconnectGrace";

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

test("a drop raises no notice until its grace ends, and none at all if it reconnects in time", async () => {
  vi.useFakeTimers();
  try {
    const connected: ConnectionState = {
      status: "connected",
      plxd: "1",
      protocol: 1,
      capabilities: {},
    };
    const down: ConnectionState = {
      status: "failed",
      error: { reason: "exited", message: "gone" },
      retrying: true,
    };
    let changed: (hostId: string, state: ConnectionState) => void = () => {};
    const parallax: Partial<ParallaxBridge> = {
      connectionState: async () => connected,
      onConnectionState: (listener) => ((changed = listener), () => {}),
    };
    Object.assign(window, { parallax });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Alarms />));
    const studio = hosts[1]!.id;

    await act(async () => changed(studio, down));
    await act(async () => void vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1));
    expect(document.body.textContent).not.toContain("Lost connection");
    await act(async () => changed(studio, connected));
    await act(async () => void vi.advanceTimersByTime(RECONNECT_GRACE_MS));
    expect(document.body.textContent).not.toContain("Lost connection");
    expect(document.body.textContent).not.toContain("Reconnected");

    await act(async () => changed(studio, down));
    await act(async () => void vi.advanceTimersByTime(RECONNECT_GRACE_MS));
    expect(document.body.textContent).toContain("Lost connection to studio");
    await act(async () => changed(studio, connected));
    expect(document.body.textContent).toContain("Reconnected to studio");
  } finally {
    vi.useRealTimers();
  }
});

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
