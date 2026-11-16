import { expect, test, vi } from "vitest";

let saved = "[]";
vi.mock("../modules/thread-status", () => ({
  ThreadWidget: { read: () => saved, show: (threads: string) => void (saved = threads), clear: () => void (saved = "[]") },
}));
const posted = new Map<string, string>();
vi.mock("expo-notifications", () => ({
  AndroidImportance: { LOW: 2 },
  setNotificationChannelAsync: async () => {},
  scheduleNotificationAsync: async ({ identifier, content }: { identifier: string; content: { title: string } }) =>
    void posted.set(identifier, content.title),
  dismissNotificationAsync: async (id: string) => void posted.delete(id),
}));
vi.mock("i18next", () => ({
  t: (key: string, o?: { count: number }) =>
    o ? key.replace("{{count}}", String(o.count)).replace("need you", o.count === 1 ? "needs you" : "need you") : key,
}));

const { forgetThreads, keepPush, keepSeen, RUNNING } = await import("./androidThreads");

const now = Date.now();
const entry = (run: string, state: "needsYou" | "working" | "done") => ({
  run,
  host: "account:one",
  title: run,
  state,
  at: now,
  link: `parallax://thread/account:one/${run}`,
});

test("the app and a push at once both land, and the ongoing notification counts only what's going", async () => {
  await Promise.all([
    keepSeen({ seen: [entry("a", "working"), entry("b", "working")], connected: ["account:one"] }),
    keepPush({ hostId: "two", run: "c", state: "needsYou" }, "Ship it"),
  ]);
  expect((JSON.parse(saved) as { run: string }[]).map((e) => e.run)).toEqual(["c", "a", "b"]);
  expect(posted.get(RUNNING)).toBe("1 needs you, 2 working");

  await keepSeen({ seen: [entry("a", "done"), entry("b", "done")], connected: ["account:one"] });
  expect(posted.get(RUNNING)).toBe("1 needs you");
  await keepPush({ hostId: "two", run: "c", state: "done" }, "Ship it");
  expect(posted.has(RUNNING)).toBe(false);
});

test("signing out empties the widget and takes the ongoing notification away", async () => {
  await keepSeen({ seen: [entry("a", "working")], connected: ["account:one"] });
  await forgetThreads();
  expect(saved).toBe("[]");
  expect(posted.has(RUNNING)).toBe(false);
});
