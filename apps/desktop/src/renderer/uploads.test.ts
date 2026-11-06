// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import type { HostUploadParams } from "../protocol/generated/protocol";
import { pieceBytes } from "./documents";
import { splitFiles, withFiles } from "./attachments";
import { readUpload, uploadBytes, uploadFiles } from "./uploads";

const connected = (capabilities: Record<string, Record<string, number>>) =>
  ({ status: "connected", plxd: "", protocol: 1, capabilities }) as ConnectionState;
const chunked = { chunkBytes: 4, maxBytes: 2 ** 30 };
const timedOut = { error: { code: -32603, message: "timed out" } };
// A connected host, which a retry finds without waiting.
const bridge = (request: unknown) =>
  ({
    request,
    connectionState: async () => connected({}),
    onConnectionState: () => () => {},
  }) as Partial<ParallaxBridge> as ParallaxBridge;

test("a file can be as large as fileChunks' maxBytes, or else as one message's base64 holds (PLX-835)", () => {
  const fileUploads = { maxBytes: 6 * 2 ** 20 };
  expect(uploadBytes(connected({ fileUploads }))).toEqual({ maxBytes: 4.5 * 2 ** 20 });
  expect(uploadBytes(connected({ fileUploads, fileChunks: chunked }))).toEqual(chunked);
  // plxd's chunkBytes is a maximum: pieces go at pieceBytes, which a slow link sends in time.
  const big = { chunkBytes: 2 ** 20, maxBytes: 2 ** 30 };
  expect(uploadBytes(connected({ fileUploads, fileChunks: big }))).toEqual({
    chunkBytes: pieceBytes,
    maxBytes: 2 ** 30,
  });
  expect(uploadBytes(connected({ fileChunks: chunked }))).toBeUndefined();
  expect(uploadBytes({ status: "connecting" } as ConnectionState)).toBeUndefined();
});

test("a file goes in pieces, in order, naming its upload, and a failed piece is sent again (PLX-835)", async () => {
  // The piece at 4 times out twice, then lands.
  let timeouts = 2;
  const request = vi.fn(async (_host: string, _method: string, params: HostUploadParams) =>
    params.offset === 4 && timeouts-- > 0
      ? timedOut
      : { logId: "l", result: { path: "/up/u1/notes.txt", uploadId: "u1" } },
  );
  window.parallax = bridge(request);
  const progress: number[] = [];
  const file = new File(["0123456789"], "notes.txt");
  const paths = await uploadFiles("box", [file], 4, (f, share) => progress.push(share));

  expect(paths).toEqual(["/up/u1/notes.txt"]);
  const sent = request.mock.calls.map(([, , p]) => [p.offset, p.uploadId, p.last, atob(p.data)]);
  expect(sent).toEqual([
    [0, undefined, false, "0123"],
    [4, "u1", false, "4567"],
    [4, "u1", false, "4567"],
    [4, "u1", false, "4567"],
    [8, "u1", true, "89"],
  ]);
  expect(progress).toEqual([0, 0.4, 0.8, 1]);
});

