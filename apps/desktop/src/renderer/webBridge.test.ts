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

test("the phone sends subscriptions behind initialize, and drops one a new log made stale (PLX-1480)", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  try {
    const sent: { id?: number; method: string; params?: unknown }[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (line: string) => sent.push(JSON.parse(line)),
      close: () => {},
    } as unknown as WebSocket;
    const host = new WebHost(async () => socket);
    const listener = vi.fn();
    host.subscribe({ after: 5, logId: "log-1" }, listener);
    host.watch({ threadId: "t-1" }, () => {});
    await host.connect();
    socket.onopen!({} as Event);
    const methods = ["initialize", "events/subscribe", "orchestration/subscribeThread"];
    expect(sent.map((message) => message.method)).toEqual(methods);
    const handshake = JSON.parse(
      readFileSync(
        new URL("../../../../crates/parallax-protocol/samples/v1/handshake.json", import.meta.url),
        "utf8",
      ),
    )[1].result;
    const receive = (...messages: unknown[]) => {
      for (const message of messages)
        socket.onmessage!({
          data: JSON.stringify({ jsonrpc: "2.0", ...(message as object) }),
        } as MessageEvent);
    };
    receive({ id: sent[0]!.id, result: { ...handshake, logId: "log-2" } });
    expect(sent.map((message) => message.method)).toEqual(methods);
    expect(listener).not.toHaveBeenCalled();
    receive(
      { id: sent[1]!.id, result: { subscription: "sub-1" } },
      { method: "events/event", params: { subscription: "sub-1", seq: 6, time: "", event: {} } },
    );
    expect(listener.mock.calls).toEqual([[{ type: "resync" }]]);
    expect(sent.at(-1)).toMatchObject({
      method: "events/unsubscribe",
      params: { subscription: "sub-1" },
    });
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
