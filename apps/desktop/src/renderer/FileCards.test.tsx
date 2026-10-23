// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import { pieceBytes, readAttachment } from "./documents";
import { DownloadButton, FileCards } from "./FileCards";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};

let connection: ConnectionState["status"] = "connected";
let capabilities: Record<string, unknown> = {};
// The presented file's bytes, which a slice reads part of.
let file = new Uint8Array(1536);
type FileParams = { sizeOnly?: boolean; offset?: number; length?: number };
const request = vi.fn(async (_host: string, method: string, params?: FileParams) =>
  method === "agent/file"
    ? {
        logId: "l",
        result: {
          path: "",
          side: "working",
          exists: true,
          size: file.length,
          tooLarge: false,
          content: params?.sizeOnly
            ? undefined
            : Buffer.from(
                params?.offset === undefined
                  ? file
                  : file.subarray(params.offset, params.offset + params.length!),
              ).toString("base64"),
        },
      }
    : { error: { code: -32603, message: "not connected" } },
);
// What each Download saved: its name and bytes.
let saved: { name: string; blob: Blob }[] = [];
let unmount = () => {};
beforeEach(() => {
  connection = "connected";
  capabilities = {};
  file = new Uint8Array(1536);
  saved = [];
  request.mockClear();
  window.parallax = {
    request,
    connectionState: async () => ({ status: connection, capabilities }) as ConnectionState,
    onConnectionState: () => () => {},
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
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
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

test("a presented file of a kind the app doesn't know is a card with its size, read only for Download (PLX-835)", async () => {
  const doc = {
    runId: "run-1",
    path: "out/data.parquet",
    name: "data.parquet",
    kind: "file" as const,
  };
  await render(<FileCards hostId="box" item="7" files={[doc]} />);
  const sized = { runId: "run-1", path: "out/data.parquet", side: "working" };
  expect(request.mock.calls).toEqual([["box", "agent/file", { ...sized, sizeOnly: true }]]);
  expect(document.body.textContent).toContain("data");
  expect(document.body.textContent).toContain("2 KB · PARQUET");

  await act(async () => download().click());
  await settle();
  expect(request).toHaveBeenLastCalledWith("box", "agent/file", sized);
  expect(saved.map((s) => [s.name, s.blob.size])).toEqual([["data.parquet", 1536]]);
});

test("a Download that can't read its bytes says the host is offline in a notification", async () => {
  connection = "failed";
  await render(
    <>
      <DownloadButton name="Recording.webm" read={() => readAttachment("box", "run-1", "rec-1")} />
      <Notifications />
    </>,
  );
  await act(async () => download().click());
  await settle();
  expect(request).toHaveBeenCalledWith("box", "agent/image", { runId: "run-1", imageId: "rec-1" });
  const notice = document.querySelector('[aria-label="Notifications"] > div')!;
  expect(notice.querySelector("span")!.textContent).toBe("Couldn't download Recording.webm");
  expect(notice.querySelector("p")!.textContent).toBe("The host is offline.");
  expect(saved).toEqual([]);
});

test("a presented video plays from main's stream on a host that reads slices, and Download reads it whole in slices (PLX-835)", async () => {
  capabilities = { fileChunks: { chunkBytes: 1048576, maxBytes: 1073741824 } };
  // Three slices of `pieceBytes`.
  file = Uint8Array.from({ length: 600_000 }, (_, i) => i % 251);
  const doc = {
    runId: "run-1",
    path: "out/demo clip.mp4",
    name: "demo clip.mp4",
    kind: "mp4" as const,
  };
  await render(<FileCards hostId="box" item="7" files={[doc]} />);
  expect(document.querySelector("video")!.getAttribute("src")).toBe(
    "plx-file://file/box/run-1/out%2Fdemo%20clip.mp4",
  );
  expect(request).not.toHaveBeenCalled();

  const save = document.querySelector<HTMLButtonElement>('[aria-label="Download demo clip.mp4"]')!;
  await act(async () => save.click());
  await settle();
  const slice = { runId: "run-1", path: "out/demo clip.mp4", side: "working", length: pieceBytes };
  expect(request.mock.calls).toEqual(
    [0, pieceBytes, 2 * pieceBytes].map((offset) => ["box", "agent/file", { ...slice, offset }]),
  );
  expect(saved.map((s) => s.name)).toEqual(["demo clip.mp4"]);
  const bytes = new Uint8Array(await saved[0]!.blob.arrayBuffer());
  expect(Buffer.from(bytes).equals(Buffer.from(file))).toBe(true);
});

test("an older host's video is read whole, as before", async () => {
  const doc = { runId: "run-1", path: "demo.mp4", name: "demo.mp4", kind: "mp4" as const };
  await render(<FileCards hostId="box" item="7" files={[doc]} />);
  expect(document.querySelector("video")!.getAttribute("src")).toMatch(/^blob:/);
  expect(request).toHaveBeenCalledTimes(1);
});
