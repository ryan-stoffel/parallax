import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {} }));

const { activeEvent, enabled, promptEvent, promptKind, reportTokens, tokenEvents } =
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

const now = Date.parse("2026-11-03T19:30:00Z");
const since = "2026-11-03T18:00:00.000Z";
const history = {
  hours: [hour("2026-11-03T18:00:00Z", "claude", 1), hour("2026-11-03T19:00:00Z", "claude", 2)],
  runs: [],
};

test("each whole hour is reported once, and the hour in progress waits", async () => {
  const send = vi.fn(async () => true);
  const next = await reportTokens(since, now, async () => history, send);
  expect(send).toHaveBeenCalledWith([history.hours[0]]);
  expect(next).toBe("2026-11-03T19:00:00.000Z");
});

test("hours stay unreported when plxd can't answer or the send fails", async () => {
  const send = vi.fn(async () => false);
  expect(await reportTokens(since, now, async () => undefined, send)).toBe(since);
  expect(send).not.toHaveBeenCalled();
  expect(await reportTokens(since, now, async () => history, send)).toBe(since);
});
