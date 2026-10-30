// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { AccessPrompt, DeviceHost, ParallaxBridge } from "../preload/bridge";
import { AccountPrompts } from "./AccountPrompts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const buildBox: DeviceHost = {
  id: "account:Q2s9vX1k7d0b8Lr4mT6pWc3eYh5uNz2aFgJ_iK-oPqR",
  name: "build-box",
  icon: "server",
  detected: "server",
  hostName: "build-box",
  enabled: true,
  access: { step: "needsCode" },
};
const phone: AccessPrompt = { id: "r1", name: "Ryan's iPhone", code: "731905", host: "studio" };

/** Renders the prompts over a bridge that lists `devices` and `requests`. */
async function render(devices: DeviceHost[], requests: AccessPrompt[]) {
  const parallax = {
    onDevices: (listener: (d: DeviceHost[]) => void) => (listener(devices), () => {}),
    onAccessRequests: (listener: (r: AccessPrompt[]) => void) => (listener(requests), () => {}),
    enterSetupCode: vi.fn(async (_id: string, code: string) =>
      code === "482913" ? undefined : "That code is wrong, used, or expired.",
    ),
    answerAccess: vi.fn(async () => undefined),
  };
  window.parallax = parallax as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<AccountPrompts />));
  return parallax;
}

const dialog = () => document.querySelector("dialog");
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
const type = async (text: string) => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Code"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("a new computer's dialog takes its 6 digits once, clears a wrong code, and closes on the right one", async () => {
  const parallax = await render([buildBox], []);
  expect(dialog()?.textContent).toContain("Connect build-box");
  await type("482 91");
  expect(button("Connect").disabled).toBe(true);

  await type("111 111");
  await act(async () => button("Connect").click());
  expect(parallax.enterSetupCode).toHaveBeenCalledWith(buildBox.id, "111111");
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toMatch(/wrong/);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Code"]')!.value).toBe("");

  await type("482 913");
  await act(async () => button("Connect").click());
  expect(parallax.enterSetupCode).toHaveBeenLastCalledWith(buildBox.id, "482913");
  expect(dialog()).toBeNull();
});

test("a device's request comes first, shows its code, and is allowed or denied", async () => {
  const parallax = await render([buildBox], [phone, { ...phone, id: "r2", name: "iPad" }]);
  expect(dialog()?.textContent).toContain("Allow Ryan's iPhone?");
  expect(dialog()?.querySelector('[aria-label="Code"]')?.textContent).toBe("731 905");

  await act(async () => button("Allow").click());
  expect(parallax.answerAccess).toHaveBeenCalledWith("r1", true);
  expect(dialog()?.textContent).toContain("Allow iPad?");

  await act(async () => button("Deny").click());
  expect(parallax.answerAccess).toHaveBeenLastCalledWith("r2", false);
  // Then the new computer's code.
  expect(dialog()?.textContent).toContain("Connect build-box");
});
