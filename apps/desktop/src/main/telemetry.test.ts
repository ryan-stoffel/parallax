import { expect, test, vi } from "vite-plus/test";

import type { UsageHour } from "../protocol/generated/protocol";

vi.mock("electron", () => ({ app: {} }));

const { accountHash, activeEvent, enabled, promptEvent, promptKind, reportTokens, tokenEvents } =
  await import("./telemetry");

const install = {
  id: "id-1",
  version: "2610.10205.13230-nightly",
  platform: "darwin",
  arch: "arm64",
};

test("app_active names the install, its build, and its OS, and keeps no person profile", () => {
  expect(activeEvent("phc_key", install)).toEqual({
    api_key: "phc_key",
    event: "app_active",
    distinct_id: "id-1",
    properties: {
      $process_person_profile: false,
      $geoip_disable: true,
      signed_in: false,
      version: "2610.10205.13230-nightly",
      channel: "nightly",
      os: "darwin",
      arch: "arm64",
    },
  });
  expect(
    activeEvent("phc_key", { ...install, version: "2610.10205.13230" })?.properties.channel,
  ).toBe("stable");
});

test("a signed-in install's events go under its account's hash, the same on every device", () => {
  const account = accountHash("user_2abc");
  expect(account).toMatch(/^[0-9a-f]{64}$/);
  const laptop = activeEvent("phc_key", { ...install, account });
  const desktop = promptEvent("phc_key", { ...install, id: "id-2", account }, "follow_up");
  expect(laptop.distinct_id).toBe(account);
  expect(desktop.distinct_id).toBe(account);
  expect(laptop.properties.signed_in).toBe(true);
  expect(JSON.stringify([laptop, desktop])).not.toContain("user_2abc");
});

test("nothing is sent without a key or with DO_NOT_TRACK set", () => {
  expect(enabled("", {})).toBe(false);
  expect(enabled("phc_key", { DO_NOT_TRACK: "1" })).toBe(false);
  expect(enabled("phc_key", { DO_NOT_TRACK: "0" })).toBe(true);
  expect(enabled("phc_key", {})).toBe(true);
});

test("only requests that send a prompt count, and the event carries no text", () => {
  expect(promptKind("thread/start", { prompt: "secret" })).toBe("new_thread");
  expect(promptKind("orchestrator/start", {})).toBe("new_thread");
  expect(promptKind("agent/send", { text: "secret" })).toBe("follow_up");
  expect(promptKind("orchestration/dispatch", { type: "message.dispatch" })).toBe("follow_up");
  expect(promptKind("orchestration/dispatch", { type: "run.interrupt" })).toBeUndefined();
  expect(promptKind("thread/list", {})).toBeUndefined();
  expect(JSON.stringify(promptEvent("phc_key", install, "follow_up"))).not.toContain("secret");
});

const hour = (at: string, accountId: string, tokens: number, costUsdMicros?: number) => ({
  hour: at,
  accountId,
  model: "opus",
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
  ...(costUsdMicros !== undefined && { costUsdMicros }),
});

test("tokens_used sums accounts away per hour and model, timed at the hour", () => {
  const events = tokenEvents("phc_key", install, [
    hour("2026-11-03T18:00:00Z", "claude", 1, 500_000),
    hour("2026-11-03T18:00:00Z", "key-with-a-name", 2),
    hour("2026-11-03T19:00:00Z", "claude", 4),
  ]);
  expect(events.map((e) => [e.timestamp, e.properties])).toEqual([
    [
      "2026-11-03T18:00:00Z",
      expect.objectContaining({
        model: "opus",
        input_tokens: 3,
        total_tokens: 12,
        cost_usd: 0.5,
      }),
    ],
    ["2026-11-03T19:00:00Z", expect.not.objectContaining({ cost_usd: expect.anything() })],
  ]);
  expect(JSON.stringify(events)).not.toContain("key-with-a-name");
});

const claim = (...hours: UsageHour[]) => ({
  since: "2026-11-03T18:00:00Z",
  until: "2026-11-03T19:00:00Z",
  hours,
});
const first = hour("2026-11-03T18:00:00Z", "claude", 1);
const second = hour("2026-11-03T18:00:00Z", "codex", 2);

test("each computer's claimed hours are sent, and one with nothing or no answer is skipped", async () => {
  const claims: Record<string, ReturnType<typeof claim> | undefined> = {
    local: claim(first),
    "account:empty": claim(),
    "account:old-plxd": undefined,
    "account:mini": claim(second),
  };
  const release = vi.fn(async () => {});
  const send = vi.fn(async () => true);
  await reportTokens(
    { hosts: () => Object.keys(claims), claim: async (id) => claims[id], release },
    send,
  );
  expect(send.mock.calls).toEqual([[[first]], [[second]]]);
  expect(release).not.toHaveBeenCalled();
});

test("a failed send gives only its computer's claim back", async () => {
  const claims: Record<string, ReturnType<typeof claim>> = {
    local: claim(first),
    "account:mini": claim(second),
  };
  const release = vi.fn(async () => {});
  const send = vi.fn(async (hours: UsageHour[]) => {
    if (hours[0] === first) throw new Error("offline");
    return true;
  });
  await reportTokens(
    { hosts: () => Object.keys(claims), claim: async (id) => claims[id]!, release },
    send,
  );
  expect(release.mock.calls).toEqual([["local", claims["local"]]]);
});
