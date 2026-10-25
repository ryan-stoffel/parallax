// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { MarkdownText } from "./AgentChat";
import "./markdownTest";
import type { DocRef } from "./documents";
import { OpenDocumentContext } from "./FileCards";
import { FileImage, FileLink, FileRunContext, inFolder, linkedPath } from "./FileLink";
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

// plxd's agent/files, naming the thread's folder, and agent/file, reading a 4-byte file.
const request = vi.fn(async (_host: string, method: string) =>
  method === "agent/file"
    ? {
        logId: "l",
        result: {
          path: "",
          side: "working",
          exists: true,
          size: 4,
          tooLarge: false,
          content: "AAAA",
        },
      }
    : { logId: "l", result: { entries: [], truncated: false, folder: "/home/me/repo" } },
);
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

test("a link opens a relative file in the side panel, read on the thread's host", async () => {
  await click("out/notes.csv");
  expect(open).toHaveBeenCalledWith({
    runId: "run-1",
    path: "out/notes.csv",
    name: "notes.csv",
    kind: "file",
  });
  // A relative path needs no folder.
  expect(request).not.toHaveBeenCalled();
});

test("an absolute link is checked against the folder agent/files names", async () => {
  await click("/home/me/repo/shots/home.png");
  expect(request).toHaveBeenCalledWith("box", "agent/files", { runId: "run-1" });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ path: "shots/home.png", name: "home.png", kind: "png" }),
  );
  act(() => unmount());

  await click("/etc/passwd");
  expect(open).toHaveBeenCalledTimes(1);
  const notice = document.querySelector('[aria-label="Notifications"] > div')!;
  expect(notice.querySelector("p")!.textContent).toBe(
    "This file is outside the thread's folder, so it can't be opened here.",
  );
});

test("a Markdown image of a file in the folder opens in the Lightbox, not the side panel (PLX-998)", async () => {
  URL.createObjectURL = () => "blob:home";
  URL.revokeObjectURL = () => {};
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // Linked to its file too, as `[![Home](shots/home.png)](shots/home.png)` is.
  act(() =>
    root.render(
      <FileRunContext value={{ hostId: "box", runId: "run-1" }}>
        <OpenDocumentContext value={open}>
          <p>
            <FileLink path="shots/home.png">
              <FileImage path="shots/home.png" alt="Home" />
            </FileLink>
          </p>
        </OpenDocumentContext>
      </FileRunContext>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  for (let i = 0; i < 5; i++) await act(async () => {});
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open home.png"]')!.click());
  const dialog = document.querySelector("dialog")!;
  expect(dialog.querySelector("img")!.getAttribute("src")).toBe("blob:home");
  expect(dialog.textContent).toContain("home.png");
  // On the body, outside the paragraph.
  expect(dialog.closest("p")).toBeNull();
  // A click in it never reaches the link.
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(open).not.toHaveBeenCalled();
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

test("a message draws in its first render, so a list measures it at its height", () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<MarkdownText text={"# Title\n\nA paragraph with **bold**."} />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  expect(document.querySelector("h1")?.textContent).toBe("Title");
  expect(document.querySelector("strong")?.textContent).toBe("bold");
});

test("a link opens only as a file or an https page, never another scheme", () => {
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  message("[run](javascript:alert(1)) [docs](https://example.com) [app](vscode://x)");
  for (const a of document.querySelectorAll("a")) act(() => a.click());
  expect(opened.mock.calls.map((c) => c[0])).toEqual(["https://example.com"]);
  opened.mockRestore();
});

test("a file's image shows as a block of its own, and is a link inside text", () => {
  message(
    "Here's the screenshot:\n![shot](out/a.png)\nSee ![b](out/b.png) here\n- item\n\n  ![c](out/c.png)",
  );
  // The one on its own line is FileImage, a link to its file while it reads it; the one in text and
  // the one in a list are links, never images with no source.
  expect(document.querySelectorAll("img")).toHaveLength(0);
  const links = [...document.querySelectorAll("a")];
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["shot", "#"],
    ["b", "out/b.png"],
    ["c", "out/c.png"],
  ]);
});

test("inline code naming a file opens it without its line; other code stays code", async () => {
  message("See `out/notes.csv:3`, then run `npm test`.\n\n```\nout/a.txt\n```");
  const links = [...document.querySelectorAll("a")];
  expect(links.map((a) => a.textContent)).toEqual(["out/notes.csv:3"]);
  expect(links[0]!.querySelector("code")).not.toBeNull();
  await act(async () => links[0]!.click());
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: "out/notes.csv" }));
});

test("a file path in a link's text stays the link's, and outside a thread stays code", async () => {
  message("[`src/App.tsx`](https://github.com/o/r/blob/main/src/App.tsx)");
  const links = [...document.querySelectorAll("a")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual([
    "https://github.com/o/r/blob/main/src/App.tsx",
  ]);
  act(() => unmount());

  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<MarkdownText text="See `src/App.tsx`." />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  expect(document.querySelector("code")?.textContent).toBe("src/App.tsx");
  expect(document.querySelector("a")).toBeNull();
});

test("a GitHub alert shows its kind over the quote, and a plain quote stays a quote", async () => {
  message("> [!WARNING]\n> Back up first.\n\n> Just a quote.");
  const alert = document.querySelector(".enrm-admonition")!;
  expect(alert.textContent).toBe("WarningBack up first.");
  expect(alert.querySelector("svg")!.getAttribute("fill")).toBe("var(--warning)");
  expect(document.querySelector("blockquote")!.textContent).toBe("Just a quote.");
});
