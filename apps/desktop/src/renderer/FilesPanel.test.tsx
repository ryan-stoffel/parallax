// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentEntry, AgentFileResult } from "../protocol/generated/protocol";
import { FilesPanel } from "./FilesPanel";
import { SidePanel } from "./SidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const path = (params["path"] as string | undefined) ?? "";
  if (method === "agent/files")
    return { logId: "log-1", result: { entries: folders[path], truncated: false } };
  return { logId: "log-1", result: { path, side: "working", ...files[path] } };
});

beforeEach(() => {
  request.mockClear();
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
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[role="treeitem"] > button')].map((b) => {
    const depth = (parseInt(b.style.paddingLeft) - 10) / 14;
    const state = b.parentElement!.getAttribute("aria-expanded");
    return `${"  ".repeat(depth)}${b.textContent}${state === null ? "" : state === "true" ? " v" : " >"}`;
  });
const row = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"] > button')].find((b) => b.textContent === name);
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
