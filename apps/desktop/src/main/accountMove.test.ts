import { expect, test } from "vite-plus/test";

import type { AccountMove } from "../preload/bridge";
import { moveComputers, type Movable } from "./accountMove";

const tokens = { token: "production", from: "development" };
const moved = { result: {}, logId: "1" };
const refused = (message: string) => ({ error: { code: -32603, message } });

test("each reachable computer moves, and the rest wait for the next try, as the windows see it", async () => {
  const asked: { token: string; from: string }[] = [];
  let finishOld: (() => void) | undefined;
  const computers: Movable[] = [
    { hostId: "a", name: "MacBook Pro", move: async (params) => (asked.push(params), moved) },
    // A relay without the move, or a plxd from before it, answers an error: it waits.
    {
      hostId: "b",
      name: "Mac mini",
      move: () =>
        new Promise((resolve) => {
          finishOld = () => resolve(refused("The relay can't move computers yet."));
        }),
    },
    // Not reached by this app.
    { hostId: "c", name: "Windows laptop" },
    { hostId: "d", name: "Linux box", move: () => Promise.reject(new Error("closed")) },
  ];
  const shown: AccountMove[] = [];
  const running = moveComputers(computers, tokens, ["Old laptop"], (move) => shown.push(move));
  expect(shown[0]).toEqual({
    signedIn: true,
    moved: ["Old laptop"],
    moving: ["MacBook Pro", "Mac mini", "Linux box"],
    waiting: ["Windows laptop"],
    done: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishOld!();
  expect(await running).toEqual(["a"]);
  expect(asked).toEqual([tokens]);
  expect(shown.at(-1)).toEqual({
    signedIn: true,
    moved: ["Old laptop", "MacBook Pro"],
    moving: [],
    waiting: ["Windows laptop", "Linux box", "Mac mini"],
    done: false,
  });
});
