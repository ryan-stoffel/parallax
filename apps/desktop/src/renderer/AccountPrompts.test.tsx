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
    answerCompare: vi.fn(async () => undefined),
    askAgain: vi.fn(async () => {}),
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

test("a new computer's code takes a click on Allow, never Enter, and typing stays one click away", async () => {
  const comparing: DeviceHost = { ...buildBox, access: { step: "compare", code: "482913" } };
  const parallax = await render([comparing], []);
  expect(dialog()?.textContent).toContain("482 913");
  expect(dialog()?.textContent).toContain("Allow it only if build-box shows this code");
  // Enter submits the form, which must not answer.
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(parallax.answerCompare).not.toHaveBeenCalled();
  await act(async () => button("Allow").click());
  expect(parallax.answerCompare).toHaveBeenCalledWith(buildBox.id, true);
});

test("a new computer's code can be denied, or typed instead", async () => {
  const comparing: DeviceHost = { ...buildBox, access: { step: "compare", code: "482913" } };
  const parallax = await render([comparing], []);
  await act(async () => button("Type a code instead").click());
  expect(document.querySelector('input[aria-label="Code"]')).not.toBeNull();
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
  const again = await render([comparing], []);
  await act(async () => button("Deny").click());
  expect(again.answerCompare).toHaveBeenCalledWith(buildBox.id, false);
  expect(parallax.answerCompare).not.toHaveBeenCalled();
});

test("after Allow, a bare setup command's computer says to confirm there", async () => {
  await render([{ ...buildBox, access: { step: "confirm", code: "482913" } }], []);
  expect(dialog()?.textContent).toContain("Press Enter in build-box's terminal");
  expect(button("Waiting…").disabled).toBe(true);
});

test("a new computer's dialog takes its 6 digits once, clears a wrong code, and confirms the right one", async () => {
  const parallax = await render([buildBox], []);
  expect(dialog()?.textContent).toContain("Add build-box");
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
  expect(dialog()?.textContent).toContain("build-box is added");
  await act(async () => button("Done").click());
  expect(dialog()?.textContent).not.toContain("build-box is added");
});

test("an offline new computer asks for nothing, and the dialog opens once it answers", async () => {
  await render([{ ...buildBox, access: { step: "needsCode", offline: true } }], []);
  expect(dialog()).toBeNull();
  act(() => root?.unmount());
  await render([buildBox], []);
  expect(dialog()?.textContent).toContain("Add build-box");
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
  expect(dialog()?.textContent).toContain("Add build-box");
});
