// @vitest-environment happy-dom
import { closeHistory } from "@tiptap/pm/history";
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, onTestFinished, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import type { AgentRun, PromptImage } from "../protocol/generated/protocol";
import { Composer, type ComposerProps } from "./Composer";
import type { ImageCaps } from "./images";
import { Notifications } from "./notifications";
import { behaviorDefaults, newThreadDefaults, newThreadPrefs, setBehaviorPrefs } from "./prefs";
import type { AttachThreads } from "./threadContext";
import { dragThread } from "./threadDrag";
import { emptyThreads } from "./threads";

vi.mock("./voiceEngine", () => ({
  loadVoiceEngine: () => new Promise(() => {}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The model menu's items are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};
// The notifications, outside the body, which a test's unmount clears.
const notices = document.documentElement.appendChild(document.createElement("div"));
createRoot(notices).render(<Notifications />);
// happy-dom decodes no images. Every image is small enough to send as it is.
vi.stubGlobal("createImageBitmap", async () => ({ width: 64, height: 48, close() {} }));
// The composer's image reads, so a test can wait for them: happy-dom reads a file on two chained
// timers, which a fixed wait races when the event loop stalls (PLX-277).
const reads = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock(import("./images"), async (importOriginal) => {
  const images = await importOriginal();
  return {
    ...images,
    readImage: (...args) => {
      const read = images.readImage(...args);
      reads.push(read);
      return read;
    },
  };
});

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of notices.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  act(() => unmount());
  newThreadPrefs.set(newThreadDefaults);
  setBehaviorPrefs(behaviorDefaults);
  vi.useRealTimers();
});

// plxd's caps (PLX-191).
const caps: ImageCaps = { maxImages: 10, maxImageBytes: 5_242_880, maxTotalBytes: 6_291_456 };

function render(
  onSend: (text: string) => Promise<string | undefined>,
  // null: a plxd that takes no images.
  imageCaps: ImageCaps | null = caps,
  props: Partial<ComposerProps> = {},
) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(<Composer onSend={onSend} imageCaps={imageCaps ?? undefined} {...props} />),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  const box = document.querySelector<TiptapEditorHTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  )!;
  // Types as a keyboard does, a character at a time through the editor's input handling (where
  // its Markdown shortcuts live). Tiptap keeps the editor on its element for tests.
  const type = (text: string) =>
    act(() => {
      const { view } = box.editor!;
      for (const char of text) {
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(char, from, to);
        if (!view.someProp("handleTextInput", (f) => f(view, from, to, char, insert)))
          view.dispatch(insert());
      }
    });
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    });
  // Pastes a clipboard with these files, and text of these types, then waits for the files to
  // be read.
  const paste = async (files: File[], text: Record<string, string> = {}) => {
    const data = new DataTransfer();
    for (const [format, value] of Object.entries(text)) data.setData(format, value);
    for (const file of files) data.items.add(file);
    act(() => {
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await read();
  };
  // Renders it again with `more` over its props, as a screen does when they change.
  const rerender = (more: Partial<ComposerProps>) =>
    act(() =>
      root.render(
        <Composer onSend={onSend} imageCaps={imageCaps ?? undefined} {...props} {...more} />,
      ),
    );
  return { box, type, press, paste, rerender };
}

// Waits for the added files to be read and shown.
const read = () => act(() => Promise.all(reads.splice(0)));

// A 1×1 PNG, and what's sent for it.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngFile = (name = "image.png") =>
  new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], name, { type: "image/png" });
const sentPng: PromptImage = { mediaType: "image/png", data: png };
const thumbnails = () =>
  [...document.querySelectorAll(".composer-shell fieldset img")].map((img) =>
    img.getAttribute("alt"),
  );
/** The text's chips, as they read. */
const chipsIn = (box: Element) =>
  [...box.querySelectorAll("[data-node-view-wrapper]")].map((c) => c.textContent);

test("Markdown formats as you type and is sent as Markdown, with the text as typed", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press } = render(onSend);
  type("Two things:");
  await press("Enter", { shiftKey: true });
  type("- ");
  type("first");
  await press("Enter", { shiftKey: true });
  type("second");
  // Shift+Enter on an empty item leaves the list.
  await press("Enter", { shiftKey: true });
  await press("Enter", { shiftKey: true });
  type("rename foo_bar in <div>, **all** of it");
  await press("Enter", { shiftKey: true });
  type("thanks");

  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(
    "Two things:\n\n- first\n- second\n\nrename foo_bar in <div>, **all** of it\nthanks",
    {},
    [],
    [],
  );
  expect(box.textContent).toBe("");
});

