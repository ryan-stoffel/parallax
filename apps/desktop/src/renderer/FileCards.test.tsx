// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import { readAttachment } from "./documents";
import { DownloadButton, FileCards } from "./FileCards";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let connection: ConnectionState["status"] = "connected";
const request = vi.fn(async (_host: string, method: string) =>
  method === "agent/file"
    ? {
        logId: "l",
        result: {
          path: "",
          side: "working",
          exists: true,
          tooLarge: false,
          content: "AAAA".repeat(512),
        },
      }
    : { error: { code: -32603, message: "not connected" } },
);
// What each Download saved: its name and bytes.
let saved: { name: string; blob: Blob }[] = [];
let unmount = () => {};
beforeEach(() => {
  connection = "connected";
  saved = [];
  window.parallax = {
    request,
    connectionState: async () => ({ status: connection }) as ConnectionState,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ name: this.download, blob: blobs.get(this.href)! });
  });
});
afterEach(() => {
  act(() => unmount());
  vi.restoreAllMocks();
});

async function render(node: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};
const download = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Download")!;

test("a presented file of a kind the app doesn't know is a card with its size and Download", async () => {
  const doc = {
    runId: "run-1",
    path: "out/data.parquet",
    name: "data.parquet",
    kind: "file" as const,
  };
  await render(<FileCards hostId="box" item="7" files={[doc]} />);
  expect(request).toHaveBeenCalledWith("box", "agent/file", {
    runId: "run-1",
    path: "out/data.parquet",
    side: "working",
  });
  expect(document.body.textContent).toContain("data");
  // 2,048 base64 characters are 1,536 bytes.
  expect(document.body.textContent).toContain("2 KB · PARQUET");

  await act(async () => download().click());
  expect(saved.map((s) => [s.name, s.blob.size])).toEqual([["data.parquet", 1536]]);
});

test("a Download that can't read its bytes says the host is offline, beside it", async () => {
  connection = "failed";
  await render(
    <DownloadButton name="Recording.webm" read={() => readAttachment("box", "run-1", "rec-1")} />,
  );
  await act(async () => download().click());
  await settle();
  expect(request).toHaveBeenCalledWith("box", "agent/image", { runId: "run-1", imageId: "rec-1" });
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("The host is offline.");
  expect(saved).toEqual([]);
});
