// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { HostInput, ParallaxBridge } from "../../preload/bridge";
import { destinationOf, fieldsOf } from "./SshHostDialog";

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
