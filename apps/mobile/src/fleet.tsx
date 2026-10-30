// What every screen reads: each computer's connection, threads, and outbox, and the setup they
// came from. Each computer's threads come from the desktop's `useThreads`, one per computer.
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
import { privateFile } from "../modules/pinned-tls";
import { forget } from "./host";
import { computers, Fleet, merge, saveSetup, type Machine, type Setup } from "./machines";
import { Outbox, type Outgoing, type Sent } from "./outbox";

/** One computer as the screens see it. */
export interface Computer {
  machine: Machine;
  state: ConnectionState;
  connected: boolean;
  view: ThreadsView;
  outbox: Outbox;
}

interface FleetValue {
  computers: Computer[];
  defaultId?: string;
  setDefault: (id: string) => void;
  /** Adds computers found with `probe`, or a LAN-paired one. */
  add: (found: Machine[]) => void;
  remove: (id: string) => void;
  /** Unsent text, by thread. */
  drafts: Map<string, string>;
}

const FleetContext = createContext<FleetValue | null>(null);

export const useFleet = () => useContext(FleetContext)!;

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
  children,
}: {
  setup: Setup;
  children: ReactNode;
}) {
  const [setup, setSetup] = useState(initial);
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [views, setViews] = useState<Record<string, ThreadsView>>({});
  const [drafts] = useState(() => new Map<string, string>());
  const fleetRef = useRef<Fleet>(null);
  const [fleet] = useState(() => {
    const made = new Fleet(async (m) => {
      // A LAN-paired computer revoked this phone: its connection ends, so pairing again
      // connects afresh under the same id.
      await forget();
      fleetRef.current?.remove(m.id);
      update((s) => ({ ...s, machines: s.machines.filter((x) => x.id !== m.id) }));
    }, initial.machines);
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
      saveSetup(next);
      return next;
    });
  }

  useEffect(() => {
    const listener = window.parallax.onConnectionState((id, state) => {
      setStates((s) => ({ ...s, [id]: state }));
      if (state.status !== "connected") return;
      void outboxes.get(id)?.drain();
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
    // A phone that slept may have lost its sockets: check them, or try again now.
    const awake = AppState.addEventListener("change", (s) => s === "active" && fleet.wake());
    return () => {
      listener();
      awake.remove();
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
    };
  });

  const value: FleetValue = {
    computers: list,
    defaultId: setup.defaultId ?? setup.machines[0]?.id,
    setDefault: (id) => update((s) => ({ ...s, defaultId: id })),
    // A computer added with none set as the default becomes it.
    add: (found) =>
      update((s) => {
        const machines = merge(s.machines, found);
        return { ...s, machines, defaultId: s.defaultId ?? machines[0]?.id };
      }),
    remove: (id) => {
      fleet.remove(id);
      update((s) => ({
        ...s,
        machines: s.machines.filter((m) => m.id !== id),
        defaultId: s.defaultId === id ? undefined : s.defaultId,
      }));
      if (setup.machines.find((m) => m.id === id)?.paired) void forget();
    },
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
