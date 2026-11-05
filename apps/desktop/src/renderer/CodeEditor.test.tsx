// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import CodeEditor from "./CodeEditor";
import { OpenFiles } from "./openFiles";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const disk = new Map<string, string>();
const writes: { path: string; text: string }[] = [];
const request = vi.fn(async (_host: string, method: string, p: Record<string, string>) => {
  const path = p["path"]!;
  if (method === "agent/file") {
    const text = disk.get(path) ?? "";
    return {
      logId: "l",
      result: { path, exists: true, tooLarge: false, content: btoa(text), sha256: `sha-${text}` },
    };
  }
  const text = atob(p["content"]!);
  writes.push({ path, text });
  disk.set(path, text);
  return { logId: "l", result: { conflict: false, sha256: `sha-${text}` } };
});

let root: Root | undefined;
const shown = (store: OpenFiles) => {
  const { tabs, active } = store.get();
  return tabs.find((f) => f.id === active)!;
};
function mount(store: OpenFiles) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  draw(store);
}
const draw = (store: OpenFiles) =>
  act(() =>
    root!.render(<CodeEditor store={store} file={shown(store)} wrap={false} onCursor={() => {}} />),
  );
const unmount = () => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
};
const editor = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
const typed = (text: string) =>
  act(() => editor().dispatch({ changes: { from: 0, insert: text } }));
const doc = () => editor().state.doc.toString();

async function twoTabs() {
  disk.set("a.ts", "a\n");
  disk.set("b.ts", "b\n");
  const store = new OpenFiles("local", "run-1");
  store.writable = true;
  const a = store.open("a.ts");
  const b = store.open("b.ts");
  await act(async () => {});
  return { store, a, b };
}

beforeEach(() => {
  disk.clear();
  writes.length = 0;
  window.parallax = {
    request,
    connectionState: async () => ({ status: "connected" }),
  } as unknown as ParallaxBridge;
});
afterEach(unmount);

test("a tab's edits save to its own file after the editor is mounted again", async () => {
  const { store, a, b } = await twoTabs();
  mount(store);
  store.activate(a);
  draw(store);
  store.activate(b);
  draw(store);
  store.activate(a);
  draw(store);
  // Switching threads or showing a preview unmounts the editor. Its states stay in the store.
  unmount();
  mount(store);
  store.activate(b);
  draw(store);
  typed("edit ");
  await act(() => store.save(b));
  expect(writes).toEqual([{ path: "b.ts", text: "edit b\n" }]);
});

test("coming back to a tab keeps its unsaved edits, whatever its reload count", async () => {
  const { store, a, b } = await twoTabs();
  mount(store);
  store.activate(a);
  draw(store);
  // A's disk moves and it reloads, so its count differs from B's.
  disk.set("a.ts", "a2\n");
  await act(() => store.reload(a));
  draw(store);
  expect(doc()).toBe("a2\n");
  store.activate(b);
  draw(store);
  typed("mine ");
  // Held by a conflict, so these edits stay unsaved.
  disk.set("b.ts", "the agent's\n");
  await act(() => store.check(b));
  expect(store.unsaved(b)).toBe(true);
  store.activate(a);
  draw(store);
  store.activate(b);
  draw(store);
  expect(doc()).toBe("mine b\n");
  unmount();
  mount(store);
  expect(doc()).toBe("mine b\n");
});
