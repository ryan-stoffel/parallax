// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentEntry } from "../protocol/generated/protocol";
import { Folder } from "lucide-react";

import { FileTabs } from "./FileEditor";
import { FilesPanel } from "./FilesPanel";
import { openFilesOf, resetOpenFiles } from "./openFiles";

// CodeMirror needs layout that happy-dom doesn't have. Its saving is `openFiles`', tested there.
vi.mock("./CodeEditor", () => ({
  default: ({ file }: { file: { path: string } }) => <div data-testid="editor">{file.path}</div>,
}));

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
    : method === "agent/file"
      ? {
          logId: "log-1",
          result: {
            path: params["path"],
            exists: true,
            size: 6,
            tooLarge: false,
            content: btoa("hello\n"),
            sha256: "sha",
          },
        }
      : { logId: "log-1", result: {} },
);

beforeEach(() => {
  resetOpenFiles();
  request.mockClear();
  window.parallax = {
    platform: "darwin",
    request,
    connectionState: async () => ({ status: "connected", plxd: "", protocol: 1, capabilities: {} }),
    onConnectionState: () => () => {},
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
  expect(document.querySelector('input[aria-label="File name"]')).toBeNull();

  await click(button("New folder"));
  request.mockClear();
  await type("  ", "Enter");
  expect(document.querySelector('input[aria-label="Folder name"]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="treeitem"] button')].find(
    (b) => b.textContent === name,
  );
/** The view with its tabs as the side panel draws them, in front. */
const withTabs = (panel: ReactNode) => (
  <>
    <ul aria-label="Open views">
      <FileTabs
        store={openFilesOf("local", "run-1")}
        id="side-panel-tab-F"
        current
        show={() => {}}
        close={() => {}}
        icon={Folder}
      />
    </ul>
    {panel}
  </>
);
const tabButtons = () =>
  [...document.querySelectorAll<HTMLElement>('ul[aria-label="Open views"] button[title]')].filter(
    (b) => !b.title.startsWith("Close"),
  );
const openTabs = () => tabButtons().map((t) => t.textContent);
const shownTab = () =>
  tabButtons().find((b) => b.getAttribute("aria-current") === "true")?.textContent;
const filesTab = () => document.getElementById("side-panel-tab-F");

test("a click opens a preview tab that the next click replaces, and a double-click keeps it", async () => {
  await render(withTabs(<FilesPanel hostId="local" runId="run-1" writable />));
  await click(row("README.md"));
  await vi.dynamicImportSettled();
  await settle();
  expect(openTabs()).toEqual(["README.md"]);
  expect(document.querySelector('[data-testid="editor"]')?.textContent).toBe("README.md");

  // Narrow, the Files tab shows the tree, and a file's tab the file.
  expect(row("src")).toBeUndefined();
  await click(filesTab());
  await click(row("src"));
  await click(row("main.rs"));
  expect(openTabs()).toEqual(["main.rs"]);

  await click(filesTab());
  const readme = row("README.md")!;
  await act(async () => readme.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await settle();
  expect(openTabs()).toEqual(["main.rs", "README.md"]);
  expect(shownTab()).toBe("README.md");

  await click(button("Close README.md"));
  await settle();
  expect(openTabs()).toEqual(["main.rs"]);
  expect(shownTab()).toBe("main.rs");
});

test("a file renamed in the tree stays open under its new name", async () => {
  await render(withTabs(<FilesPanel hostId="local" runId="run-1" editable writable />));
  await click(row("README.md"));
  await click(filesTab());
  await click(button("Actions for README.md"));
  await click(menuItem("Rename"));
  await type("INTRO.md", "Enter");
  expect(request).toHaveBeenCalledWith("local", "agent/fileRename", {
    runId: "run-1",
    from: "README.md",
    to: "INTRO.md",
  });
  expect(openTabs()).toEqual(["INTRO.md"]);
});

test("a command menu reveal opens its file once, and coming back doesn't open it again", async () => {
  const reveal = { path: "src/main.rs" };
  await render(withTabs(<FilesPanel hostId="local" runId="run-1" reveal={reveal} />));
  expect(openTabs()).toEqual(["main.rs"]);
  expect(request).toHaveBeenCalledWith("local", "agent/files", { runId: "run-1", path: "src" });
  await click(button("Close main.rs"));
  unmount();
  await render(withTabs(<FilesPanel hostId="local" runId="run-1" reveal={reveal} />));
  expect(openTabs()).toEqual([]);
});

test("a search finds files anywhere in the folder and opens one", async () => {
  request.mockImplementationOnce(async () => ({
    logId: "log-1",
    result: { entries: folders[""], truncated: false },
  }));
  await render(withTabs(<FilesPanel hostId="local" runId="run-1" />));
  request.mockImplementationOnce(
    async () =>
      ({
        logId: "log-1",
        result: { files: ["README.md", "src/main.rs"], truncated: false },
      }) as never,
  );
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  await act(async () => input.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "main");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const found = [...document.querySelectorAll('[aria-label="Search results"] button')];
  expect(found.map((b) => b.getAttribute("title"))).toEqual(["src/main.rs"]);
  await click(found[0]);
  expect(openTabs()).toEqual(["main.rs"]);
});

test("closing a tab whose edits can't land brings the Files view to the front to ask", async () => {
  const store = openFilesOf("local", "run-1");
  store.writable = true;
  const id = store.open("README.md");
  const show = vi.fn();
  await render(
    <ul aria-label="Open views">
      <FileTabs
        store={store}
        id="side-panel-tab-F"
        current={false}
        show={show}
        close={() => {}}
        icon={Folder}
      />
    </ul>,
  );
  request.mockImplementationOnce(
    async () => ({ logId: "log-1", error: { code: -32603, message: "disk full" } }) as never,
  );
  store.edited(id, () => "mine\n");
  await act(() => store.askClose(id));
  await settle();
  expect(store.get().closing).toBe(id);
  expect(show).toHaveBeenCalled();
});
