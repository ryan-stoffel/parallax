// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { DeviceHost, ParallaxBridge } from "../preload/bridge";
import { NewComputerDialog } from "./AccountPrompts";
import { ConnectWizard } from "./ConnectWizard";

vi.mock("./ConnectionStatus", () => ({
  useConnection: () => ({ status: "connected" }),
  statusLabel: () => "Connected",
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const computer = (name: string, enabled: boolean): DeviceHost => ({
  id: `account:${name}`,
  name,
  hostName: name,
  icon: "server",
  detected: "server",
  enabled,
});

test("Add computer opens code entry for removed and already connected computers", async () => {
  const removed = computer("mac-mini", false);
  const connected = computer("studio", true);
  const parallax = {
    discoverAccount: vi.fn(async () => [removed, connected]),
    enterSetupCode: vi.fn(async () => undefined),
    setDeviceEnabled: vi.fn(),
  };
  window.parallax = parallax as unknown as ParallaxBridge;
  function Adding() {
    const [entering, setEntering] = useState<DeviceHost>();
    return (
      <>
        <ConnectWizard
          channel="nightly"
          devices={[connected]}
          onClose={() => {}}
          onEnterCode={setEntering}
        />
        {entering && (
          <NewComputerDialog computer={entering} onClose={() => setEntering(undefined)} />
        )}
      </>
    );
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Adding />));
  expect(parallax.discoverAccount).toHaveBeenCalledOnce();
  expect(parallax.setDeviceEnabled).not.toHaveBeenCalled();

  for (const name of ["mac-mini", "studio"]) {
    const row = [...document.querySelectorAll("li")].find(
      (li) => li.querySelector("p")?.textContent === name,
    )!;
    const enter = [...row.querySelectorAll("button")].find((b) => b.textContent === "Enter code");
    expect(enter).toBeDefined();
    await act(async () => enter!.click());
    const dialog = document.querySelector("dialog[aria-labelledby] form")!.closest("dialog")!;
    expect(dialog.textContent).toContain(`Connect ${name}`);
    const cancel = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
  }
});
