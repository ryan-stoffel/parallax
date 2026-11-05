import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { RECONNECT_TIMEOUT_MS } from "../../desktop/src/main/hostUpdate";
import type { ConnectionState } from "../../desktop/src/preload/bridge";
import { newestRelease, restarting, updateComputer, useComputerUpdate, type Release } from "./computerUpdate";

vi.mock("react", () => ({
  useEffect: () => {},
  useState: () => [undefined, () => {}],
  useSyncExternalStore: (_: unknown, read: () => unknown) => read(),
}));

const release = (version: string, prerelease: boolean, ...platforms: string[]): Release => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease,
  assets: platforms.map((platform) => ({ name: `parallax-plxd-${version}-${platform}` })),
});

test("the newest release is on the computer's channel and has a plxd for it", () => {
  const releases = [
    release("3.0.0-nightly", true, "linux-x64"),
    release("2.0.0-nightly", true, "mac-arm64", "win-x64.exe"),
    release("1.0.0", false, "mac-arm64", "linux-x64"),
  ];
  // A Mac's isn't built yet in the newest nightly, and macOS reports its version with its name.
  expect(newestRelease(releases, "1.0.0-nightly", "macOS 27.0", "aarch64")).toBe("2.0.0-nightly");
  expect(newestRelease(releases, "1.0.0-nightly", "linux", "x86_64")).toBe("3.0.0-nightly");
  expect(newestRelease(releases, "1.0.0-nightly", "windows", "x86_64")).toBe("2.0.0-nightly");
  expect(newestRelease(releases, "0.5.0", "linux", "x86_64")).toBe("1.0.0");
  // No plxd for an Intel Mac, so nothing to offer.
  expect(newestRelease(releases, "0.5.0", "macOS 15.0", "x86_64")).toBeUndefined();
});

const on = (plxd: string) => ({ status: "connected", plxd, capabilities: {} }) as ConnectionState;
const down: ConnectionState = { status: "connecting" };

let hear: (id: string, state: ConnectionState) => void;
let listening: number;
let last = 0;
/** A fresh computer, since an update outlives its screen and so a test. */
const computer = () => `computer-${++last}`;

beforeEach(() => {
  vi.useFakeTimers();
  listening = 0;
  vi.stubGlobal("window", {
    parallax: {
      onConnectionState: (listener: typeof hear) => {
        hear = listener;
        listening++;
        return () => void listening--;
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const answers = (restart: string, runningAgents = 0) =>
  vi.fn(async () => ({ result: { version: "2.0.0", restart, runningAgents, message: "" } })) as never;

test("an update restarts now, says so while plxd is down, and ends when it's back on the version", async () => {
  const host = computer();
  const send = answers("now");
  await updateComputer(host, "2.0.0", send);
  expect(send).toHaveBeenCalledWith("2.0.0", true);
  expect(useComputerUpdate(host)?.stage).toBe("restarting");
  hear(host, down);
  expect(restarting(host, false)).toBe(true);
  hear(host, on("2.0.0"));
  expect(useComputerUpdate(host)).toBeUndefined();
  expect(restarting(host, true)).toBe(false);
  expect(listening).toBe(0);
});

test("another computer's reconnect doesn't end it", async () => {
  const host = computer();
  await updateComputer(host, "2.0.0", answers("now"));
  hear("other", on("2.0.0"));
  expect(useComputerUpdate(host)?.stage).toBe("restarting");
});

test("coming back on the old plxd, or not at all in time, fails", async () => {
  const old = computer();
  await updateComputer(old, "2.0.0", answers("now"));
  hear(old, on("1.0.0"));
  expect(useComputerUpdate(old)).toMatchObject({ stage: "failed", version: "2.0.0" });
  expect(restarting(old, false)).toBe(false);

  const gone = computer();
  await updateComputer(gone, "2.0.0", answers("now"));
  vi.advanceTimersByTime(RECONNECT_TIMEOUT_MS);
  expect(useComputerUpdate(gone)).toMatchObject({ stage: "failed" });
  expect(listening).toBe(0);
});

test("a plxd's refusal fails with its reason, and Retry can run again", async () => {
  const host = computer();
  await updateComputer(host, "2.0.0", vi.fn(async () => ({ error: { code: 1, message: "a development build" } })) as never);
  expect(useComputerUpdate(host)).toEqual({ stage: "failed", version: "2.0.0", error: "a development build" });
  await updateComputer(host, "2.0.0", answers("upToDate"));
  expect(useComputerUpdate(host)).toBeUndefined();
});

test("a plxd too old for now waits for its threads, through a reconnect on the old plxd", async () => {
  const host = computer();
  await updateComputer(host, "2.0.0", answers("afterRuns", 2));
  expect(useComputerUpdate(host)).toEqual({ stage: "waiting", version: "2.0.0", running: 2 });
  expect(restarting(host, true)).toBe(false);
  hear(host, on("1.0.0"));
  expect(useComputerUpdate(host)?.stage).toBe("waiting");
  hear(host, on("2.0.0"));
  expect(useComputerUpdate(host)).toBeUndefined();
});

test("a second tap while one runs sends nothing", async () => {
  const host = computer();
  await updateComputer(host, "2.0.0", answers("now"));
  const again = answers("now");
  await updateComputer(host, "2.0.0", again);
  expect(again).not.toHaveBeenCalled();
});
