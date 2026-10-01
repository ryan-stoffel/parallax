// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { PromptImage } from "../protocol/generated/protocol";
import { Composer } from "./Composer";
import type { ImageCaps } from "./images";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom decodes no images. Every image is small enough to send as it is.
vi.stubGlobal("createImageBitmap", async () => ({ width: 64, height: 48, close() {} }));

let unmount = () => {};
afterEach(() => act(() => unmount()));

// wispd's caps (RYA-191).
const caps: ImageCaps = { maxImages: 10, maxImageBytes: 5_242_880, maxTotalBytes: 6_291_456 };

function render(
  onSend: (text: string) => Promise<string | undefined>,
  // null: a wispd that takes no images.
  imageCaps: ImageCaps | null = caps,
) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Composer onSend={onSend} imageCaps={imageCaps ?? undefined} />));
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
  return { box, type, press, paste };
}

// Waits out reading the added files, which happy-dom does on a timer.
const read = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

// A 1×1 PNG, and what's sent for it.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngFile = (name = "image.png") =>
  new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], name, { type: "image/png" });
const sentPng: PromptImage = { mediaType: "image/png", data: png };
const thumbnails = () =>
  [...document.querySelectorAll("form img")].map((img) => img.getAttribute("alt"));
const alert = () => document.querySelector('[role="alert"]')?.textContent;

test("Manual says its requests are denied when they can't come to the chat, and why (RYA-196)", () => {
  const manual = () =>
    [
      ...document.querySelectorAll('[role="menu"][aria-label="Access"] [role="menuitemradio"]'),
    ].find((o) => o.textContent?.startsWith("Manual"))!.textContent;
  const shown = (manualDenied?: "host" | "run") => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root.render(<Composer backend="claude" manualDenied={manualDenied} />));
    const text = manual();
    act(() => root.unmount());
    document.body.innerHTML = "";
    return text;
  };
  expect(shown()).toBe("ManualAsks you before edits and commands.");
  expect(shown("host")).toBe(
    "ManualAsks before edits and commands. This host's wispd can't show those requests, so they're denied.",
  );
  expect(shown("run")).toBe(
    "ManualAsks before edits and commands. This chat started before wisp could show those requests, so they're denied.",
  );
});

test("Markdown formats as you type and is sent as Markdown, with the text as typed", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press } = render(onSend);
  type("Two things:");
  await press("Enter", { shiftKey: true });
  type("- ");
  type("first");
  await press("Enter", { shiftKey: true });
  type("second");
  expect([...box.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual([
    "first",
    "second",
  ]);
  // Shift+Enter on an empty item leaves the list.
  await press("Enter", { shiftKey: true });
  await press("Enter", { shiftKey: true });
  type("rename foo_bar in <div>, **all** of it");
  expect(box.querySelector("strong")?.textContent).toBe("all");
  await press("Enter", { shiftKey: true });
  type("thanks");

  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(
    "Two things:\n\n- first\n- second\n\nrename foo_bar in <div>, **all** of it\nthanks",
    {},
    [],
  );
  expect(box.textContent).toBe("");
});

test("typed text that only looks like Markdown is sent as typed", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press } = render(onSend);
  type("rename __init__ and _private_, then a * b * c");
  await press("Enter", { shiftKey: true });
  type("--- a/file.ts");
  expect(box.querySelector("strong, em, hr")).toBeNull();

  await press("Enter");
  expect(onSend).toHaveBeenCalledWith(
    "rename __init__ and _private_, then a * b * c\n--- a/file.ts",
    {},
    [],
  );
});

test("an ordered list's nested lines indent past its widest number", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, press } = render(onSend);
  act(() => {
    box.editor!.commands.setContent(
      '<ol start="9"><li><p>a</p></li><li><p>b</p><ul><li><p>c</p></li></ul></li></ol>',
    );
  });
  await press("Enter");
  expect(onSend).toHaveBeenCalledWith("9.  a\n10. b\n    - c", {}, []);
});

test("``` and Shift+Enter start a code block, where Enter adds a line and Cmd+Enter sends", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press } = render(onSend);
  type("```ts");
  await press("Enter", { shiftKey: true });
  type("let a = 1;");
  await press("Enter");
  type("a += 1;");
  expect(box.querySelector("pre")?.textContent).toBe("let a = 1;\na += 1;");
  expect(onSend).not.toHaveBeenCalled();

  await press("Enter", { metaKey: true });
  expect(onSend).toHaveBeenCalledWith("```ts\nlet a = 1;\na += 1;\n```", {}, []);
});

test("paste takes the plain text, its lines as they are", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, press } = render(onSend);
  const data = new DataTransfer();
  data.setData("text/html", '<h1 style="color: red">Error</h1><p>at <b>main</b></p>');
  data.setData("text/plain", "Error\n  at main\n\nfn __init__()");
  act(() => {
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  expect(box.querySelector("h1, b, strong, [style]")).toBeNull();

  await press("Enter");
  expect(onSend).toHaveBeenCalledWith("Error\n  at main\n\nfn __init__()", {}, []);
});

