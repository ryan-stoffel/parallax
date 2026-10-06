// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { HostInput, ParallaxBridge } from "../../preload/bridge";
import { destinationOf, fieldsOf, SshHostDialog } from "./SshHostDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no modal dialogs.
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};

const saveHost = vi.fn<(host: HostInput, id?: string) => Promise<string | undefined>>();
beforeEach(() => {
  saveHost.mockReset().mockResolvedValue(undefined);
  window.parallax = {
    platform: "darwin",
    saveHost,
    sshSuggestions: async () => ["mac-mini", "devbox", "100.87.92.42", "github.com"],
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function render(host?: { id: string; name: string; destination: string }) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<SshHostDialog {...(host && { host })} onDone={() => {}} />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  for (let i = 0; i < 5; i++) await act(async () => {});
}
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const type = (name: string, value: string) =>
  act(() => {
    const el = input(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const options = () =>
  [...document.querySelectorAll('[role="option"]')].map((o) => o.firstChild!.textContent);
const submit = () => act(async () => document.querySelector("form")!.requestSubmit());

test("destinations from the fields, and back", () => {
  expect(destinationOf(" mini ", "", "")).toBe("mini");
  expect(destinationOf("mini", "ryan", "22")).toBe("ryan@mini");
  expect(destinationOf("mini", "ryan", "2222")).toBe("ssh://ryan@mini:2222");
  expect(destinationOf("fd7a::1", "", "2222")).toBe("ssh://[fd7a::1]:2222");
  expect(fieldsOf("ryan@mini")).toEqual({ host: "mini", user: "ryan", port: "" });
  expect(fieldsOf("ssh://ryan@mini:2222")).toEqual({ host: "mini", user: "ryan", port: "2222" });
  expect(fieldsOf("ssh://[fd7a::1]:2222")).toEqual({ host: "fd7a::1", user: "", port: "2222" });
  expect(fieldsOf("devbox")).toEqual({ host: "devbox", user: "", port: "" });
});

test("the host field suggests what ssh knows, filtered, and picks by arrow keys or Mod+number", async () => {
  await render();
  act(() => input("host").focus());
  expect(options()).toEqual(["mac-mini", "devbox", "100.87.92.42", "github.com"]);
  type("host", "de");
  expect(options()).toEqual(["devbox"]);
  type("host", "");
  act(() => {
    input("host").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  act(() => {
    input("host").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(input("host").value).toBe("devbox");
  type("host", "1");
  act(() => {
    input("host").dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true }),
    );
  });
  expect(input("host").value).toBe("100.87.92.42");
});

test("Add computer saves the composed destination, named by the host, and checks the port", async () => {
  await render();
  type("host", "mac-mini");
  type("user", "ryan");
  type("port", "70000");
  await submit();
  expect(saveHost).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')!.textContent).toBe(
    "Port is a number from 1 to 65535.",
  );
  type("port", "2222");
  await submit();
  expect(saveHost).toHaveBeenCalledWith(
    { name: "mac-mini", destination: "ssh://ryan@mac-mini:2222" },
    undefined,
  );
});

test("Edit fills the fields from the saved host and keeps its id and name", async () => {
  await render({ id: "h1", name: "Studio", destination: "ssh://ryan@mini:2222" });
  expect([
    input("host").value,
    input("user").value,
    input("port").value,
    input("name").value,
  ]).toEqual(["mini", "ryan", "2222", "Studio"]);
  type("port", "");
  await submit();
  expect(saveHost).toHaveBeenCalledWith({ name: "Studio", destination: "ryan@mini" }, "h1");
});
