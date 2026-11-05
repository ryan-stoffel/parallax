import { expect, test, vi } from "vitest";

import type { ConnectionState } from "../../desktop/src/preload/bridge";
import { onConnectionShown } from "../../desktop/src/renderer/ConnectionStatus";
import { Fleet, type Machine } from "./machines";

// A WebHost with no socket: as during a drop, closing it says nothing.
const { made, FakeHost } = vi.hoisted(() => {
  const made: InstanceType<typeof FakeHost>[] = [];
  class FakeHost {
    state: ConnectionState = { status: "connecting" };
    readonly stateListeners = new Set<(hostId: string, state: ConnectionState) => void>();
    retries = 0;
    constructor(readonly open: () => Promise<unknown>) {
      made.push(this);
    }
    retry() {
      this.retries++;
    }
    emit(state: ConnectionState) {
      this.state = state;
      for (const listener of this.stateListeners) listener("local", state);
    }
    connect() {
      this.emit({ status: "connecting" });
    }
    close() {}
  }
  return { made, FakeHost };
});

vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("../modules/pinned-tls", () => ({ privateFile: () => "", onNetwork: () => () => {} }));
vi.mock("./host", () => ({ loadSaved: async () => null, pairedSocket: async () => ({ error: "" }) }));
vi.mock("../../desktop/src/renderer/webBridge", () => ({ WebHost: FakeHost }));

const added = "studio.example.com:7400";
const lan = "192.168.1.20:7341";

/** An account computer connected over `route`, whose re-checks find `better`. */
async function onRoute(route: string, better?: string) {
  vi.stubGlobal("window", {});
  const socket = { close: vi.fn(), onclose: undefined };
  const recheck = vi.fn(async () => better);
  const hosts = {
    trusts: () => true,
    open: async () => ({ socket, route }),
    recheck,
  };
  const account = { hostId: "h", routes: [lan], addedRoutes: [added] };
  const m = { id: "account:h", name: "h", account } as Machine;
  const events = { hosts, learned: () => {}, gated: () => {} };
  const fleet = new Fleet(async () => {}, [m], events as never);
  const host = made.at(-1)!;
  await host.open();
  return { fleet, host, socket, recheck, account };
}

test("moving a route above the one in use checks it now, and reopens when it answers", async () => {
  const { fleet, host, socket, recheck, account } = await onRoute(lan, added);
  expect(fleet.route("account:h")).toBe(lan);
  const edited = { ...account, routeOrder: [added, lan, "relay:h"] };
  fleet.routesEdited("account:h", edited);
  expect(recheck).toHaveBeenCalledWith("h", expect.objectContaining(edited), lan, {});
  await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
  expect(host.retries).toBe(1);
  fleet.close();
});

test("removing the route in use reopens at once, with no check", async () => {
  const { fleet, host, socket, recheck, account } = await onRoute(added);
  fleet.routesEdited("account:h", { ...account, addedRoutes: [] });
  expect(socket.close).toHaveBeenCalled();
  expect(host.retries).toBe(1);
  expect(recheck).not.toHaveBeenCalled();
  fleet.close();
});

test("a computer removed during a hidden drop and restored is a first connect, shown at once", () => {
  vi.stubGlobal("window", {});
  const m = { id: "paired-a", name: "a", paired: {} } as unknown as Machine;
  const fleet = new Fleet(async () => {}, [m]);
  const shown: string[] = [];
  const stop = onConnectionShown((_, state) => shown.push(state.status));

  made.at(-1)!.emit({ status: "connected", plxd: "1", protocol: 1, capabilities: {} });
  made.at(-1)!.emit({ status: "connecting" });
  expect(shown).toEqual(["connected"]);

  fleet.remove(m.id);
  fleet.add(m);
  expect(shown).toEqual(["connected", "connecting"]);
  stop();
});