test("copying within one block gives just its text", async () => {
  const { box, type, press } = render(vi.fn(async () => undefined));
  const copy = (from: number, to: number) => {
    const data = new DataTransfer();
    act(() => {
      box.editor!.commands.setTextSelection({ from, to });
      box.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true }));
    });
    return data.getData("text/plain");
  };
  type("```");
  await press("Enter", { shiftKey: true });
  type("let yVariable = 1;");
  // The code block's text starts at 1.
  expect(copy(5, 14)).toBe("yVariable");

  act(() => void box.editor!.commands.clearContent());
  type("- ");
  type("first **item** here");
  // In a list item's paragraph, at 3.
  expect(copy(9, 13)).toBe("**item**");
});

test("cut gives the Markdown as text, which pastes back the same", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press } = render(onSend);
  type("- ");
  type("first");
  await press("Enter", { shiftKey: true });
  type("second");
  const data = new DataTransfer();
  act(() => {
    box.editor!.commands.selectAll();
    box.dispatchEvent(new ClipboardEvent("cut", { clipboardData: data, bubbles: true }));
  });
  expect(data.getData("text/plain")).toBe("- first\n- second");
  expect(box.textContent).toBe("");

  act(() => {
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await press("Enter");
  expect(onSend).toHaveBeenCalledWith("- first\n- second", {}, []);
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
  await act(async () => fail("wispd is busy"));
  expect(alert()).toBe("wispd is busy");
  expect(box.querySelector("ul")?.textContent).toBe("first");
  // Still at most 10: the one sent, then the first nine added meanwhile.
  expect(thumbnails()).toHaveLength(10);

  await press("Enter");
  const gif = { mediaType: "image/gif", data: "R0lG" };
  expect(onSend).toHaveBeenLastCalledWith("- first\n\nmore", {}, [
    gif,
    ...Array<PromptImage>(9).fill(sentPng),
  ]);
});

test("a pasted image sits above the text, with its name nowhere in it, and is sent beside it", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press, paste } = render(onSend);
  // A copied image file's only text is its name.
  await paste([pngFile("Screenshot 2026-09-29.png")], {
    "text/plain": "Screenshot 2026-09-29.png",
  });
  await paste([pngFile(), pngFile()]);
  expect(thumbnails()).toEqual(["Image 1", "Image 2", "Image 3"]);
  expect(box.textContent).toBe("");
  act(() => document.querySelector<HTMLElement>('[aria-label="Remove image 2"]')!.click());
  expect(thumbnails()).toEqual(["Image 1", "Image 2"]);

  type("What's wrong here?");
  await press("Enter");
  expect(onSend).toHaveBeenCalledWith("What's wrong here?", {}, [sentPng, sentPng]);
  expect(thumbnails()).toEqual([]);

  // Images alone can be sent too.
  await paste([pngFile()]);
  await press("Enter");
  expect(onSend).toHaveBeenLastCalledWith("", {}, [sentPng]);
});

test("an image copied from a browser, with its URL as text, pastes as the image", async () => {
  const { box, paste } = render(vi.fn(async () => undefined));
  const url = "https://example.com/cat-photo.png";
  await paste([pngFile()], {
    "text/plain": url,
    "text/html": `<meta charset="utf-8"><img src="${url}">`,
  });
  expect(thumbnails()).toEqual(["Image 1"]);
  expect(box.textContent).toBe("");
});

test("text copied from an app with a picture of itself pastes as text", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, paste } = render(onSend);
  await paste([pngFile()], {
    "text/plain": "A1\tB1",
    "text/html": "<table><tr><td>A1</td></tr></table>",
  });
  expect(thumbnails()).toEqual([]);
  expect(box.textContent).toBe("A1\tB1");
});

test("an image wispd can't take says why and isn't added", async () => {
  const { paste } = render(vi.fn(async () => undefined));
  await paste([new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })]);
  expect(thumbnails()).toEqual([]);
  expect(alert()).toBe("Only PNG, JPEG, GIF, and WebP images can be sent.");

  await paste(Array.from({ length: 11 }, () => pngFile()));
  expect(thumbnails()).toHaveLength(10);
  expect(alert()).toBe("A message takes at most 10 images.");
});

test("without wispd's image capability, adding an image says so", async () => {
  const { paste } = render(
    vi.fn(async () => undefined),
    null,
  );
  await paste([pngFile()]);
  expect(thumbnails()).toEqual([]);
  expect(alert()).toBe("This host's wispd can't take images.");
});

test("a picked image is a thumbnail, and any other file is a chip", async () => {
  render(vi.fn(async () => undefined));
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const data = new DataTransfer();
  data.items.add(pngFile());
  data.items.add(new File(["# Notes"], "notes.md", { type: "text/markdown" }));
  Object.defineProperty(picker, "files", { value: data.files });
  act(() => void picker.dispatchEvent(new Event("change", { bubbles: true })));
  await read();
  expect(thumbnails()).toEqual(["Image 1"]);
  expect(document.querySelector('[aria-label="Remove notes.md"]')).not.toBeNull();
});