test("recording takes the box's focus without stepping it back, so it keeps its height under the pill", async () => {
  // Without motion, the pill takes its end state at once.
  document.documentElement.classList.add("reduce-motion");
  onTestFinished(() => document.documentElement.classList.remove("reduce-motion"));
  const { box } = render(async () => undefined, caps, { away: true });
  const shell = box.closest<HTMLElement>(".composer-shell")!;
  await act(async () => box.focus());
  expect(shell.dataset["back"]).toBeUndefined();
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Voice input"]')!.click());
  // As `inert` does when the pill takes over.
  await act(async () => box.blur());
  expect(shell.inert).toBe(true);
  expect(shell.dataset["back"]).toBeUndefined();
});

test("a footer search cannot implicitly send the draft, while Send still can", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type } = render(onSend, caps, { tab: <input aria-label="Search refs" /> });
  type("Keep this draft");
  // A browser's default Enter in a search submits the form it's in, so the box must not be one.
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search refs"]')!;
  expect(search.form).toBeNull();
  expect(onSend).not.toHaveBeenCalled();
  expect(box.textContent).toBe("Keep this draft");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(onSend).toHaveBeenCalledWith("Keep this draft", {}, [], []);
});

test("cited agent text is sent as a quote and its comment, a paragraph apart from what's typed", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press, rerender } = render(onSend);
  type("See this:");
  rerender({
    cite: { quote: "The tab reports itself as hidden.\n\nIt stays throttled.", comment: "Why?" },
  });
  await settle();
  expect(chipsIn(box)).toEqual(["Why?"]);
  type("Fix it");
  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(
    "See this:\n\n> The tab reports itself as hidden.\n>\n> It stays throttled.\n\nWhy?\n\nFix it",
    expect.anything(),
    [],
    [],
  );
});

test("typed text that only looks like Markdown is sent as typed", async () => {
  const onSend = vi.fn(async () => undefined);
  const { type, press } = render(onSend);
  type("rename __init__ and _private_, then a * b * c");
  await press("Enter", { shiftKey: true });
  type("--- a/file.ts");
  await press("Enter", { shiftKey: true });
  type("[] is empty, and a ~~ b ~~ c");

  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(
    "rename __init__ and _private_, then a * b * c\n--- a/file.ts\n[] is empty, and a ~~ b ~~ c",
    {},
    [],
    [],
  );
});

test("a failed send puts the same text and images back, ahead of anything added meanwhile", async () => {
  let fail = (_error: string) => {};
  const onSend = vi.fn(
    (_text: string) => new Promise<string | undefined>((resolve) => (fail = resolve)),
  );
  const { box, type, press, paste } = render(onSend);
  type("- ");
  type("first");
  await paste([new File([Uint8Array.of(0x47, 0x49, 0x46)], "a.gif", { type: "image/gif" })]);
  await press("Enter");
  expect(thumbnails()).toEqual([]);
  type("more");
  await paste(Array.from({ length: 10 }, () => pngFile()));
  await act(async () => fail("plxd is busy"));
  // Still at most 10: the one sent, then the first nine added meanwhile. The tenth's place in the
  // text names nothing.
  expect(thumbnails()).toHaveLength(10);
  expect(chipsIn(box).at(-1)).toBe("Removed image");

  await press("Enter");
  const gif = { mediaType: "image/gif", data: "R0lG" };
  const names = Array.from({ length: 9 }, (_, i) => `[Image ${i + 2}] `).join("");
  expect(onSend).toHaveBeenLastCalledWith(
    // The tenth's place names nothing.
    `- first[Image 1] \n\nmore${names.trimEnd()}`,
    {},
    [gif, ...Array<PromptImage>(9).fill(sentPng)],
    [],
  );
});

test("an image plxd can't take isn't added, past 10 images included", async () => {
  const { paste } = render(vi.fn(async () => undefined));
  await paste([new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })]);
  expect(thumbnails()).toEqual([]);
  await paste(Array.from({ length: 11 }, () => pngFile()));
  expect(thumbnails()).toHaveLength(10);
});

