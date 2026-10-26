// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentEntry } from "../protocol/generated/protocol";
import { FilesPanel } from "./FilesPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The entry menu is in the DOM either way.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

const folders: Record<string, AgentEntry[]> = {
  "": [
    { name: "README.md", kind: "file", size: 6 },
    { name: "src", kind: "dir" },
  ],
  src: [{ name: "main.rs", kind: "file", size: 13 }],
};
// plxd: a change (fileCreate, fileRename, fileDelete) succeeds, and agent/files lists `folders`.
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) =>
  method === "agent/files"
    ? {
        logId: "log-1",
        result: {
          entries: folders[(params["path"] as string | undefined) ?? ""],
          truncated: false,
        },
      }
    : { logId: "log-1", result: {} },
);

beforeEach(() => {
  request.mockClear();
  window.parallax = {
    platform: "darwin",
    request,
    connectionState: async () => ({ status: "connected", plxd: "", protocol: 1, capabilities: {} }),
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function render(node: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const type = async (value: string, key: string) => {
  const input = document.activeElement as HTMLInputElement;
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
};
const button = (label: string) =>
  document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.startsWith(name),
  );

test("Delete asks first, then deletes the entry and lists its folder again", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await click(button("Actions for README.md"));
  await click(menuItem("Delete"));
  expect(request).not.toHaveBeenCalledWith("local", "agent/fileDelete", expect.anything());

  request.mockClear();
  await click([...document.querySelectorAll("dialog button")].at(-1));
  expect(request).toHaveBeenCalledWith("local", "agent/fileDelete", {
    runId: "run-1",
    path: "README.md",
  });
  expect(request).toHaveBeenCalledWith("local", "agent/files", { runId: "run-1" });
});

test("without fileEdit, the tree has no New buttons or entry menus", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" />);
  expect(button("New file")).toBeNull();
  expect(button("Actions for src")).toBeNull();
});

test("Enter then leaving the field saves once, and a blank name closes it without asking plxd", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await click(button("New file"));
  request.mockClear();
  // plxd answers only after the field loses focus.
  let answer = () => {};
  request.mockImplementationOnce(
    () => new Promise((done) => (answer = () => done({ logId: "log-1", result: {} }))),
  );
  const input = document.activeElement as HTMLInputElement;
  await type("notes.md", "Enter");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await act(async () => answer());
  await settle();
  expect(request.mock.calls.filter(([, m]) => m === "agent/fileCreate")).toHaveLength(1);
  expect(document.querySelector("input")).toBeNull();

  await click(button("New folder"));
  request.mockClear();
  await type("  ", "Enter");
  expect(document.querySelector("input")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
