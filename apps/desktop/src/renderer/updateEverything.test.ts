// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";

import type { ConnectionState } from "../preload/bridge";
import { buildPlan, planItems, planSummary, selectPlans, type HostPlan } from "./updateEverything";

/** Each item as "host: name from → to". */
const lines = (plans: HostPlan[], app?: string) =>
  planItems(plans, app).map(
    (item) => `${item.host}: ${item.name} ${item.from ? `${item.from} → ` : ""}${item.to}`,
  );

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
  expect(lines(plans, APP)).toEqual([
    `studio: Parallax ${APP} → ${NEXT}`,
    `alvin: plxd ${APP} → ${NEXT}`,
    "alvin: Codex 0.162.0 → 0.163.0",
    "alvin: Claude Code 2.1.295 → 2.1.300",
  ]);
  expect(planSummary(plans)).toBe("2 servers and 2 providers");

  // Unticking the app and Codex leaves alvin's plxd and Claude Code.
  const chosen = selectPlans(
    plans,
    new Set(["server/tailnet:alvin", "provider/tailnet:alvin/claude"]),
  );
  expect(lines(chosen)).toEqual([
    `alvin: plxd ${APP} → ${NEXT}`,
    "alvin: Claude Code 2.1.295 → 2.1.300",
  ]);
  expect(selectPlans(plans, new Set())).toEqual([]);
});
