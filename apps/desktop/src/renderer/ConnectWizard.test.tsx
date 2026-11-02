// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { DeviceHost, ParallaxBridge } from "../preload/bridge";
import { AccountPrompts } from "./AccountPrompts";
import { ConnectWizard, SetupCodeDialog } from "./ConnectWizard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const computer = (over: Partial<DeviceHost> = {}): DeviceHost => ({
  id: "account:build-box",
  name: "build-box",
  icon: "server",
  detected: "server",
  hostName: "build-box",
  enabled: true,
  ...over,
});

/** A bridge whose account lists `devices`, connected unless they're still joining. */
function bridge(devices: () => DeviceHost[]) {
  const parallax = {
    onDevices: (listener: (d: DeviceHost[]) => void) => (listener(devices()), () => {}),
    onAccessRequests: () => () => {},
    onProfile: () => () => {},
    discoverAccount: vi.fn(async () => {}),
    enterSetupCode: vi.fn(async () => undefined),
    showSetupCode: vi.fn(async () => ({
      code: "482913",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    onSetupApproved: vi.fn((_listener: (name: string) => void) => () => {}),
    connectionState: vi.fn(async () => ({ status: "connected", plxd: "1.0.0" })),
    onConnectionState: () => () => {},
  };
  window.parallax = parallax as unknown as ParallaxBridge;
  return parallax;
}

/** Add a computer with the app's prompts beside it, as Settings shows it. */
async function renderWizard(devices: DeviceHost[]) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <>
        <AccountPrompts />
        <ConnectWizard channel="stable" devices={devices} onClose={() => {}} />
      </>,
    ),
  );
}

test("while open it asks the account for its computers on a timer, and stops when closed", async () => {
  vi.useFakeTimers();
  const parallax = bridge(() => []);
  await renderWizard([]);
  expect(parallax.discoverAccount).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(parallax.discoverAccount).toHaveBeenCalledTimes(3);
  act(() => root!.unmount());
  root = undefined;
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(parallax.discoverAccount).toHaveBeenCalledTimes(3);
});

test("it asks for a new computer's code itself, then says it's connected", async () => {
  const waiting = computer({ access: { step: "needsCode" } });
  const devices = [waiting];
  const parallax = bridge(() => devices);
  await renderWizard(devices);
  // One dialog: the app's own prompt holds back while this one asks.
  expect(document.querySelectorAll("dialog").length).toBe(1);
  expect(document.body.textContent).toContain("Found build-box");

  const input = document.querySelector<HTMLInputElement>('input[aria-label="Code"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "482 913",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    document
      .querySelector("dialog form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(parallax.enterSetupCode).toHaveBeenCalledWith(waiting.id, "482913");

  await act(async () =>
    root!.render(
      <>
        <AccountPrompts />
        <ConnectWizard channel="stable" devices={[computer()]} onClose={() => {}} />
      </>,
    ),
  );
  await act(async () => {});
  expect(document.body.textContent).toContain("You're connected");
  expect(document.body.textContent).toContain("Add another");
});

test("computers already on the account aren't what it's about", async () => {
  const devices = [computer()];
  bridge(() => devices);
  await renderWizard(devices);
  await act(async () => {});
  expect(document.body.textContent).not.toContain("build-box");
  expect(document.body.textContent).toContain("With the app");
  expect(document.body.textContent).toContain("Looking for your computer");
});

test("a computer already listed that turns out to need its code is asked for here, once", async () => {
  bridge(() => []);
  const show = (devices: DeviceHost[]) =>
    act(async () =>
      root!.render(
        <>
          <AccountPrompts />
          <ConnectWizard channel="stable" devices={devices} onClose={() => {}} />
        </>,
      ),
    );
  await renderWizard([computer()]);
  expect(document.body.textContent).not.toContain("Found build-box");

  await show([computer({ access: { step: "needsCode" } })]);
  expect(document.body.textContent).toContain("Found build-box");
  expect(document.querySelectorAll("dialog").length).toBe(1);

  // Not now stands, with no prompt in its place, however often the account lists it again.
  const notNow = [...document.querySelectorAll("button")].find((b) => b.textContent === "Not now");
  await act(async () => notNow!.click());
  await show([computer({ access: { step: "needsCode" } })]);
  expect(document.body.textContent).not.toContain("build-box");
  expect(document.querySelectorAll("dialog").length).toBe(1);
});

test("a failed pairing already under way when it opens asks for the code again", async () => {
  bridge(() => []);
  await renderWizard([computer({ access: { step: "pairing" } })]);
  await act(async () =>
    root!.render(
      <>
        <AccountPrompts />
        <ConnectWizard
          channel="stable"
          devices={[computer({ access: { step: "needsCode", error: "That code is wrong." } })]}
          onClose={() => {}}
        />
      </>,
    ),
  );
  expect(document.body.textContent).toContain("Found build-box");
});

test("Show setup code shows the code, then who used it", async () => {
  const parallax = bridge(() => []);
  const onReady = vi.fn();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(<SetupCodeDialog name="studio" onReady={onReady} onClose={() => {}} />),
  );
  await act(async () => {});
  expect(document.querySelector('[aria-label="Code"]')?.textContent).toBe("482 913");
  expect(onReady).toHaveBeenCalled();

  const approved = parallax.onSetupApproved.mock.calls.at(-1)![0];
  await act(async () => approved("macbook"));
  expect(document.body.textContent).toContain("studio is connected");
  expect(document.body.textContent).toContain("macbook can reach studio");
});

test("Show setup code says why it couldn't", async () => {
  const parallax = bridge(() => []);
  parallax.showSetupCode.mockResolvedValue("Turn on Reach from anywhere first." as never);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(<SetupCodeDialog name="studio" onReady={() => {}} onClose={() => {}} />),
  );
  await act(async () => {});
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Turn on Reach");
  expect(document.body.textContent).toContain("Try again");
});
