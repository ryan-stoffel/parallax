import { expect, test } from "vite-plus/test";

import { ConnectionLog, logLine, relayEnd, routeKind } from "./connectionLog";

const T0 = Date.parse("2026-11-04T00:00:00.000Z");

/** A log for host "mini" whose clock the test sets, and the lines it wrote without their times. */
function logged(route?: string) {
  let now = T0;
  const lines: string[] = [];
  const log = new ConnectionLog(
    (line) => lines.push(line.slice(25)),
    "mini",
    route,
    () => now,
  );
  return { log, lines, at: (ms: number) => (now = T0 + ms) };
}

test("a line quotes text, so it can't start another, and leaves out what's absent", () => {
  expect(
    logLine(T0, "e", { a: "plain-1.2", b: 'two\nlines "x"', c: 4, d: undefined, f: false }),
  ).toBe(`2026-11-04T00:00:00.000Z e a=plain-1.2 b="two\\nlines \\"x\\"" c=4 f=false`);
});

test.each([
  ["relay:abc123", "relay"],
  ["192.168.1.5:7341", "lan"],
  ["10.0.0.2", "lan"],
  ["100.64.0.7:7341", "tailnet"],
  ["100.128.0.7:7341", "lan"],
  ["mini.tail123.ts.net:7341", "tailnet"],
  ["[fd7a:115c:a1e0::1]:7341", "tailnet"],
  ["127.0.0.1:7341", "local"],
  ["[::1]:7341", "local"],
])("route %s is %s", (route, kind) => {
  expect(routeKind(route)).toBe(kind);
});

test("reads how plxd dial said the relay ended its stream", () => {
  const stderr = `plxd dial: connected over relay:abc\nplxd dial: relay stream ended code=4409 reason="replaced"\n`;
  expect(relayEnd(stderr)).toMatchObject({ relay_code: "4409", relay_reason: "replaced" });
  expect(relayEnd(`plxd dial: relay stream ended error="reset"\n`)["relay_error"]).toBe("reset");
  expect(relayEnd("plxd dial: connected over 10.0.0.2:7341\n")["relay_code"]).toBeUndefined();
  // Text the relay or a transport chose is read only as what it is.
  const error = relayEnd(`plxd dial: relay stream ended error="code=5 reason=\\"x\\""\n`);
  expect(error["relay_code"]).toBeUndefined();
  expect(error["relay_reason"]).toBeUndefined();
  expect(relayEnd(`relay stream ended code=5 reason="x"\n`)["relay_code"]).toBeUndefined();
});

test("a disconnect and the reconnect after it log the reason, the route, and the downtime", async () => {
  const { log, lines, at } = logged("relay");
  log.attempt();
  log.connected("1.0", "run-1");
  at(60_000);
  log.disconnected("transport_closed", { exit: 1, relay_code: "4409", relay_reason: "replaced" });
  log.attempt();
  log.attempt();
  at(63_000);
  log.route = "lan";
  log.connected("1.0", "run-1");
  expect(lines).toEqual([
    `client_connect host=mini route=relay plxd=1.0 attempts=1`,
    `client_disconnect host=mini route=relay reason=transport_closed lived_ms=60000 exit=1 relay_code=4409 relay_reason=replaced`,
    `client_connect host=mini route=lan plxd=1.0 attempts=2 down_ms=3000 last_reason=transport_closed plxd_restarted=false`,
  ]);
});

// Neither clock decides: plxd's uptime stops while its computer sleeps, and a client that slept
// sees a short outage whatever happened while it was away.
test.each([
  ["a long sleep, with the same plxd", 8 * 3_600_000, "run-1", false],
  ["a brief drop, with a new plxd", 1_000, "run-2", true],
])("%s", (_name, downMs, startId, restarted) => {
  const { log, lines, at } = logged();
  log.connected("1.0", "run-1");
  log.disconnected("transport_closed");
  at(downMs);
  log.connected("1.0", startId);
  expect(lines.at(-1)).toContain(`plxd_restarted=${restarted}`);
});

test("a plxd with no start id leaves out whether it restarted, but still logs the reconnect", () => {
  const { log, lines } = logged();
  log.connected("1.0");
  log.disconnected("liveness_timeout");
  log.connected("1.0", "run-1");
  expect(lines.at(-1)).toContain("last_reason=liveness_timeout");
  expect(lines.at(-1)).not.toContain("plxd_restarted");
});

test("a failed try is no disconnect, and each disconnect logs once", () => {
  const { log, lines } = logged();
  log.disconnected("transport_closed");
  expect(lines).toEqual([]);
  log.connected("1.0");
  log.disconnected("liveness_timeout");
  log.disconnected("transport_closed");
  expect(lines.filter((line) => line.startsWith("client_disconnect"))).toHaveLength(1);
});

test("an expected reason wins over how the socket then ends, once", () => {
  const { log, lines } = logged();
  log.connected("1.0");
  log.expect("better_route");
  log.disconnected("transport_closed");
  expect(lines.at(-1)).toContain("reason=better_route");
  log.connected("1.0");
  log.disconnected("transport_closed");
  expect(lines.at(-1)).toContain("reason=transport_closed");
});
