// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import { useWatchKey } from "./useWatchKey";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const connected: ConnectionState = {
  status: "connected",
  plxd: "1.0.0",
  protocol: 1,
  capabilities: {},
};
const listeners = new Set<Parameters<ParallaxBridge["onConnectionState"]>[0]>();
let unmount = () => {};
afterEach(() => {
  act(unmount);
  listeners.clear();
  document.body.innerHTML = "";
});

function renderWatch() {
  window.parallax = {
    onConnectionState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as Partial<ParallaxBridge> as ParallaxBridge;
  let key: string | undefined;
  let fail = () => {};
  const opened = vi.fn();
  function Watch({ online }: { online: boolean }) {
    [key, fail] = useWatchKey("local\nthread", online, "local");
    opened(online);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (online: boolean) => root.render(<Watch online={online} />);
  act(() => render(true));
  unmount = () => root.unmount();
  const emit = (host: string, state: ConnectionState) => {
    for (const listener of listeners) listener(host, state);
  };
  return { key: () => key, fail: () => fail(), emit, render, opened };
}

test("a failed watch reopens after reconnect even when React never renders offline", () => {
  const watch = renderWatch();
  const first = watch.key();
  act(watch.fail);
  expect(watch.key()).toBe(first);
  watch.opened.mockClear();
  act(() => {
    watch.emit("local", { status: "connecting" });
    watch.render(false);
    watch.emit("local", connected);
    watch.render(true);
  });
  expect(watch.key()).toBeDefined();
  expect(watch.key()).not.toBe(first);
  expect(watch.opened.mock.calls.every(([online]) => online)).toBe(true);
});

test("healthy watches keep their keys and another host cannot reopen a failed watch", () => {
  const watch = renderWatch();
  const first = watch.key();
  act(() => {
    watch.emit("local", { status: "connecting" });
    watch.emit("local", connected);
  });
  expect(watch.key()).toBe(first);
  act(watch.fail);
  act(() => watch.emit("remote", connected));
  expect(watch.key()).toBe(first);
  act(() => {
    watch.emit("local", { status: "connecting" });
    watch.render(false);
  });
  act(() => {
    watch.emit("local", connected);
    watch.render(true);
  });
  expect(watch.key()).not.toBe(first);
});
