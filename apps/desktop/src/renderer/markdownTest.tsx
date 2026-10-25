// For tests that render Markdown: Enriched Markdown draws it (MarkdownText) once it has parsed
// it, in microtasks once its parser has loaded. Importing this loads the parser before the file's
// first test, and `parsed` waits for what's on the page to be drawn.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, vi } from "vite-plus/test";

import { MarkdownText } from "./AgentChat";

beforeAll(async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<MarkdownText text="Loaded" />));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toBe("Loaded");
  });
  act(() => root.unmount());
  host.remove();
});

/** Waits for the Markdown on the page to be drawn. */
export const parsed = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
