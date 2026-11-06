import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { ErrorCodes, PROTOCOL_VERSION } from "../protocol/generated/protocol";
import { UPDATE_NOTICE_MS } from "../protocol/updateNotice";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  PROTOCOL_VERSION as WEB_PROTOCOL,
  WebHost,
} from "./webBridge";

test("a drop after host/updating says updating until the notice runs out, as the phone reads it", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  try {
    const socket = { send: () => {}, close: () => {} } as unknown as WebSocket;
    const host = new WebHost(async () => socket);
    await host.connect();
    const receive = (message: unknown) =>
      socket.onmessage!({ data: JSON.stringify(message) } as MessageEvent);
    // One it doesn't know does nothing.
    receive({ jsonrpc: "2.0", method: "host/fromTheFuture", params: {} });
    receive({ jsonrpc: "2.0", method: "host/updating", params: {} });
    socket.onclose!({} as CloseEvent);
    expect(host.state).toEqual(expect.objectContaining({ status: "failed", updating: true }));
    vi.advanceTimersByTime(UPDATE_NOTICE_MS - 1);
    expect(host.state.updating).toBe(true);
    vi.advanceTimersByTime(1);
    expect(host.state.updating).toBeUndefined();
    host.close();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

// webBridge.ts copies these so the web chunk shares no module with the app's.
test("the web bridge's protocol constants match the generated protocol", () => {
  expect(WEB_PROTOCOL).toBe(PROTOCOL_VERSION);
  expect(INTERNAL_ERROR).toBe(ErrorCodes.InternalError);
  expect(INVALID_PARAMS).toBe(ErrorCodes.InvalidParams);
});

// plxd serves the renderer build to anyone who reaches it (PLX-651), so nothing from the build's
// environment, such as a key, may be compiled into it.
test("the renderer reads no environment, so its build holds no secrets", () => {
  const dirs = ["src/renderer", "src/protocol"];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
      .map((file) => path.join(dir, file)),
  );
  const reading = [...files, "src/preload/bridge.ts"].filter((file) =>
    /import\.meta\.env|process\.env/.test(readFileSync(file, "utf8")),
  );
  expect(reading).toEqual([]);
});
