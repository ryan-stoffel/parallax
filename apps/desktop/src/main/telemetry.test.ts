import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {} }));

const { activeEvent } = await import("./telemetry");

const install = {
  id: "id-1",
  version: "2610.10205.13230-nightly",
  platform: "darwin",
  arch: "arm64",
};

test("app_active names the install, its build, and its OS, and keeps no person profile", () => {
  expect(activeEvent("phc_key", install, {})).toEqual({
    api_key: "phc_key",
    event: "app_active",
    distinct_id: "id-1",
    properties: {
      $process_person_profile: false,
      version: "2610.10205.13230-nightly",
      channel: "nightly",
      os: "darwin",
      arch: "arm64",
    },
  });
  expect(
    activeEvent("phc_key", { ...install, version: "2610.10205.13230" }, {})?.properties.channel,
  ).toBe("stable");
});

test("nothing is sent without a key or with DO_NOT_TRACK set", () => {
  expect(activeEvent("", install, {})).toBeUndefined();
  expect(activeEvent("phc_key", install, { DO_NOT_TRACK: "1" })).toBeUndefined();
  expect(activeEvent("phc_key", install, { DO_NOT_TRACK: "0" })).toBeDefined();
});
