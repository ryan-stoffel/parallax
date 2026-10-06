// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentEntry, AgentFileResult } from "../protocol/generated/protocol";
import { FilesPanel } from "./FilesPanel";
import { SidePanel } from "./SidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The entry menu is in the DOM either way.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

const folders: Record<string, AgentEntry[]> = {
  "": [
    { name: "README.md", kind: "file", size: 6 },
    { name: "big.bin", kind: "file", size: 5_000_000 },
    { name: "logo.png", kind: "file", size: 4 },
    { name: "src", kind: "dir" },
  ],
  src: [{ name: "main.rs", kind: "file", size: 13 }],
};
const files: Record<string, Partial<AgentFileResult>> = {
  "src/main.rs": { exists: true, content: btoa("fn main() {}\n"), tooLarge: false },
  "logo.png": { exists: true, content: btoa("\x89PNG\x00"), tooLarge: false },
  "big.bin": { exists: true, tooLarge: true },
};
// plxd's answer to a change: the error message to fail with, or nothing.
let editError: string | undefined;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const path = (params["path"] as string | undefined) ?? "";
  if (method.startsWith("agent/file") && method !== "agent/file" && method !== "agent/files")
    return editError
      ? { error: { code: -32602, message: `Invalid params: ${editError}` } }
      : { logId: "log-1", result: {} };
  if (method === "agent/files")
    return { logId: "log-1", result: { entries: folders[path], truncated: false } };
  return { logId: "log-1", result: { path, side: "working", ...files[path] } };
});

beforeEach(() => {
  request.mockClear();
  editError = undefined;
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
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
// Each row of the tree, indented by depth, its folders marked open or closed.
const rowButtons = () =>
  [...document.querySelectorAll<HTMLElement>('[role="treeitem"] > div > button')].filter(
    (b) => !b.hasAttribute("data-actions"),
  );
const rows = () =>
  rowButtons().map((b) => {
    const depth = (parseInt(b.style.paddingLeft) - 10) / 14;
    const state = b.closest('[role="treeitem"]')!.getAttribute("aria-expanded");
    return `${"  ".repeat(depth)}${b.textContent}${state === null ? "" : state === "true" ? " v" : " >"}`;
  });
const row = (name: string) => rowButtons().find((b) => b.textContent === name);
const back = () => document.querySelector<HTMLElement>("button:has(.lucide-chevron-left)");
const shown = () => document.body.textContent;

test("the tree lists folders first, opens a folder lazily on click, and opens files read-only", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" />);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("local", "agent/files", { runId: "run-1" });
  expect(rows()).toEqual(["src >", "README.md", "big.bin", "logo.png"]);

  await click(row("src"));
  expect(request).toHaveBeenLastCalledWith("local", "agent/files", { runId: "run-1", path: "src" });
  expect(rows()).toEqual(["src v", "  main.rs", "README.md", "big.bin", "logo.png"]);

  await click(row("main.rs"));
  expect(request).toHaveBeenLastCalledWith("local", "agent/file", {
    runId: "run-1",
    path: "src/main.rs",
    side: "working",
  });
  const pre = document.querySelector('pre[aria-label="src/main.rs"]')!;
  expect(pre.textContent).toBe("fn main() {}\n");
  expect(pre.className).toContain("font-mono");

  // Back to the tree as it was; closing and opening a folder lists it again.
  await click(back());
  expect(rows()).toEqual(["src v", "  main.rs", "README.md", "big.bin", "logo.png"]);
  await click(row("src"));
  expect(rows()).toEqual(["src >", "README.md", "big.bin", "logo.png"]);
  const calls = request.mock.calls.length;
  await click(row("src"));
  expect(request.mock.calls.length).toBe(calls + 1);
});

test("binary and oversized files show a note instead of their content", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" />);
  await click(row("logo.png"));
  expect(shown()).toContain("This is a binary file.");
  expect(document.querySelector("pre")).toBeNull();
  await click(back());
  await click(row("big.bin"));
  expect(shown()).toContain("This file is too large to show.");
});

test("with no thread open, or a plxd without files, the view says so and asks nothing", async () => {
  await render(<SidePanel open onClose={() => {}} expanded={false} onExpandedChange={() => {}} />);
  const files = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find((b) =>
    b.textContent?.startsWith("Files"),
  )!;
  expect(files.disabled).toBe(false);
  await click(files);
  expect(shown()).toContain("No thread open");
  act(() => unmount());

  await render(<FilesPanel hostId="local" runId="run-1" unavailable="Update Parallax." />);
  expect(shown()).toContain("Update Parallax.");
  expect(request).not.toHaveBeenCalled();
});

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

test("an editable tree creates a file in a folder from its menu, and lists the folder again", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await click(button("Actions for src"));
  await click(menuItem("New file"));
  // The folder opens with a name field at its top.
  expect(rows()).toEqual(["src v", "  main.rs", "README.md", "big.bin", "logo.png"]);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("File name");

  request.mockClear();
  await type("lib.rs", "Enter");
  expect(request).toHaveBeenCalledWith("local", "agent/fileCreate", {
    runId: "run-1",
    path: "src/lib.rs",
    folder: false,
  });
  expect(request).toHaveBeenCalledWith("local", "agent/files", { runId: "run-1", path: "src" });
  expect(document.querySelector("input")).toBeNull();
});

test("a failed save keeps the name field open with plxd's reason, and Escape cancels", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await click(button("New folder"));
  editError = '"src" already exists';
  await type("src", "Enter");
  expect(request).toHaveBeenLastCalledWith("local", "agent/fileCreate", {
    runId: "run-1",
    path: "src",
    folder: true,
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('"src" already exists');
  expect(document.querySelector("input")).not.toBeNull();

  request.mockClear();
  await type("ignored", "Escape");
  expect(document.querySelector("input")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

test("F2 renames an entry in place, and an open folder keeps its contents under the new name", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await click(row("src"));
  await act(async () =>
    row("src")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })),
  );
  expect((document.activeElement as HTMLInputElement).value).toBe("src");

  const before = { ...folders };
  folders[""] = folders[""]!.map((e) => (e.name === "src" ? { ...e, name: "lib" } : e));
  folders["lib"] = folders["src"]!;
  await type("lib", "Enter");
  expect(request).toHaveBeenCalledWith("local", "agent/fileRename", {
    runId: "run-1",
    from: "src",
    to: "lib",
  });
  expect(rows()).toEqual(["lib v", "  main.rs", "README.md", "big.bin", "logo.png"]);
  Object.assign(folders, before);
  delete folders["lib"];
});

test("Delete asks first, then deletes the entry and lists its folder again", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await click(button("Actions for README.md"));
  await click(menuItem("Delete"));
  expect(shown()).toContain("Delete “README.md”?");
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

test("a failed rename keeps its field open with the reason", async () => {
  await render(<FilesPanel hostId="local" runId="run-1" editable />);
  await act(async () =>
    row("README.md")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })),
  );
  editError = '"src" already exists';
  await type("src", "Enter");
  expect(request).toHaveBeenLastCalledWith("local", "agent/fileRename", {
    runId: "run-1",
    from: "README.md",
    to: "src",
  });
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Rename README.md"]'),
  ).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('"src" already exists');
});
