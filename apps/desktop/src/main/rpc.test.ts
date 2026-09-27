import { afterEach, expect, test, vi } from "vite-plus/test";

import { ErrorCodes, MAX_FRAME_BYTES } from "../protocol/generated/protocol";
import { RpcClient } from "./rpc";

function setup() {
  const sent: Record<string, unknown>[] = [];
  const notifications: unknown[] = [];
  const fatal: string[] = [];
  const client = new RpcClient((line) => sent.push(JSON.parse(line) as Record<string, unknown>), {
    onNotification: (method, params) => notifications.push({ method, params }),
    onFatal: (message) => fatal.push(message),
  });
  return { client, sent, notifications, fatal };
}

const line = (message: object) => Buffer.from(`${JSON.stringify(message)}\n`);
const event = (seq: number) => ({
  jsonrpc: "2.0",
  method: "events/event",
  params: { seq, note: "é" },
});

afterEach(() => {
  vi.useRealTimers();
});

test("reads lines split anywhere across chunks, including inside a UTF-8 character", () => {
  const { client, notifications } = setup();
  const bytes = Buffer.concat([line(event(1)), line(event(2)), line(event(3))]);
  for (let i = 0; i < bytes.length; i += 7) client.receive(bytes.subarray(i, i + 7));
  expect(notifications).toEqual(
    [1, 2, 3].map((seq) => ({ method: "events/event", params: event(seq).params })),
  );
});

test("skips a malformed line and keeps reading", () => {
  const { client, notifications } = setup();
  client.receive(Buffer.concat([Buffer.from("{not json\n"), line(event(1))]));
  expect(notifications).toHaveLength(1);
});

test("closes on a frame over maxFrameBytes before its newline arrives", async () => {
  const { client, fatal } = setup();
  const pending = client.request("host/health", {}, 1000);
  client.receive(Buffer.alloc(MAX_FRAME_BYTES + 1, "a"));
  expect(fatal).toHaveLength(1);
  expect(await pending).toMatchObject({ error: { code: ErrorCodes.InternalError } });
  client.receive(line(event(1))); // Ignored once closed.
});

test("matches responses to requests by id, in any order", async () => {
  const { client, sent } = setup();
  const health = client.request("host/health", {}, 1000);
  const list = client.request("project/list", {}, 1000);
  const [healthId, listId] = sent.map((message) => message["id"]);
  client.receive(line({ jsonrpc: "2.0", id: listId, result: { projects: [], seq: 4 } }));
  client.receive(
    line({
      jsonrpc: "2.0",
      id: healthId,
      error: { code: -32000, message: "no", data: { kind: "internal" } },
    }),
  );
  expect(await list).toEqual({ result: { projects: [], seq: 4 } });
  expect(await health).toMatchObject({ error: { code: -32000, data: { kind: "internal" } } });
});

test("a timed-out request sends $/cancelRequest and ignores its late answer", async () => {
  vi.useFakeTimers();
  const { client, sent } = setup();
  const list = client.request("project/list", {}, 1000);
  const id = sent[0]?.["id"];
  vi.advanceTimersByTime(1000);
  expect(sent[1]).toEqual({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
  expect(await list).toMatchObject({ error: { code: ErrorCodes.RequestCancelled } });
  client.receive(
    line({ jsonrpc: "2.0", id, error: { code: -32800, message: "Request cancelled" } }),
  );
});
