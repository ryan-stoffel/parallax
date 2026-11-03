// @vitest-environment happy-dom
import { afterEach, expect, test } from "vite-plus/test";

import { focusIsFree } from "./Question";

/** A pane's composer, with a panel beside it, and the box that takes the text. */
function pane() {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="composer-top"><div class="panel"></div></div>
    <div class="composer-shell"><div class="box" contenteditable="true" tabindex="0"></div></div>
  `;
  document.body.append(root);
  const panel = root.querySelector<HTMLElement>(".panel")!;
  const box = root.querySelector<HTMLElement>(".box")!;
  // happy-dom doesn't derive this from the attribute.
  Object.defineProperty(box, "isContentEditable", { value: true });
  return { panel, box, shell: root.querySelector(".composer-shell")! };
}

afterEach(() => document.body.replaceChildren());

test("a question takes focus from nothing, or from its own empty composer", () => {
  const { panel, box } = pane();
  expect(focusIsFree(panel)).toBe(true);
  box.focus();
  expect(focusIsFree(panel)).toBe(true);
});

test("a question leaves focus in a composer that holds text or attachments", () => {
  const { panel, box, shell } = pane();
  box.focus();
  box.textContent = "A draft";
  expect(focusIsFree(panel)).toBe(false);
  box.textContent = "";
  shell.insertAdjacentHTML("afterbegin", `<fieldset class="composer-attachments"></fieldset>`);
  expect(focusIsFree(panel)).toBe(false);
});

test("a question leaves focus in another pane's empty composer, and on anything else", () => {
  const { panel } = pane();
  const other = pane();
  other.box.focus();
  expect(focusIsFree(panel)).toBe(false);
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  expect(focusIsFree(panel)).toBe(false);
});