test("an image chip's X removes the image and its chip", async () => {
  const { box, paste } = render(vi.fn(async () => undefined));
  await paste([pngFile(), pngFile()]);
  expect(chipsIn(box)).toEqual(["Image 172 bytes", "Image 272 bytes"]);
  act(() => box.querySelector<HTMLButtonElement>('button[aria-label="Remove image 1"]')!.click());
  expect(thumbnails()).toEqual(["Image 1"]);
  expect(chipsIn(box)).toEqual(["Image 172 bytes"]);
});

test("with fileUploads, a file goes to the host and the message lists its path (PLX-779)", async () => {
  const upload = vi.fn(async (_host: string, _method: string, params: { name: string }) => ({
    logId: "log-1",
    result: { path: `/host/uploads/1/${params.name}` },
  }));
  window.parallax = {
    platform: "darwin",
    request: upload,
    // `hostId` also reads the host's catalog, which stays unknown here.
    onConnectionState: () => () => {},
    connectionState: () => new Promise(() => {}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const onSend = vi.fn(async () => undefined);
  const { paste, press } = render(onSend, caps, {
    hostId: "local",
    uploadBytes: { maxBytes: 6 },
  });
  await paste([
    new File(["%PDF-"], "paper.pdf", { type: "application/pdf" }),
    new File(["1234567"], "big.bin"),
  ]);
  // Over the host's cap, so it isn't added.
  expect(document.querySelector('[aria-label="Remove big.bin"]')).toBeNull();

  // A file alone is enough to send.
  await press("Enter");
  await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
  expect(upload).toHaveBeenCalledWith("local", "host/upload", {
    name: "paper.pdf",
    data: "JVBERi0=",
  });
  expect(onSend).toHaveBeenCalledWith("Attached files:\n- /host/uploads/1/paper.pdf", {}, [], []);
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Remove paper.pdf"]')).toBeNull(),
  );
});

test("for a Claude Remote Control thread, images are refused and a text file goes inside the message (PLX-1140)", async () => {
  const request = vi.fn();
  window.parallax = {
    platform: "darwin",
    request,
    onConnectionState: () => () => {},
    connectionState: () => new Promise(() => {}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const onSend = vi.fn(async () => undefined);
  const { paste, type, press } = render(onSend, caps, {
    hostId: "local",
    uploadBytes: { maxBytes: 1024 },
    inlineFiles: true,
  });
  await paste([
    pngFile(),
    new File(["# Notes"], "notes.md", { type: "text/markdown" }),
    new File([new Uint8Array([0, 1, 2])], "data.bin"),
  ]);
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Remove notes.md"]')).not.toBeNull(),
  );
  expect(thumbnails()).toEqual([]);
  expect(document.querySelector('[aria-label="Remove data.bin"]')).toBeNull();
  expect(notices.textContent).toContain("takes text only, so images can't be sent to it");

  type("Read this");
  await press("Enter");
  await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
  expect(onSend).toHaveBeenCalledWith("Read this\n\nnotes.md:\n```\n# Notes\n```", {}, [], []);
  // Nothing is saved on the host.
  expect(request).not.toHaveBeenCalledWith("local", "host/upload", expect.anything());
});

test("with fileChunks, a file goes in pieces, each answered before the next (PLX-835)", async () => {
  // Each piece waits to be answered, so the chip shows mid-upload.
  const answers: (() => void)[] = [];
  const upload = vi.fn(
    (_host: string, _method: string, params: { name: string; offset?: number; last?: boolean }) =>
      new Promise((resolve) =>
        answers.push(() =>
          resolve({ logId: "l", result: { path: `/up/u1/${params.name}`, uploadId: "u1" } }),
        ),
      ),
  );
  window.parallax = {
    platform: "darwin",
    request: upload,
    onConnectionState: () => () => {},
    connectionState: () => new Promise(() => {}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const onSend = vi.fn(async () => undefined);
  const { paste, press } = render(onSend, caps, {
    hostId: "local",
    uploadBytes: { maxBytes: 1024, chunkBytes: 2 },
  });
  await paste([new File(["%PDF-"], "paper.pdf", { type: "application/pdf" })]);
  await press("Enter");
  for (let i = 0; i < 3; i++) {
    await vi.waitFor(() => expect(answers).toHaveLength(i + 1));
    await act(async () => answers[i]!());
  }
  await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
  expect(onSend).toHaveBeenCalledWith("Attached files:\n- /up/u1/paper.pdf", {}, [], []);
  expect(upload.mock.calls.map(([, , p]) => [p.offset, p.last])).toEqual([
    [0, false],
    [2, false],
    [4, true],
  ]);
});

test("an image chip has no X while files upload: what's there is what's sent", async () => {
  // The upload never answers, so the message stays mid-upload.
  const upload = vi.fn(() => new Promise(() => {}));
  window.parallax = {
    platform: "darwin",
    request: upload,
    onConnectionState: () => () => {},
    connectionState: () => new Promise(() => {}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const { box, paste, press } = render(
    vi.fn(async () => undefined),
    caps,
    {
      hostId: "local",
      uploadBytes: { maxBytes: 1024 },
    },
  );
  await paste([pngFile()]);
  expect(box.querySelector('button[aria-label="Remove image 1"]')).not.toBeNull();
  await press("Enter");
  await vi.waitFor(() => expect(upload).toHaveBeenCalled());
  expect(box.querySelector('button[aria-label="Remove image 1"]')).toBeNull();
});

test("a piece that fails three times keeps the message unsent (PLX-835)", async () => {
  const upload = vi.fn(async (_host: string, _method: string, params: { offset?: number }) =>
    params.offset === 0
      ? { logId: "l", result: { path: "/up/u1/paper.pdf", uploadId: "u1" } }
      : { error: { code: -32603, message: "timed out" } },
  );
  window.parallax = {
    platform: "darwin",
    request: upload,
    onConnectionState: () => () => {},
    // A host that can't reconnect, so the retries go at once.
    connectionState: async () => ({ status: "failed", retrying: false }) as ConnectionState,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const onSend = vi.fn(async () => undefined);
  const { paste, press } = render(onSend, caps, {
    hostId: "local",
    uploadBytes: { maxBytes: 1024, chunkBytes: 2 },
  });
  await paste([new File(["%PDF-"], "paper.pdf", { type: "application/pdf" })]);
  await press("Enter");
  // The first piece, then the second and its two retries.
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
  expect(onSend).not.toHaveBeenCalled();
});

// plxd's lists for the `@` menu (PLX-359).
const request = vi.fn(async (_host: string, method: string, _params?: unknown) =>
  method === "thread/search"
    ? { logId: "log-1", result: { threads: [{ id: "t-flaky" }, { id: "t-docs" }] } }
    : { logId: "log-1", result: { files: ["README.md"], truncated: false } },
);
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};
// Each test gets its own run, so nothing the composer keeps per run carries over.
let runs = 0;
const withMenus = async (
  onSend: (text: string) => Promise<string | undefined>,
  props: Partial<ComposerProps> = {},
) => {
  request.mockClear();
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
  const runId = `run-${++runs}`;
  const composer = render(onSend, caps, {
    backend: "claude",
    menus: { hostId: "local", runId },
    ...props,
  });
  await settle();
  // Typing settles too, for the lists fetched on the first `/` or `@`.
  const type = async (text: string) => {
    composer.type(text);
    await settle();
  };
  return { ...composer, type, runId };
};

// The host's threads, for attaching (PLX-378): the open one, and three others on two providers.
const hostThreads = (self: string, max = 8): AttachThreads => {
  const thread = (id: string, lastPromptAt: string) => ({
    id,
    repo: "r",
    createdAt: lastPromptAt,
    lastPromptAt,
  });
  const run = (id: string, backend: string) => ({ id, backend }) as AgentRun;
  return {
    hostId: "local",
    state: {
      ...emptyThreads,
      threads: [
        thread("t-flaky", "2026-10-01T10:00:00Z"),
        thread("t-docs", "2026-10-03T10:00:00Z"),
        thread(self, "2026-10-03T11:00:00Z"),
        thread("t-ci", "2026-10-02T10:00:00Z"),
      ],
      titles: {
        "t-flaky": "Fix the flaky test",
        "t-docs": "Write the docs",
        "t-ci": "Speed up CI",
      },
      runs: { "t-flaky": run("t-flaky", "codex"), "t-docs": run("t-docs", "claude") },
    },
    open: vi.fn(),
    max,
    self,
  };
};
const chips = () =>
  [...document.querySelectorAll('.composer-shell [data-chip="threadRef"]')].map(
    (c) => c.textContent,
  );

test("a failed send puts its threads back within the cap, and another computer's can't be undone back", async () => {
  let fail = (_error: string) => {};
  const onSend = vi.fn(() => new Promise<string | undefined>((resolve) => (fail = resolve)));
  const { type, press, rerender, box } = await withMenus(onSend, {
    attach: hostThreads("run-self", 2),
  });
  await drop("local", "t-flaky");
  await drop("local", "t-docs");
  await press("Enter");
  // One more while it's in flight, past the cap once the sent ones come back.
  await drop("local", "t-ci");
  await act(async () => fail("plxd is busy"));
  await settle();
  expect(chips()).toEqual(["Fix the flaky test", "Write the docs"]);

  // On another computer the chips go, and none undo brings back is sent there.
  Object.assign(window.parallax, {
    onConnectionState: () => () => {},
    connectionState: async () => ({ status: "disconnected" }),
  });
  const other = { ...hostThreads("run-other"), hostId: "ssh-box" };
  act(() => box.editor!.view.dispatch(closeHistory(box.editor!.state.tr)));
  rerender({ hostId: "ssh-box", attach: other });
  await settle();
  expect(chips()).toEqual([]);
  act(() => void box.editor!.commands.undo());
  await settle();
  box.editor!.commands.focus("end");
  onSend.mockClear();
  await type(" go");
  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(expect.any(String), expect.anything(), [], []);
});

test("a pasted image chip only brings an image of a type plxd takes", async () => {
  const { box, paste } = render(vi.fn(async () => undefined));
  const svg = `data:image/svg+xml;base64,${btoa("<svg/>")}`;
  await paste([], {
    "text/plain": "[Image 1]",
    "text/html": `<p data-pm-slice="1 1 []"><span data-plx-chip="imageRef" data-imageref="" data-key="x" data-src="${svg}"></span></p>`,
  });
  await settle();
  expect(thumbnails()).toEqual([]);
  expect(chipsIn(box)).toEqual(["Removed image"]);
});

// Drops a sidebar row's drag of thread `runId` on host `hostId` on the composer.
const drop = async (hostId: string, runId: string) => {
  const data = new DataTransfer();
  dragThread(data, hostId, runId);
  // happy-dom's DragEvent takes no dataTransfer.
  const event = (type: string) =>
    Object.defineProperty(new Event(type, { bubbles: true }), "dataTransfer", { value: data });
  const form = document.querySelector(".composer-shell")!;
  act(() => {
    form.dispatchEvent(event("dragover"));
    form.dispatchEvent(event("drop"));
  });
  // A chip's view draws a moment after it's put in.
  await settle();
};

test("a sidebar row dropped on the box attaches its thread once, but not another computer's, the open one, or past the cap (PLX-378)", async () => {
  const onSend = vi.fn(async () => undefined);
  const { type, press } = await withMenus(onSend, { attach: hostThreads("run-self", 2) });
  await drop("local", "t-flaky");
  await drop("local", "t-flaky");
  await drop("local", "run-self");
  expect(chips()).toHaveLength(1);
  expect(chips()[0]).toContain("Fix the flaky test");

  await drop("ssh-box", "t-docs");
  expect(chips()).toHaveLength(1);
  await drop("local", "t-docs");
  await drop("local", "t-ci");
  expect(chips()).toHaveLength(2);

  await type("compare these");
  await press("Enter");
  // Dropped outside the text, each lands at its end, and the text names them where they are.
  expect(onSend).toHaveBeenCalledWith(
    '@"Fix the flaky test" @"Write the docs" compare these',
    expect.anything(),
    [],
    ["t-flaky", "t-docs"],
  );
  act(() => unmount());

  // Without the capability, neither a drop nor `@` attaches anything.
  const without = await withMenus(onSend);
  await drop("local", "t-flaky");
  await without.type("@flaky");
  expect(chips()).toEqual([]);
  expect(request).not.toHaveBeenCalledWith("local", "thread/search", expect.anything());
});

test("scrolled up from the end, an empty box steps back until it's focused or holds text", async () => {
  const { box, type, rerender } = render(async () => undefined, caps, { away: true });
  const form = () => box.closest<HTMLElement>(".composer-shell")!;
  expect(form().dataset["back"]).toBe("true");
  // A press on Attach focuses it, which leaves the box stepped back so the click lands.
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!.focus());
  expect(form().dataset["back"]).toBe("true");
  act(() => box.focus());
  expect(form().dataset["back"]).toBeUndefined();
  type("Draft");
  act(() => box.blur());
  expect(form().dataset["back"]).toBeUndefined();
  rerender({ away: false });
  expect(form().dataset["back"]).toBeUndefined();
});
