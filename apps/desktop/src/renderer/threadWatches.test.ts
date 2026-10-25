import { beforeEach, expect, test, vi } from "vite-plus/test";

import type { WatchMessage } from "../preload/bridge";
import { watchThread, type ThreadMessage } from "./threadWatches";

let opened: { threadId: string; send: (m: ThreadMessage) => void; stopped: boolean }[];

beforeEach(() => {
  opened = [];
  vi.stubGlobal("window", {
    parallax: {
      watch: (_host: string, params: { threadId: string }, listener: (m: WatchMessage) => void) => {
        const w = { threadId: params.threadId, send: listener, stopped: false };
        opened.push(w);
        return () => {
          w.stopped = true;
        };
      },
    },
  });
});

const snapshot = { type: "snapshot", snapshot: { seq: 1 } } as unknown as ThreadMessage;
const event = (seq: number) => ({ type: "event", event: { seq } }) as unknown as ThreadMessage;

test("a thread opened again gets its snapshot and the events since at once, unwatched again", () => {
  watchThread("h", "t", () => {})();
  opened[0]!.send(snapshot);
  opened[0]!.send(event(2));

  const got: ThreadMessage[][] = [];
  watchThread("h", "t", (m) => got.push(m));
  expect(opened).toHaveLength(1);
  expect(got).toEqual([[snapshot, event(2)]]);
  opened[0]!.send(event(3));
  expect(got[1]).toEqual([event(3)]);
});

test("closed threads past the six most recent stop being watched", () => {
  for (let i = 0; i < 8; i++) watchThread("h", `t${i}`, () => {})();
  expect(opened.filter((w) => w.stopped).map((w) => w.threadId)).toEqual(["t0", "t1"]);
});

test("an open thread stays watched however many close after it", () => {
  const stop = watchThread("h", "open", () => {});
  for (let i = 0; i < 8; i++) watchThread("h", `t${i}`, () => {})();
  expect(opened[0]!.stopped).toBe(false);
  stop();
  expect(opened[0]!.stopped).toBe(false);
});

test("a watch that ended with an error opens again", () => {
  watchThread("h", "t", () => {})();
  opened[0]!.send({ type: "error", error: { code: 1, message: "gone" } } as ThreadMessage);
  watchThread("h", "t", () => {});
  expect(opened).toHaveLength(2);
});
