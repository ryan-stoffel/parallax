// The connection log's lines, the same on the desktop (`main/connectionLogFile.ts`) and the phone
// (`apps/mobile/src/connectionLog.ts`). One line per event, with stable names, so disconnects per
// day can be counted by reason and route:
//
//   2026-11-04T19:25:59.123Z client_disconnect host="mini" route=relay reason=transport_closed lived_ms=660123 exit=1 relay_code=4409 relay_reason="replaced"
//   2026-11-04T19:26:01.123Z client_connect host="mini" route=lan plxd="2611.10419.1" attempts=2 down_ms=2000 last_reason=transport_closed plxd_restarted=false
//
// `client_disconnect` is a connection that was up and went. `reason` is a `DisconnectReason`, and
// `route` is relay, lan, tailnet, local, ssh, or unknown. `exit`, `signal`, and the `relay_` fields
// appear only when there's one.
//
// `client_connect` is each connection coming up. `down_ms` and `last_reason` say how long the last
// disconnect lasted and why, and are absent on the first connection. `attempts` counts the tries it
// took. `plxd_restarted` says plxd's `startId` changed since the last connection, and is absent
// when either plxd sent none. A disconnect can't know that yet, so it's on this line.
//
// `host` is the computer's name, or for ssh its destination, which can be `user@host`. No other
// field holds an address, and none holds a token or a relay id: a route is only its kind.

/** Why a connection that was up ended. */
export type DisconnectReason =
  /** Nothing arrived within 10 s of a heartbeat. */
  | "liveness_timeout"
  /** `plxd attach`, `plxd dial`, or the socket ended. */
  | "transport_closed"
  | "protocol_error"
  /** The app moved it to a better route (0091). */
  | "better_route"
  /** The user's edit took the route it was on off the computer's list. */
  | "route_removed"
  /** This device made a new key, so it signs in again. */
  | "new_device_key"
  /** The app ended it: it quit, or the computer was removed or replaced. */
  | "app_closed"
  | "not_found"
  | "incompatible_protocol"
  | "ssh_setup"
  | "refused";

export type LogFields = Record<string, string | number | boolean | undefined>;

/** One line: the time, the event, then its fields, with text quoted so it can't start a line. */
export function logLine(at: number, event: string, fields: LogFields): string {
  const parts = Object.entries(fields).flatMap(([name, value]) => {
    if (value === undefined) return [];
    const plain = typeof value !== "string" || /^[\w.:-]+$/.test(value);
    return [`${name}=${plain ? value : JSON.stringify(value)}`];
  });
  return [new Date(at).toISOString(), event, ...parts].join(" ");
}

/** A route's kind: `relay:<hostId>`, or an address, which is never logged itself. */
export function routeKind(route: string): "relay" | "local" | "tailnet" | "lan" {
  if (route.startsWith("relay:")) return "relay";
  const host = route.replace(/^\[/, "").replace(/\]?(:\d+)?$/, "");
  if (host === "::1" || host === "localhost" || host.startsWith("127.")) return "local";
  if (host.endsWith(".ts.net") || host.toLowerCase().startsWith("fd7a:115c:a1e0:"))
    return "tailnet";
  const [a, b] = host.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b < 128 ? "tailnet" : "lan";
}

/** What `plxd dial` printed about how the relay ended its stream (`StreamEnd` in relay.rs). */
export function relayEnd(stderr: string): LogFields {
  const line = /^plxd dial: relay stream ended (.*)/m.exec(stderr)?.[1] ?? "";
  return {
    relay_code: /^code=(\d+)/.exec(line)?.[1],
    relay_reason: /^(?:code=\d+ )?reason="([^"]*)"/.exec(line)?.[1],
    relay_error: /^error="([^"]*)"/.exec(line)?.[1],
  };
}

/** One host's connection events, written as lines to `write`. */
export class ConnectionLog {
  /** The route's kind now. Whoever opens the connection keeps it current. */
  route: string;
  /** More fields for the next disconnect, read when it happens. */
  detail?: () => LogFields;
  private connectedAt?: number;
  private downSince?: number;
  private lastReason?: DisconnectReason;
  private attempts = 0;
  private override?: DisconnectReason;
  private startId?: string;

  constructor(
    private readonly write: (line: string) => void,
    private readonly host: string,
    route = "unknown",
    private readonly now: () => number = Date.now,
  ) {
    this.route = route;
  }

  /** A try at connecting started. */
  attempt(): void {
    this.attempts++;
  }

  /** The next disconnect is for `reason`, whatever ends it, as when the app moves a route. */
  expect(reason: DisconnectReason): void {
    this.override = reason;
  }

  /** The connection came up, to the run of plxd that `startId` names. */
  connected(plxd: string, startId?: string): void {
    const at = this.now();
    const fields: LogFields = {
      host: this.host,
      route: this.route,
      plxd,
      attempts: this.attempts,
    };
    const { downSince, lastReason, startId: lastStartId } = this;
    this.startId = startId;
    this.connectedAt = at;
    this.downSince = undefined;
    this.lastReason = undefined;
    this.attempts = 0;
    if (downSince === undefined) return this.write(logLine(at, "client_connect", fields));
    this.write(
      logLine(at, "client_connect", {
        ...fields,
        down_ms: at - downSince,
        last_reason: lastReason,
        plxd_restarted:
          startId === undefined || lastStartId === undefined ? undefined : startId !== lastStartId,
      }),
    );
  }

  /** The connection ended. Does nothing unless it was up, so a failed try is no disconnect. */
  disconnected(reason: DisconnectReason, fields: LogFields = {}): void {
    if (this.connectedAt === undefined) return;
    const at = this.now();
    const why = this.override ?? reason;
    this.write(
      logLine(at, "client_disconnect", {
        host: this.host,
        route: this.route,
        reason: why,
        lived_ms: at - this.connectedAt,
        ...fields,
        ...this.detail?.(),
      }),
    );
    this.connectedAt = undefined;
    this.downSince = at;
    this.lastReason = why;
    this.attempts = 0;
    this.override = undefined;
  }
}
