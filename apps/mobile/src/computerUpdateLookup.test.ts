import { afterEach, expect, test, vi } from "vitest";

import { restartCutsOff, sameChannel, useNewestVersion } from "./computerUpdate";
import { begin } from "./fakeReact";

vi.mock("react", async (actual) => ({
  ...(await actual<typeof import("react")>()),
  ...(await import("./fakeReact")).hooks,
}));

afterEach(() => vi.unstubAllGlobals());

const nightly = {
  tag_name: "v2.0.0-nightly",
  draft: false,
  prerelease: true,
  assets: [{ name: "parallax-plxd-2.0.0-nightly-linux-x64" }],
};

/** One render, then whatever its lookup answers, then the next render's answer. */
async function settled(id: string, plxd: string) {
  begin();
  const first = useNewestVersion(id, plxd);
  await vi.waitFor(() => new Promise((done) => setTimeout(done)));
  begin();
  return { first, then: useNewestVersion(id, plxd) };
}

test("a target from one channel doesn't survive a reconnect on the other when the lookup fails", async () => {
  vi.stubGlobal("window", {
    parallax: { request: async () => ({ result: { os: "linux", arch: "x86_64" } }) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/latest") ? { ok: false, status: 503 } : { ok: true, json: async () => [nightly] },
    ),
  );
  expect((await settled("host", "1.0.0-nightly")).then).toBe("2.0.0-nightly");

  // Stable now, and GitHub doesn't answer: nothing to offer, not even for the first render.
  expect(await settled("host", "0.5.0")).toEqual({ first: undefined, then: undefined });

  // Back on nightly and the computer doesn't answer: the old target is gone too.
  vi.stubGlobal("window", { parallax: { request: vi.fn(async () => Promise.reject(new Error("down"))) } });
  expect((await settled("host", "1.0.0-nightly")).then).toBeUndefined();
});

test("an unanswered health check counts as threads that may be running", async () => {
  const answering = (answer: unknown) => vi.stubGlobal("window", { parallax: { request: async () => answer } });
  answering({ result: { runningAgents: 0 } });
  expect(await restartCutsOff("host")).toBeUndefined();
  answering({ result: { runningAgents: 2 } });
  expect(await restartCutsOff("host")).toBe("2 running threads");
  answering({ error: { code: 1, message: "not connected" } });
  expect(await restartCutsOff("host")).toBe("any running threads");
});

test("a retry stays on the computer's channel", () => {
  expect(sameChannel("1.0.0-nightly", "2.0.0-nightly")).toBe(true);
  expect(sameChannel("1.0.0", "2.0.0")).toBe(true);
  expect(sameChannel("1.0.0", "2.0.0-nightly")).toBe(false);
});
