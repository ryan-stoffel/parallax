// What every screen reads: each computer's connection, threads, and outbox, and the setup they
// came from. Each computer's threads come from the desktop's `useThreads`, one per computer.
//
// With the account signed in it also finds the account's computers on Parallax Relay (0091),
// when it starts, the app comes to the front, the network changes, and Settings opens, with no
// timer. It sets them up or asks to use them, asks the user to allow other devices that ask, and
// copies who's approved between the computers this phone uses.
import { File } from "expo-file-system";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AppState } from "react-native";

import type { ConnectionState } from "../../desktop/src/preload/bridge";
import { idleThreads, useThreads, type ThreadsView } from "../../desktop/src/renderer/threads";
import type { AccessState } from "../../desktop/src/protocol/generated/protocol";
import { onNetwork, privateFile } from "../modules/pinned-tls";
import { lacks, merged, type Lists } from "./access";
import { listHosts, type AccountHosts, type Gate, type Listed } from "./accountHosts";
import { askSetupCode, confirmDevice, showWaiting } from "./accountPrompts";
import { forget } from "./host";
import {
  accountId,
  computers,
  Fleet,
  merge,
  saveSetup,
  withListed,
  type Machine,
  type Setup,
} from "./machines";
import { Outbox, type Outgoing, type Sent } from "./outbox";

/** One computer as the screens see it. */
export interface Computer {
  machine: Machine;
  state: ConnectionState;
  connected: boolean;
  view: ThreadsView;
  outbox: Outbox;
  /** Why an account's computer isn't connecting, until it's set up or approved. */
  gate?: Gate;
}

interface FleetValue {
  computers: Computer[];
  defaultId?: string;
  setDefault: (id: string) => void;
  /** Adds computers found with `probe`, or a LAN-paired one. */
  add: (found: Machine[]) => void;
  remove: (id: string) => void;
  /** Lists the account's computers again. */
  discover: () => void;
  /** The account's computers removed from this phone, to add back. */
  removed: Listed[];
  /** Adds back an account's computer removed from this phone. */
  restore: (hostId: string) => void;
  /** Sets up a gated account computer: its code, or an approval from another device. */
  setUp: (id: string) => void;
  /** Unsent text, by thread. */
  drafts: Map<string, string>;
}

const FleetContext = createContext<FleetValue | null>(null);

export const useFleet = () => useContext(FleetContext)!;

/**
 * The default computer's id: `defaultId` while it's one of `machines`, else the first. A default
 * whose computer is gone, as a paired one whose session ended, doesn't hold a new one off.
 */
const defaultOf = (machines: Machine[], defaultId?: string) =>
  machines.some((m) => m.id === defaultId) ? defaultId : machines[0]?.id;

/** The computer with `id`, if the phone still has it. */
export const useComputer = (id: string) => useFleet().computers.find((c) => c.machine.id === id);

/** One computer's outbox, saved out of backups. */
function outboxFor(host: () => Fleet, id: string): Outbox {
  const file = new File(privateFile(`outbox-${id}.json`));
  let saved: Outgoing[] = [];
  try {
    if (file.exists) saved = JSON.parse(file.textSync()) as Outgoing[];
  } catch {}
  const box: Outbox = new Outbox(
    saved,
    send,
    (messages) => file.write(JSON.stringify(messages)),
    (m, error) => Alert.alert("Message not sent", `“${m.text}”: ${error.message}`),
  );
  async function send(m: Outgoing): Promise<Sent> {
    const connection = host().hosts.get(id);
    if (connection?.state.status !== "connected") return "offline";
    const answer = await connection.request("orchestration/dispatch", {
      type: "message.dispatch",
      threadId: m.threadId,
      messageId: m.id,
      commandId: m.id,
      text: m.text,
      ...(m.images?.length && { images: m.images }),
      ...(m.model !== undefined && { model: m.model }),
      ...(m.effort && { effort: m.effort }),
      ...(m.permission && { permission: m.permission }),
      ...(m.account && { account: m.account }),
      dispatchMode: { type: m.steer ? "steer_active" : "queue_after_active" },
    });
    if (!("error" in answer)) return "sent";
    // The connection dropped or the answer was lost: it waits, and goes again with its id, on
    // the next connection or, after a timeout, in a few seconds.
    if (connection.state.status !== "connected") return "offline";
    if (answer.error.code === -32800) {
      setTimeout(() => void box.drain(), 5_000);
      return "offline";
    }
    return { error: answer.error };
  }
  return box;
}

