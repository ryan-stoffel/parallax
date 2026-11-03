// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { maskedLines, SecretCard } from "./Secret";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request = vi.fn(async () => ({ result: {}, logId: "log-1" }));
Object.assign(window, { parallax: { request } });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  request.mockClear();
});

function card(delivery?: "file") {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() =>
    root!.render(
      <SecretCard
        hostId="h1"
        runId="r1"
        secret={{
          kind: "secret",
          key: "k1",
          request: {
            requestId: "s1",
            label: "Webhook secret",
            reason: "To check signatures.",
            delivery,
          },
        }}
      />,
    ),
  );
  return el;
}

test("Save sends the value to secret/answer from a password field, and Decline sends none", async () => {
  const el = card();
  const input = el.querySelector("input")!;
  expect(input.type).toBe("password");
  expect(el.textContent).toContain("To check signatures.");
  input.value = "example";
  await act(async () => el.querySelector("form")!.requestSubmit());
  expect(request).toHaveBeenCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "save", secret: "example" },
  });

  act(() => root!.unmount());
  const again = card();
  const decline = [...again.querySelectorAll("button")].find((b) => b.textContent === "Decline")!;
  await act(async () => decline.click());
  expect(request).toHaveBeenLastCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "decline" },
  });
});

test("A file request says commands can read it, keeps newlines, and saves on Enter", async () => {
  const el = card("file");
  expect(el.textContent).toContain("this agent's commands can read for 24 hours");
  expect(el.textContent).not.toContain("never the value");
  const field = el.querySelector("textarea")!;
  field.value = "A=1\nB=2\n";
  const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true });
  await act(async () => field.dispatchEvent(newline));
  expect(request).not.toHaveBeenCalled();
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  await act(async () => field.dispatchEvent(enter));
  expect(request).toHaveBeenCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "save", secret: "A=1\nB=2\n" },
  });
});

test("A pasted env file shows its names and hides its values, in the DOM as well as to the eye", async () => {
  const el = card("file");
  const field = el.querySelector("textarea")!;
  field.value = "# old-value\nAPI_KEY=abc\n\nexport DB_URL=postgres://x\n";
  await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  const shown = el.querySelector("[data-testid=secret-mask]")!.textContent;
  expect(shown).toBe("•••••••••••\nAPI_KEY=•••\n\nexport DB_URL=••••••••••••\n\n");
});

test.each([
  ["a password with an equals sign", "ABC=def"],
  ["a single variable, which could be a password copied with its newline", "ABC=def\n"],
  ["base32 tokens with padding", "ABCDEF==\nGHIJKL=="],
  ["a private key", "-----BEGIN KEY-----\nabc=\nDEF=x\n-----END KEY-----"],
  ["assignments among other text", "A=1\nB=2\nnot an assignment"],
])("Shows no names for %s", (_, value) => {
  expect(maskedLines(value).every((line) => !line.name)).toBe(true);
});
