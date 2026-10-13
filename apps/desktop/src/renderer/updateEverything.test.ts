import { expect, test } from "vite-plus/test";

import type { ConnectionState } from "../preload/bridge";
import { buildPlan, planLine, planSummary } from "./updateEverything";

const APP = "2610.10912.13045-nightly";
const NEXT = "2610.11001.10000-nightly";

const connected = (plxd: string, current = true): ConnectionState => ({
  status: "connected",
  plxd,
  protocol: 1,
  capabilities: current ? { hostUpdate: {}, providerUpdates: {} } : { hostUpdate: {} },
});

const hosts = [
  { id: "local", name: "studio" },
  { id: "tailnet:alvin", name: "alvin" },
  { id: "tailnet:current", name: "current" },
  { id: "tailnet:old", name: "old" },
  { id: "tailnet:offline", name: "offline" },
];

test("the plan lists each host's updates, as T3 Code's dialog does", () => {
  const plans = buildPlan(
    hosts,
    {
      local: connected(APP),
      "tailnet:alvin": connected(APP),
      "tailnet:current": connected(NEXT),
      // Too old for host/update's `now`: Update everything leaves it to the usual updater.
      "tailnet:old": connected("0.1.0", false),
      "tailnet:offline": { status: "connecting" } as ConnectionState,
    },
    {
      "tailnet:alvin": [
        { cli: "codex", version: "0.162.0", latest: "0.163.0" },
        { cli: "claude", version: "2.1.295", latest: "2.1.300" },
      ],
      "tailnet:offline": [{ cli: "codex", version: "0.162.0", latest: "0.163.0" }],
    },
    NEXT,
    NEXT,
  );
  expect(plans.map(planLine)).toEqual([
    `studio: desktop app to ${NEXT}`,
    `alvin: server to ${NEXT}, Codex, Claude`,
  ]);
  expect(planSummary(plans)).toBe("2 servers and 2 providers");
});

test("without an app release, servers go to the app's own version", () => {
  const plans = buildPlan(
    hosts.slice(0, 2),
    { local: connected(APP), "tailnet:alvin": connected("2610.10900.10000-nightly") },
    { local: [{ cli: "codex", version: "0.162.0", latest: "0.163.0" }] },
    APP,
    undefined,
  );
  expect(plans.map(planLine)).toEqual(["studio: Codex", `alvin: server to ${APP}`]);
  expect(planSummary(plans)).toBe("1 server and 1 provider");
});
