// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { MarkdownText } from "./AgentChat";
import "./markdownTest";
import type { DocRef } from "./documents";
import { OpenDocumentContext } from "./FileCards";
import { FileLink, FileRunContext, inFolder, linkedPath } from "./FileLink";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};

test("only paths and file: URLs name files; every other scheme stays a web link", () => {
  for (const href of [
    undefined,
    "",
    "https://example.com/a.png",
    "http://localhost:5173",
    "mailto:a@b.c",
    "javascript:alert(1)",
    "#usage",
    "//cdn.example.com/a.png",
  ])
    expect(linkedPath(href)).toBeUndefined();

  expect(linkedPath("out/report.pdf")).toBe("out/report.pdf");
  // Markdown percent-encodes the destination; a query or fragment isn't part of the file.
  expect(linkedPath("./my%20shot.png?raw=1#L4")).toBe("./my shot.png");
  expect(linkedPath("/Users/me/repo/out/a.pdf")).toBe("/Users/me/repo/out/a.pdf");
  expect(linkedPath("file:///Users/me/repo/a%20b.txt")).toBe("/Users/me/repo/a b.txt");
  expect(linkedPath("file://localhost/srv/repo/a.txt")).toBe("/srv/repo/a.txt");
  // Another computer's share, which no folder holds.
  expect(linkedPath("file://server/share/a.txt")).toBe("//server/share/a.txt");
  // A Windows host's paths, as a file: URL and as written, which Markdown encodes.
  expect(linkedPath("file:///C:/repo/a.txt")).toBe("C:/repo/a.txt");
  expect(linkedPath("C:%5Crepo%5Cout%5Ca.txt")).toBe("C:/repo/out/a.txt");
  expect(linkedPath("100%.txt")).toBe("100%.txt");
});

test("a linked path reads from the thread's folder, and never from outside it", () => {
  expect(inFolder("out/a.pdf")).toBe("out/a.pdf");
  expect(inFolder("./out/../a.pdf")).toBe("a.pdf");
  expect(inFolder("/repo/out/a.pdf", "/repo")).toBe("out/a.pdf");
  expect(inFolder("/repo/out/a.pdf", "/repo/")).toBe("out/a.pdf");
  expect(inFolder("C:/w/repo/a.txt", "C:\\w\\repo")).toBe("a.txt");
  for (const [path, folder] of [
    ["../secret.txt"],
    ["a/../../b.txt"],
    ["/repo/../etc/passwd", "/repo"],
    ["/repository/a.txt", "/repo"],
    ["/etc/passwd", "/repo"],
    ["//server/share/a.txt", "/repo"],
    // An older plxd names no folder, so no absolute path is known to be in it.
    ["/repo/a.txt"],
    ["~/.ssh/id_rsa", "/repo"],
    [".", "/repo"],
    ["/repo", "/repo"],
  ])
    expect(inFolder(path!, folder)).toBeUndefined();
});

// plxd's agent/files, naming the thread's folder.
const request = vi.fn(async () => ({
  logId: "l",
  result: { entries: [], truncated: false, folder: "/home/me/repo" },
}));
const open = vi.fn<(doc: DocRef) => void>();
let unmount = () => {};
beforeEach(() => {
  request.mockClear();
  open.mockClear();
  window.parallax = {
    request,
    connectionState: async () => ({ status: "connected", plxd: "", protocol: 1, capabilities: {} }),
  } as Partial<ParallaxBridge> as ParallaxBridge;
});
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
});

async function click(path: string) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <FileRunContext value={{ hostId: "box", runId: "run-1" }}>
        <OpenDocumentContext value={open}>
          <FileLink path={path}>the file</FileLink>
        </OpenDocumentContext>
        <Notifications />
      </FileRunContext>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await act(async () => document.querySelector("a")!.click());
  for (let i = 0; i < 5; i++) await act(async () => {});
}

test("an absolute link is checked against the folder agent/files names", async () => {
  await click("/home/me/repo/shots/home.png");
  expect(request).toHaveBeenCalledWith("box", "agent/files", { runId: "run-1" });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ path: "shots/home.png", name: "home.png", kind: "png" }),
  );
  act(() => unmount());

  await click("/etc/passwd");
  expect(open).toHaveBeenCalledTimes(1);
});

/** Renders `text` as a transcript's agent message does, in thread run-1 on host box. */
function message(text: string) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <FileRunContext value={{ hostId: "box", runId: "run-1" }}>
        <OpenDocumentContext value={open}>
          <MarkdownText text={text} />
        </OpenDocumentContext>
      </FileRunContext>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
}

test("a link opens only as a file or an https page, never another scheme", () => {
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  message("[run](javascript:alert(1)) [docs](https://example.com) [app](vscode://x)");
  for (const a of document.querySelectorAll("a")) act(() => a.click());
  expect(opened.mock.calls.map((c) => c[0])).toEqual(["https://example.com"]);
  opened.mockRestore();
});
