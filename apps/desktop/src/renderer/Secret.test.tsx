// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { SecretCard } from "./Secret";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request = vi.fn(async () => ({ result: {}, logId: "log-1" }));
Object.assign(window, { parallax: { request } });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  request.mockClear();
});

function card() {
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
          request: { requestId: "s1", label: "Webhook secret", reason: "To check signatures." },
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
