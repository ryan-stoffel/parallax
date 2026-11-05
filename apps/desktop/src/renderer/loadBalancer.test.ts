// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";

import type { ProviderInfo } from "../protocol/generated/protocol";
import { assess, canTake, pickComputer, tiesOf, type Candidate } from "./loadBalancer";

const provider = (id: string, more: Partial<ProviderInfo> = {}) =>
  ({
    instance: { id, kind: id, name: id, enabled: true },
    installed: true,
    signedIn: true,
    ...more,
  }) as ProviderInfo;

const computer = (
  id: string,
  { cpu = 0, memory = 0, cores = 8, runningAgents = 0 } = {},
  more: Partial<Candidate> = {},
): Candidate => ({
  id,
  preference: "normal",
  health: { runningAgents, load: { cpu, memory, cores } },
  providers: [provider("claude")],
  ...more,
});

test("a bigger computer takes more, running agents count, and preference weighs in", () => {
  // Same load, so cores decide.
  expect(pickComputer([computer("small", { cores: 4 }), computer("big", { cores: 16 })])).toBe(
    "big",
  );
  // 8 * 0.9 * 0.9 / 2 = 3.24 loses to 8 * 0.5 * 0.9 = 3.6: an idle CPU doesn't hide an agent.
  expect(
    pickComputer([
      computer("one agent", { cpu: 10, memory: 10, runningAgents: 1 }),
      computer("busy", { cpu: 50, memory: 10 }),
    ]),
  ).toBe("busy");
  // CPU and memory multiply: 0.6 * 0.6 = 0.36 loses to 0.7 * 0.7 = 0.49, though 40 is the lower max.
  expect(
    pickComputer([
      computer("lower max", { cpu: 40, memory: 40 }),
      computer("spread", { cpu: 30, memory: 30 }),
    ]),
  ).toBe("spread");
  // 100 * 8 * 0.5 = 400 beats 50 * 8 * 0.9 = 360, and 25 * 8 * 0.9 = 180.
  expect(
    pickComputer([
      computer("normal", { cpu: 10 }),
      computer("prefer", { cpu: 50 }, { preference: "prefer" }),
      computer("less", { cpu: 10 }, { preference: "less" }),
    ]),
  ).toBe("prefer");
});

test("a computer is full at 95% of CPU or memory, and not before", () => {
  expect(assess(computer("cpu", { cpu: 95 }))).toEqual({ why: "full" });
  expect(assess(computer("memory", { memory: 95 }))).toEqual({ why: "full" });
  expect(assess(computer("under", { cpu: 94, memory: 94 }))).toHaveProperty("score");
});

test("only a computer that can run the thread is eligible", () => {
  const { health, providers } = computer("x");
  const why = (more: Partial<Candidate>) => assess({ ...computer("x"), ...more });
  expect(why({ barred: "left-out" })).toEqual({ why: "left-out" });
  expect(why({ barred: "no-repository" })).toEqual({ why: "no-repository" });
  expect(why({ health: undefined })).toEqual({ why: "no-answer" });
  // An older plxd isn't idle: nothing says it has room.
  expect(why({ health: { runningAgents: 0 } })).toEqual({ why: "needs-update" });
  expect(why({ providers: undefined })).toEqual({ why: "no-answer" });
  expect(why({ provider: "codex" })).toEqual({ why: "no-provider" });
  expect(why({ health, providers, provider: "claude" })).toHaveProperty("score");
  expect(
    pickComputer([
      computer("left", {}, { barred: "left-out" }),
      computer("silent", {}, { health: undefined }),
    ]),
  ).toBeUndefined();
});

test("a provider it can't run doesn't count: off, not installed, signed out, or refused for its plan", () => {
  expect(canTake([provider("claude")], "claude")).toBe(true);
  expect(canTake([provider("claude")], "codex")).toBe(false);
  expect(canTake([provider("claude", { signedIn: undefined })], "claude")).toBe(true);
  const unusable = [
    provider("a", { instance: { id: "a", kind: "a", name: "a", enabled: false } as never }),
    provider("b", { installed: false }),
    provider("c", { signedIn: false }),
    provider("d", { note: "[plan_required] upgrade" }),
  ];
  // With none chosen, any it can run will do, and none of these can.
  expect(canTake(unusable)).toBe(false);
  expect(canTake([...unusable, provider("e")])).toBe(true);
});

const doc = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });

test("a draft is pinned by threads and files from this computer, and not by another's thread", () => {
  expect(tiesOf(undefined)).toEqual({ named: [] });
  expect(tiesOf({ doc: doc({ type: "text", text: "hi" }), threads: [] }).pinned).toBeUndefined();
  expect(tiesOf({ doc: doc(), threads: ["run"] }).pinned).toBe("threads");
  expect(
    tiesOf({ doc: doc({ type: "threadRef", attrs: { runId: "run", title: "t" } }), threads: [] })
      .pinned,
  ).toBe("threads");
  expect(
    tiesOf({ doc: doc({ type: "mention", attrs: { token: "@src/a.ts" } }), threads: [] }).pinned,
  ).toBe("files");
  // A skill isn't tied to the computer.
  expect(
    tiesOf({ doc: doc({ type: "mention", attrs: { token: "/review" } }), threads: [] }).pinned,
  ).toBeUndefined();
  // A thread on another computer is a reference, but the draft can't move onto what it names.
  expect(
    tiesOf({
      doc: doc(
        { type: "remoteThreadRef", attrs: { computer: "box", runId: "r", title: "t" } },
        { type: "computerRef", attrs: { computer: "mini", name: "mini" } },
      ),
      threads: [],
    }),
  ).toEqual({ pinned: undefined, named: ["box", "mini"] });
});
