// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectState, DeviceHost, Profile } from "../preload/bridge";
import { MOVE_WAIT_MS, useConnectMoveAlarm } from "./connectMove";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};

const signedIn = { name: "Ryan", email: "ryan@example.com" } as Profile;
const tailnet = { id: "tailnet:n1", name: "studio", enabled: true } as DeviceHost;
const account = { id: "account:a1", name: "studio", enabled: true } as DeviceHost;

let connect: ConnectState;
let profile: Profile | null;
let devices: DeviceHost[];
let deviceListeners: Set<(devices: DeviceHost[]) => void>;
let claimed: boolean;
let moveConnect: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>;
let root: Root | undefined;

const setDevices = (next: DeviceHost[]) => {
  devices = next;
  for (const listener of deviceListeners) listener(next);
};

beforeEach(() => {
  connect = { on: true, icon: "laptop", channel: "nightly" };
  profile = signedIn;
  devices = [tailnet];
  deviceListeners = new Set();
  claimed = false;
  moveConnect = vi.fn(async () => undefined);
  Object.assign(window, {
    parallax: {
      onConnect: (listener: (state: ConnectState) => void) => (listener(connect), () => {}),
      onProfile: (listener: (next: Profile | null) => void) => (listener(profile), () => {}),
      onDevices: (listener: (next: DeviceHost[]) => void) => {
        deviceListeners.add(listener);
        listener(devices);
        return () => deviceListeners.delete(listener);
      },
      claimConnectMove: async () => {
        const first = !claimed;
        claimed = true;
        return first;
      },
      moveConnect,
    },
  });
});

afterEach(() => {
  for (const close of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

function Alarm() {
  useConnectMoveAlarm();
  return <Notifications />;
}

async function render() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Alarm />));
}

const toast = () => document.querySelector('[aria-label="Notifications"] > div');
const click = (label: string) =>
  act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === label)!.click(),
  );

test("recommends the new Connect once on a computer still on Tailscale", async () => {
  await render();
  expect(toast()?.textContent).toContain("Try the new Parallax Connect");
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  act(() => root?.unmount());
  await render();
  expect(toast()).toBeNull();
});

test("says nothing with Connect off, or once everything moved to the account", async () => {
  connect = { ...connect, on: false };
  await render();
  expect(toast()).toBeNull();
  act(() => root?.unmount());

  connect = { ...connect, on: true };
  devices = [account];
  await render();
  expect(toast()).toBeNull();
  expect(claimed).toBe(false);
});

test("signed out, Connect on is enough to recommend it", async () => {
  profile = null;
  devices = [];
  await render();
  expect(toast()?.textContent).toContain("Try the new Parallax Connect");
});

test("its action moves, and says so once every computer answers through the account", async () => {
  await render();
  await click("Move to new Connect");
  expect(moveConnect).toHaveBeenCalledOnce();
  expect(toast()?.textContent).toContain("Moving to the new Parallax Connect");
  await act(async () => {
    setDevices([account]);
    await Promise.resolve();
  });
  expect(toast()?.textContent).toContain("You're on the new Parallax Connect");
});

test("names a computer that hasn't moved by the time the wait ends", async () => {
  vi.useFakeTimers();
  await render();
  await click("Move to new Connect");
  await act(async () => void (await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS)));
  expect(toast()?.textContent).toContain("Still waiting on studio");
});

test("a failed move says why and offers to try again", async () => {
  moveConnect.mockResolvedValueOnce("Sign-in was cancelled.");
  await render();
  await click("Move to new Connect");
  expect(toast()?.textContent).toContain("Sign-in was cancelled.");
  await click("Try again");
  expect(moveConnect).toHaveBeenCalledTimes(2);
  await act(async () => {
    setDevices([account]);
    await Promise.resolve();
  });
});
