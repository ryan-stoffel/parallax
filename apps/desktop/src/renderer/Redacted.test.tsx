// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { Redacted, redactedPlaceholder } from "./Redacted";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const email = "ryan.stoffel-dev_1@example.com";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode) {
  const el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}

test("the placeholder keeps the email's shape, is stable, and never contains it", () => {
  const placeholder = redactedPlaceholder(email);
  expect(placeholder).toHaveLength(email.length);
  expect(placeholder.replace(/[^@._-]/g, "")).toBe(email.replace(/[^@._-]/g, ""));
  expect(placeholder).toBe(redactedPlaceholder(email));
  expect(placeholder).not.toContain("ryan");
  expect(placeholder).not.toContain("example");
});

test("an email is hidden until hovered, and only the email in a label", () => {
  const el = render(<Redacted text={`Authenticated as ${email}`} />);
  expect(el.textContent).toBe(
    `Authenticated as ${redactedPlaceholder(email)}Email hidden, hover or focus to show`,
  );
  const span = el.querySelector("span")!;
  act(() => void span.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  expect(el.textContent).toBe(`Authenticated as ${email}`);
  act(
    () =>
      void span.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      ),
  );
  expect(el.textContent).not.toContain(email);
});

test("keyboard focus reveals it, on its own or in the control it's in", () => {
  const alone = render(<Redacted text={email} />);
  const span = alone.querySelector<HTMLElement>("[tabindex='0']")!;
  act(() => span.focus());
  expect(alone.textContent).toBe(email);
  act(() => span.blur());
  expect(alone.textContent).not.toContain(email);
  act(() => root!.unmount());

  const row = render(
    <button type="button">
      <Redacted text={email} />
    </button>,
  );
  expect(row.querySelector("[tabindex]")).toBeNull();
  act(() => row.querySelector("button")!.focus());
  expect(row.textContent).toBe(email);
});