/** Reports one computer's threads up, so the provider holds every computer's. */
function Threads({
  id,
  state,
  onView,
}: {
  id: string;
  state: ConnectionState;
  onView: (id: string, view: ThreadsView) => void;
}) {
  const view = useThreads(id, state.status === "connected" ? state.capabilities : undefined, undefined, () => {});
  const latest = useRef(view);
  latest.current = view;
  useEffect(
    () => onView(id, latest.current),
    [id, onView, view.state, view.loading, view.error, view.capabilities],
  );
  return null;
}


export function FleetProvider({
  setup: initial,
  accounts,
  token,
  children,
}: {
  setup: Setup;
  /** The account's computers, while signed in. */
  accounts?: AccountHosts;
  /** The account's current access token. */
  token: () => Promise<string | undefined>;
  children: ReactNode;
}) {
  const [setup, setSetup] = useState(initial);
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [views, setViews] = useState<Record<string, ThreadsView>>({});
  const [gates, setGates] = useState<Record<string, Gate | undefined>>({});
  const [listed, setListed] = useState<Listed[]>([]);
  const [drafts] = useState(() => new Map<string, string>());
  /** Requests already shown, so each asks once. */
  const [asked] = useState(() => new Set<string>());
  /** The `tailnet:` computer each account computer replaces once it connects. */
  const [tailnetOf] = useState(() => new Map<string, string>());
  const fleetRef = useRef<Fleet>(null);
  const latest = useRef(setup);
  latest.current = setup;
  const gate = (id: string, next: Gate | undefined) =>
    setGates((g) => (JSON.stringify(g[id]) === JSON.stringify(next) ? g : { ...g, [id]: next }));
  const [fleet] = useState(() => {
    const made = new Fleet(
      async (m) => {
        // An account's computer that needs setting up, or refused this phone: its connection
        // ends, and connects again once it's set up.
        if (m.account) return fleetRef.current?.remove(m.id);
        // A LAN-paired computer revoked this phone: its connection ends, so pairing again
        // connects afresh under the same id.
        await forget();
        fleetRef.current?.remove(m.id);
        update((s) => ({ ...s, machines: s.machines.filter((x) => x.id !== m.id) }));
      },
      initial.machines,
      accounts && {
        hosts: accounts,
        learned: (id, routes, name) =>
          update((s) => {
            const machines = s.machines.map((m) =>
              m.id === id && m.account ? { ...m, name: name || m.name, account: { ...m.account, routes } } : m,
            );
            return JSON.stringify(machines) === JSON.stringify(s.machines) ? s : { ...s, machines };
          }),
        // A computer still waiting on another device keeps showing its code.
        gated: (id, next) =>
          setGates((g) => (next.kind === "setup" && g[id]?.kind === "waiting" ? g : { ...g, [id]: next })),
      },
    );
    fleetRef.current = made;
    return made;
  });
  const [outboxes] = useState(() => new Map<string, Outbox>());
  const outbox = (id: string) => {
    let box = outboxes.get(id);
    if (!box) outboxes.set(id, (box = outboxFor(() => fleetRef.current!, id)));
    return box;
  };

  function update(change: (s: Setup) => Setup) {
    setSetup((s) => {
      const next = change(s);
      if (next !== s) saveSetup(next);
      return next;
    });
  }

  /** Lists the account's computers on the relay, and adds new ones. */
  async function discover() {
    const bearer = accounts && (await token());
    const found = bearer && (await listHosts(bearer));
    if (!found) return;
    setListed(found);
    update((s) => {
      const machines = withListed(s.machines, found, s.hidden);
      return machines === s.machines ? s : { ...s, machines, defaultId: defaultOf(machines, s.defaultId) };
    });
  }

  /**
   * Copies who's approved between every connected computer that keeps it (0091), with the
   * computers this phone uses approved too, and trusts the computers they list.
   */
  async function share() {
    if (!accounts) return;
    const keepers = [...fleet.hosts.entries()].filter(
      ([, host]) => host.state.status === "connected" && "accountAccess" in host.state.capabilities,
    );
    const answers = await Promise.all(
      keepers.map(async ([id, host]) => ({ id, answer: await host.request("access/get", {}) })),
    );
    const lists = answers.flatMap(({ id, answer }) =>
      "error" in answer ? [] : [{ id, lists: answer.result as AccessState as Lists }],
    );
    if (!lists.length) return;
    const union = merged(lists.map((l) => l.lists), accounts.sessions);
    await accounts.trust(union.approvedHosts);
    for (const { id, lists: theirs } of lists)
      if (lacks(theirs, union)) void fleet.hosts.get(id)?.request("access/merge", union);
    // A computer one of them lists connects now.
    for (const m of latest.current.machines)
      if (m.account && accounts.trusts(m.account.hostId) && !fleet.hosts.has(m.id)) {
        gate(m.id, undefined);
        fleet.add(m);
      }
  }

  /**
   * Keeps one `access/get` call open with computer `id` while it's connected, and asks the user
   * to allow each new device that waits there, with its code.
   */
  function watchAccess(id: string) {
    let version: number | undefined;
    void (async () => {
      for (;;) {
        const host = fleet.hosts.get(id);
        if (host?.state.status !== "connected") return;
        const answer = await host.request("access/get", version === undefined ? {} : { after: version });
        if ("error" in answer) {
          // A wait past the request timeout comes back as one: wait again.
          if (answer.error.code === -32800) continue;
          return;
        }
        const state = answer.result as AccessState;
        version = state.version;
        const pending = state.pending;
        if (!pending?.code || asked.has(pending.id)) continue;
        asked.add(pending.id);
        const decide = (method: "access/approve" | "access/deny") =>
          void host.request(method, { request: pending.id }).then((done) => {
            if ("error" in done) Alert.alert("Couldn't answer the request", done.error.message);
            // Approved here, it's approved on every computer this phone uses.
            else if (method === "access/approve") void share();
          });
        confirmDevice(pending.name, pending.code, () => decide("access/approve"), () => decide("access/deny"));
      }
    })();
  }

  /**
   * Moves a computer reached over Tailscale (`tailnet:`) to its account connection (0091): it
   * names its host id, and approves this phone's key over the connection Tailscale vouches for,
   * so the move asks for no code. The Tailscale connection goes once the account one connects.
   */
  async function migrate(id: string) {
    const host = fleet.hosts.get(id);
    if (!accounts || !host) return;
    const answer = await host.request("relay/id", {});
    if ("error" in answer) return;
    const { hostId } = answer.result as { hostId: string };
    const approved = await host.request("access/merge", {
      approvedClients: [accounts.thumbprint],
      removedClients: [],
      approvedHosts: [],
    });
    if ("error" in approved) return;
    await accounts.trust([hostId]);
    const replacement = accountId(hostId);
    tailnetOf.set(replacement, id);
    const m = latest.current.machines.find((x) => x.id === replacement);
    if (!m) return;
    if (fleet.hosts.get(replacement)?.state.status === "connected") return retire(replacement);
    if (!fleet.hosts.has(m.id)) {
      gate(m.id, undefined);
      fleet.add(m);
    }
  }

  /** Drops the `tailnet:` computer that account computer `id`, now connected, replaces. */
  function retire(id: string) {
    const old = tailnetOf.get(id);
    if (!old) return;
    tailnetOf.delete(id);
    fleet.remove(old);
    update((s) => ({
      ...s,
      machines: s.machines.filter((m) => m.id !== old),
      defaultId: s.defaultId === old ? id : s.defaultId,
    }));
  }

  useEffect(() => {
    const listener = window.parallax.onConnectionState((id, state) => {
      setStates((s) => ({ ...s, [id]: state }));
      if (state.status !== "connected") return;
      void outboxes.get(id)?.drain();
      if (id.startsWith("account:")) {
        gate(id, undefined);
        retire(id);
      } else if (!id.startsWith("paired-") && "accountAccess" in state.capabilities) void migrate(id);
      if ("accountAccess" in state.capabilities) {
        watchAccess(id);
        void share();
      }
      // A connected computer lists the tailnet's others, so one added elsewhere shows up here.
      if ("connect" in state.capabilities)
        void window.parallax.request(id, "connect/devices", {}).then((answer) => {
          if ("error" in answer) return;
          const { devices, self } = answer.result;
          const found = computers(self ? [self, ...devices] : devices);
          update((s) => {
            const machines = merge(s.machines, found);
            return JSON.stringify(machines) === JSON.stringify(s.machines) ? s : { ...s, machines };
          });
        });
    });
    // A phone that slept may have lost its sockets: check them, or try again now. Coming to the
    // front, or a network that changed, also lists the account's computers again.
    const again = () => {
      fleet.wake();
      void discover();
    };
    const awake = AppState.addEventListener("change", (s) => s === "active" && again());
    const network = onNetwork(again);
    void discover();
    return () => {
      listener();
      awake.remove();
      network();
      // Signed out: this provider's connections end with it.
      fleet.close();
    };
  }, [fleet, outboxes]);

  // Connects to computers as they're added.
  useEffect(() => {
    for (const m of setup.machines) fleet.add(m);
  }, [fleet, setup.machines]);

  const onView = useRef((id: string, view: ThreadsView) =>
    setViews((v) => ({ ...v, [id]: view })),
  ).current;

  const list: Computer[] = setup.machines.map((machine) => {
    const state = states[machine.id] ?? { status: "connecting" };
    return {
      machine,
      state,
      connected: state.status === "connected",
      view: views[machine.id] ?? idleThreads,
      outbox: outbox(machine.id),
      gate: gates[machine.id],
    };
  });

  /** Connects to account computer `m` afresh, as once it's set up or approved. */
  const connect = (m: Machine) => {
    gate(m.id, undefined);
    fleet.remove(m.id);
    fleet.add(m);
  };

  function setUp(id: string) {
    const m = setup.machines.find((x) => x.id === id);
    if (!accounts || !m?.account) return;
    const { hostId, routes } = m.account;
    // A refusal may have passed, such as a clock set right: a computer this phone uses tries again.
    if (accounts.trusts(hostId)) return connect(m);
    const failed = (e: unknown) => Alert.alert(`Couldn't set up ${m.name}`, (e as Error).message);
    askSetupCode(
      m.name,
      (code) => {
        if (code.length !== 6) return failed(new Error("The code has 6 digits."));
        accounts.setup(hostId, routes, code).then(() => connect(m), failed);
      },
      () =>
        void accounts
          .ask(hostId, routes, (code) => {
            gate(id, { kind: "waiting", code });
            showWaiting(m.name, code);
          })
          .then(
            () => connect(m),
            (e: unknown) => {
              gate(id, { kind: "setup" });
              failed(e);
            },
          ),
    );
  }

  const value: FleetValue = {
    computers: list,
    defaultId: defaultOf(setup.machines, setup.defaultId),
    setDefault: (id) => update((s) => ({ ...s, defaultId: id })),
    // A computer added with none set as the default becomes it.
    add: (found) =>
      update((s) => {
        const machines = merge(s.machines, found);
        return { ...s, machines, defaultId: defaultOf(machines, s.defaultId) };
      }),
    remove: (id) => {
      fleet.remove(id);
      update((s) => ({
        ...s,
        machines: s.machines.filter((m) => m.id !== id),
        defaultId: s.defaultId === id ? undefined : s.defaultId,
        // Discovery would bring an account's computer straight back.
        hidden: id.startsWith("account:") ? [...(s.hidden ?? []), id] : s.hidden,
      }));
      if (setup.machines.find((m) => m.id === id)?.paired) void forget();
    },
    discover: () => void discover(),
    removed: listed.filter((l) => setup.hidden?.includes(accountId(l.hostId))),
    restore: (hostId) =>
      update((s) => {
        const hidden = (s.hidden ?? []).filter((id) => id !== accountId(hostId));
        const machines = withListed(s.machines, listed, hidden);
        return { ...s, hidden, machines, defaultId: defaultOf(machines, s.defaultId) };
      }),
    setUp,
    drafts,
  };

  return (
    <FleetContext value={value}>
      {setup.machines.map((m) => (
        <Threads
          key={m.id}
          id={m.id}
          state={states[m.id] ?? { status: "connecting" }}
          onView={onView}
        />
      ))}
      {children}
    </FleetContext>
  );
}
