// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import type { AgentFileParams } from "../protocol/generated/protocol";
import { pieceBytes, progressFrom, readWorking } from "./documents";

const MiB = 2 ** 20;
// Just over `progressFrom`, so it reads in 17 slices of `pieceBytes` and reports its progress.
let file = Uint8Array.from({ length: progressFrom + 1 }, (_, i) => i % 251);
let state: ConnectionState;
// Answers that fail before the next real one, as timeouts on a slow link do.
let failing = 0;
const request = vi.fn(async (_host: string, _method: string, p: AgentFileParams) => {
  if (failing-- > 0) return { error: { code: -32603, message: "timed out" } };
  const sliced = p.offset !== undefined;
  const bytes = sliced ? file.subarray(p.offset, p.offset! + p.length!) : file;
  const tooLarge = !sliced && file.length > 4 * MiB;
  return {
    logId: "l",
    result: {
      path: p.path,
      side: "working" as const,
      exists: true,
      size: file.length,
      tooLarge,
      content: tooLarge ? undefined : Buffer.from(bytes).toString("base64"),
    },
  };
});
const connected = (capabilities: Record<string, Record<string, number>>) =>
  ({ status: "connected", plxd: "", protocol: 1, capabilities }) as ConnectionState;

beforeEach(() => {
  file = Uint8Array.from({ length: progressFrom + 1 }, (_, i) => i % 251);
  state = connected({ fileChunks: { chunkBytes: 2 * MiB, maxBytes: 2 ** 30 } });
  failing = 0;
  request.mockClear();
  window.parallax = {
    request,
    connectionState: async () => state,
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

const offsets = () => request.mock.calls.map(([, , p]) => p.offset);

test("a file reads in slices of pieceBytes, under plxd's chunkBytes, in order, into one buffer, with its progress (PLX-835)", async () => {
  const progress: number[] = [];
  const bytes = await readWorking("box", "run-1", "out/big.bin", (share) => progress.push(share));
  expect(Buffer.from(bytes).equals(Buffer.from(file))).toBe(true);
  const at = Array.from({ length: 17 }, (_, i) => i * pieceBytes);
  expect(offsets()).toEqual(at);
  expect(request.mock.calls[0]![2]).toEqual({
    runId: "run-1",
    path: "out/big.bin",
    side: "working",
    offset: 0,
    length: pieceBytes,
  });
  expect(progress).toEqual([...at.slice(1).map((n) => n / file.length), 1]);
});

test("a small file reads in one slice and reports no progress (PLX-835)", async () => {
  file = new TextEncoder().encode("# Notes\n");
  const onProgress = vi.fn();
  expect(new TextDecoder().decode(await readWorking("box", "run-1", "a.md", onProgress))).toBe(
    "# Notes\n",
  );
  expect(offsets()).toEqual([0]);
  expect(onProgress).not.toHaveBeenCalled();
});

test("a failed slice is asked again twice, then the read fails with plxd's reason (PLX-835)", async () => {
  failing = 2;
  await readWorking("box", "run-1", "out/big.bin");
  expect(offsets().slice(0, 4)).toEqual([0, 0, 0, pieceBytes]);

  request.mockClear();
  failing = 3;
  await expect(readWorking("box", "run-1", "out/big.bin")).rejects.toThrow("timed out");
  expect(offsets()).toEqual([0, 0, 0]);
});

test("a file rewritten mid-read fails rather than mixing two versions (PLX-835)", async () => {
  const first = file;
  request.mockImplementationOnce(async (_host, _method, p) => {
    file = first.subarray(0, 3 * MiB);
    return {
      logId: "l",
      result: {
        path: p.path,
        side: "working",
        exists: true,
        size: first.length,
        tooLarge: false,
        content: Buffer.from(first.subarray(0, 2 * MiB)).toString("base64"),
      },
    };
  });
  await expect(readWorking("box", "run-1", "out/big.bin")).rejects.toThrow(
    "This file changed while it was read.",
  );
});

test("an older plxd without fileChunks reads in one message, under its cap (PLX-835)", async () => {
  state = connected({});
  await expect(readWorking("box", "run-1", "out/big.bin")).rejects.toThrow(
    "This file is too large to open here.",
  );
  expect(request.mock.calls[0]![2]).toEqual({
    runId: "run-1",
    path: "out/big.bin",
    side: "working",
  });

  file = new TextEncoder().encode("small");
  expect(new TextDecoder().decode(await readWorking("box", "run-1", "a.txt"))).toBe("small");
});
