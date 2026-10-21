// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { DeviceStateResult } from "../protocol/generated/protocol";
import { DevicePanel } from "./DevicePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
afterEach(() => act(() => unmount()));

/** The panel on host `hostId`, whose plxd answers `device/state` with `state`. */
async function render(hostId: string, state: DeviceStateResult) {
  const request = vi.fn(async (_host: string, method: string) =>
    method === "device/state" ? { result: state, logId: "l" } : { result: {}, logId: "l" },
  );
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<DevicePanel hostId={hostId} shown />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  for (let i = 0; i < 10; i++) await act(async () => {});
}

const hub = { installed: true, installing: false };

test("a host that can run neither platform says what to get, and where", async () => {
  await render("linux-box", {
    platforms: [
      { platform: "ios", unavailable: "iOS Simulators need macOS with Xcode." },
      {
        platform: "android",
        unavailable:
          "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.",
      },
    ],
    devices: [],
    hub,
    open: [],
  });
  const text = document.body.textContent;
  expect(text).toContain("iPhone needs a Mac");
  expect(text).toContain("Get Android Studio for Android");
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "Android Studio");
  expect(link?.getAttribute("href")).toBe("https://developer.android.com/studio");
  expect(document.querySelector('[aria-label="Devices"]')).toBeNull();
});

test("Android without ffmpeg says so with its install command, and new devices can be made", async () => {
  await render("mac", {
    platforms: [
      { platform: "ios", canCreate: true },
      {
        platform: "android",
        canCreate: true,
        warning:
          "Android video needs ffmpeg. Install it with `brew install ffmpeg`, then restart Parallax.",
      },
    ],
    devices: [],
    hub,
    open: [],
  });
  const text = document.body.textContent;
  expect(text).toContain("Android video needs ffmpeg.");
  expect(document.querySelector('button[title="Copy brew install ffmpeg"]')).not.toBeNull();
  expect(text).toContain("New iPhone");
  expect(text).toContain("New Pixel");
});
