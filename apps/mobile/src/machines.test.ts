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
    constructor() {
      made.push(this);
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
