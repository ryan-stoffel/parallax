// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import { useShownConnections, useForgetRemoved } from "./ConnectionStatus";
import { RECONNECT_GRACE_MS } from "./reconnectGrace";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const connected: ConnectionState = {
  status: "connected",
  plxd: "1",
  protocol: 1,
  capabilities: {},
};
const connecting: ConnectionState = { status: "connecting" };

let root: Root | undefined;
let changed: (hostId: string, state: ConnectionState) => void;
let shown: (ConnectionState | undefined)[];

// As the phone's fleet reads its computers, and the desktop forgets a removed host.
function Hosts({ hosts }: { hosts: { id: string }[] }) {
  shown = useShownConnections(hosts.map((host) => host.id));
  useForgetRemoved(hosts);
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  const parallax: Partial<ParallaxBridge> = {
    connectionState: async () => connected,
    onConnectionState: (listener) => ((changed = listener), () => {}),
  };
  Object.assign(window, { parallax });
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Hosts hosts={[{ id: "a" }]} />));
});
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});

test("a drop shows as connected until its grace ends, and its real state after", async () => {
  expect(shown[0]).toEqual(connected);
  await act(async () => changed("a", connecting));
  await act(async () => void vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1));
  expect(shown[0]).toEqual(connected);
  await act(async () => void vi.advanceTimersByTime(1));
  expect(shown[0]).toEqual(connecting);
});

test("a removed host added back is a first connect, shown at once", async () => {
  await act(async () => root!.render(<Hosts hosts={[]} />));
  // As main answers while the host has no connection.
  window.parallax.connectionState = () => Promise.reject(new Error("unknown host"));
  await act(async () => root!.render(<Hosts hosts={[{ id: "a" }]} />));
  await act(async () => changed("a", connecting));
  expect(shown[0]).toEqual(connecting);
});
