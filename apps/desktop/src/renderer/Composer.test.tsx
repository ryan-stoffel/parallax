// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { Composer } from "./Composer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
afterEach(() => act(() => unmount()));

function render(onSend: (text: string) => Promise<string | undefined>) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Composer onSend={onSend} />));
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
  return { box, type, press };
}

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
  );
  expect(box.textContent).toBe("");
});

test("in a code block Enter adds a line and Cmd+Enter sends", async () => {
  const onSend = vi.fn(async () => undefined);
  const { box, type, press } = render(onSend);
  type("```ts ");
  type("let a = 1;");
  await press("Enter");
  type("a += 1;");
  expect(box.querySelector("pre")?.textContent).toBe("let a = 1;\na += 1;");
  expect(onSend).not.toHaveBeenCalled();

  await press("Enter", { metaKey: true });
  expect(onSend).toHaveBeenCalledWith("```ts\nlet a = 1;\na += 1;\n```", {});
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
  expect(onSend).toHaveBeenCalledWith("Error\n  at main\n\nfn __init__()", {});
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
  expect(onSend).toHaveBeenCalledWith("- first\n- second", {});
});

test("a failed send puts the same text back, ahead of anything typed meanwhile", async () => {
  let fail = (_error: string) => {};
  const onSend = vi.fn(
    (_text: string) => new Promise<string | undefined>((resolve) => (fail = resolve)),
  );
  const { box, type, press } = render(onSend);
  type("- ");
  type("first");
  await press("Enter");
  type("more");
  await act(async () => fail("wispd is busy"));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("wispd is busy");
  expect(box.querySelector("ul")?.textContent).toBe("first");

  await press("Enter");
  expect(onSend).toHaveBeenLastCalledWith("- first\n\nmore", {});
});