test("a piece cut off by a dropped connection is sent again once the host reconnects (PLX-835)", async () => {
  let state = { status: "connecting" } as ConnectionState;
  let listener: ((hostId: string, state: ConnectionState) => void) | undefined;
  let dropped = false;
  const request = vi.fn(async (_host: string, _method: string, params: HostUploadParams) => {
    if (params.offset === 4 && !dropped) {
      dropped = true;
      return { error: { code: -32603, message: "the connection to plxd ended" } };
    }
    return { logId: "l", result: { path: "/up/u1/a.txt", uploadId: "u1" } };
  });
  window.parallax = {
    request,
    connectionState: async () => state,
    onConnectionState: (l: typeof listener) => {
      listener = l;
      return () => (listener = undefined);
    },
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const sending = uploadFiles("box", [new File(["0123456789"], "a.txt")], 4);
  await vi.waitFor(() => expect(listener).toBeDefined());
  // Nothing is sent again while the host reconnects.
  expect(request).toHaveBeenCalledTimes(2);
  state = connected({});
  listener!("box", state);

  expect(await sending).toEqual(["/up/u1/a.txt"]);
  expect(request.mock.calls.map(([, , p]) => [p.offset, p.uploadId])).toEqual([
    [0, undefined],
    [4, "u1"],
    [4, "u1"],
    [8, "u1"],
  ]);
});

test("a piece that fails three times stops the upload and says which file (PLX-835)", async () => {
  const request = vi.fn(async (_host: string, _method: string, params: HostUploadParams) =>
    params.offset === 4
      ? timedOut
      : { logId: "l", result: { path: "/up/u1/a.txt", uploadId: "u1" } },
  );
  window.parallax = bridge(request);
  const files = [new File(["0123456789"], "a.txt"), new File(["x"], "b.txt")];
  expect(await uploadFiles("box", files, 4)).toBe("a.txt couldn't be sent: timed out");
  expect(request.mock.calls.map(([, , p]) => [p.name, p.offset])).toEqual([
    ["a.txt", 0],
    ["a.txt", 4],
    ["a.txt", 4],
    ["a.txt", 4],
  ]);
});

test("without chunkBytes a file is one message, as an older plxd takes it, and an image always is (PLX-835)", async () => {
  const request = vi.fn(async (_host: string, _method: string, params: HostUploadParams) => ({
    logId: "l",
    result: { path: `/up/${params.name}` },
  }));
  window.parallax = bridge(request);
  const image = { name: "image-1.png", data: "iVBO" };
  await uploadFiles("box", [new File(["abc"], "a.txt"), image]);
  await uploadFiles("box", [image], 4);
  expect(request.mock.calls.map(([, , p]) => p)).toEqual([
    { name: "a.txt", data: "YWJj" },
    image,
    image,
  ]);
});

test("a sent file reads back in slices on a plxd with fileChunks, or else in one message (PLX-835)", async () => {
  const file = "0123456789";
  const request = vi.fn(
    async (_host: string, _method: string, p: { offset?: number; length?: number }) => ({
      logId: "l",
      result:
        p.offset === undefined
          ? { data: btoa(file) }
          : { data: btoa(file.slice(p.offset, p.offset + p.length!)), size: file.length },
    }),
  );
  let state = connected({ fileChunks: chunked });
  window.parallax = {
    request,
    connectionState: async () => state,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  expect(text(await readUpload("box", "/up/u1/a.txt"))).toBe(file);
  expect(request.mock.calls.map(([, , p]) => p)).toEqual(
    [0, 4, 8].map((offset) => ({
      path: "/up/u1/a.txt",
      offset,
      length: 4,
    })),
  );
  request.mockClear();
  state = connected({});
  expect(text(await readUpload("box", "/up/u1/a.txt"))).toBe(file);
  expect(request.mock.calls).toEqual([["box", "host/readUpload", { path: "/up/u1/a.txt" }]]);
});

test("splitFiles takes back what withFiles added, and leaves other text alone (PLX-779)", () => {
  const paths = ["/u/1/paper v3.pdf", "/u/2/notes.md"];
  expect(splitFiles(withFiles("Summarize this.\n\nThanks", paths))).toEqual({
    text: "Summarize this.\n\nThanks",
    paths,
  });
  expect(splitFiles(withFiles("", paths))).toEqual({ text: "", paths });
  expect(splitFiles("Attached files: none")).toEqual({ text: "Attached files: none", paths: [] });
  const written = "See below.\n\nAttached files:\n- report.pdf";
  expect(splitFiles(written)).toEqual({ text: written, paths: [] });
  expect(splitFiles(withFiles("", ["C:\\up\\a.pdf"])).paths).toEqual(["C:\\up\\a.pdf"]);
});
