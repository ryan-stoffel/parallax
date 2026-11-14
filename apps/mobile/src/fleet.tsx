// What every screen reads: each computer's connection, threads, and outbox, and the setup they
// came from. Each computer's threads come from the desktop's `useThreads`, one per computer.
//
// With the account signed in it also finds the account's computers on Parallax Relay (0091),
// when it starts, the app comes to the front, the network changes, and Settings opens, and every
// 15 seconds while it's in front. It sets them up or asks to use them, asks the user to allow other devices that ask,
// copies who's approved between the computers this phone uses, and drops those the relay marks removed.
import { File } from "expo-file-system";
import { t } from "i18next";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";

import type { ConnectionState, KeyStanding, RpcResponse } from "../../desktop/src/preload/bridge";
import type { RouteEdit } from "../../desktop/src/preload/routeList";
import { useShownConnections, useRealConnections } from "../../desktop/src/renderer/ConnectionStatus";
import { idleThreads, useThreads, type ThreadsView } from "../../desktop/src/renderer/threads";
import type { AccessState, HostUpdateResult, RemoteSessionsResult } from "../../desktop/src/protocol/generated/protocol";
import type { RelayCapNotice } from "../../desktop/src/renderer/relayCap";
import { onNetwork, privateFile } from "../modules/pinned-tls";
import { logAppEvent } from "./connectionLog";
import { lacks } from "./access";
import { listHosts, relayCap, type AccountHosts, type Gate, type Listed } from "./accountHosts";
import { allowThisPhone, askToAllow, confirmDevice, setUpComputer, showConfirm, showWaiting } from "./accountPrompts";
import { showAlert } from "./dialogStore";
import { forget } from "./host";
import { accountId, Fleet, saveSetup, withListed, type Machine, type Setup } from "./machines";
import { Outbox, type Outgoing, type Sent } from "./outbox";
import { savePushKey } from "./push";
import { editOnPhone } from "./routes";
import { keeper, toAsk } from "./setup";

/** How often the account's computers are listed while the app is in front. */
const LOOK_MS = 15_000;

/** One computer as the screens see it. */
export interface Computer {
  machine: Machine;
  state: ConnectionState;
  /** For showing status only: a short reconnect doesn't change it. Load and sync by `connectedNow`. */
  shownConnected: boolean;
  /** Really connected now. Loading and syncing go by this, and run again when it comes back. */
  connectedNow: boolean;
  view: ThreadsView;
  outbox: Outbox;
  /** Why an account's computer isn't connecting, until it's set up or approved. */
  gate?: Gate;
  /** What to say about its traffic through Parallax Relay today, from 80% of the daily cap. */
  cap?: RelayCapNotice;
}

interface FleetValue {
  computers: Computer[];
  defaultId?: string;
  setDefault: (id: string) => void;
  /** Adds a computer paired on the LAN. */
  add: (paired: Machine) => void;
  remove: (id: string) => void;
  /** Lists the account's computers again. */
  discover: () => void;
  /** The account's computers removed from this phone, to add back. */
  removed: Listed[];
  /** Adds back an account's computer removed from this phone. */
  restore: (hostId: string) => void;
  /** Sets up a gated account computer: its code, or an approval from another device. */
  setUp: (id: string) => void;
  /** This phone's key, which its Add computer command names, so its Allow alone is enough. */
  deviceKey?: string;
  /** Changes an account computer's routes, on this phone. Answers why it can't, for people. */
  editRoutes: (id: string, edit: RouteEdit) => string | undefined;
  /** The route computer `id`'s connection is on. */
  routeOf: (id: string) => string | undefined;
  /** Why this phone's key needs replacing, as a verified computer said (0091). */
  keyStanding?: KeyStanding;
  /**
   * Replaces this phone's key, for one that's removed or read-only, and asks for approval as a new
   * device, on another device or with `plx connect approve` (0091). Resolves to an error for people.
   */
  startOver: () => Promise<string | undefined>;
  /**
   * Revokes session `session` on computer `id`. A device signed in with the account also loses its
   * key there, which `share` then copies to the computers that accept this one's lists (0091).
   */
  revoke: (id: string, session: string) => Promise<RemoteSessionsResult | { error: string }>;
  /** Sends `host/update` to computer `id`, which only the user's Update does here (0066). */
  updateHost: (id: string, version: string, now?: boolean) => Promise<RpcResponse<HostUpdateResult>>;
  /**
   * Makes the device of `session` on computer `id` read-only, there and on every other computer
   * this phone reaches. Nothing undoes it (0091). Answers that computer's sessions, or why not.
   */
  makeReadOnly: (id: string, session: string) => Promise<RemoteSessionsResult | { error: string }>;
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
    // A dialog, not a notice: the saved copy is gone, so this is the last sight of what was typed.
    (m, error) =>
      showAlert(t("Message not sent"), t("“{{text}}”: {{reason}}", { text: m.text, reason: error.message }), [{ text: t("OK") }]),
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
  const capabilities = state.status === "connected" ? state.capabilities : undefined;
  const opening = state.status === "connecting" || !!capabilities;
  const view = useThreads(id, capabilities, opening, undefined, () => {});
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
  // As shown, so a short reconnect stays out of sight. The outbox goes by the real state.
  const shown = useShownConnections(setup.machines.map((m) => m.id));
  const states: Record<string, ConnectionState | undefined> = Object.fromEntries(
    setup.machines.map((m, i) => [m.id, shown[i]]),
  );
  const [views, setViews] = useState<Record<string, ThreadsView>>({});
  const [gates, setGates] = useState<Record<string, Gate | undefined>>({});
  const [listed, setListed] = useState<Listed[]>([]);
  const [stopped, setStopped] = useState(accounts?.askingStopped);
  const [keyStanding, setKeyStanding] = useState(accounts?.standing);
  // A refused sign-in, which gates its computer, is how a removed phone hears.
  useEffect(() => setKeyStanding(accounts?.standing), [gates]);
  const [drafts] = useState(() => new Map<string, string>());
  /** Requests already shown, so each asks once. */
  const [asked] = useState(() => new Set<string>());
  const fleetRef = useRef<Fleet>(null);
  const latest = useRef(setup);
  latest.current = setup;
  const gatesNow = useRef(gates);
  gatesNow.current = gates;
  const asking = useRef(false);
  const shownCode = useRef<string | undefined>(undefined);
  /** New computers this run has shown a code for. */
  const compared = useRef(new Set<string>());
  const retries = useRef(new Map<string, number>());
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

  /**
   * A new phone asks to use the account's computers on its own (0091), as onboarding does, for one
   * that skipped it. It shows the code once, since its row is out of sight here. A denied or lapsed
   * request stops it until the user taps a computer. A phone told its key was removed asks nothing,
   * as that key can't be approved, until the user starts over.
   */
  async function askOnItsOwn(found: Listed[]) {
    if (accounts?.standing === "removed") return;
    if (accounts?.usesAny) return compareNew(accounts, found);
    const hosts = accounts ? toAsk(found, accounts.usesAny, latest.current.hidden) : [];
    if (!accounts || !hosts.length || asking.current || accounts.askingStopped) return;
    asking.current = true;
    const asked = await allowThisPhone(accounts, hosts, (hostId, code, allow) => {
      const id = accountId(hostId);
      gate(id, { kind: "waiting", code });
      if (shownCode.current === code) return;
      shownCode.current = code;
      showWaiting(latest.current.machines.find((m) => m.id === id)?.name ?? t("your computers"), code, allow);
    });
    asking.current = false;
    setStopped(accounts.askingStopped);
    for (const host of hosts) {
      const id = accountId(host.hostId);
      const m = latest.current.machines.find((x) => x.id === id);
      if (m && accounts.trusts(host.hostId)) {
        if (fleet.hosts.get(id)?.state.status !== "connected") connect(m);
      } else if (asked !== "allowed" && accounts.askingStopped) gate(id, { kind: "setup" });
    }
  }

  /**
   * A phone in use shows a new computer's code to compare (0091), with no tap, once a run for each
   * one, so a request starts only when the computer appears. One that doesn't start or ends waits
   * for a tap on its row, which also offers its typed code.
   */
  async function compareNew(account: AccountHosts, found: Listed[]) {
    const hidden = latest.current.hidden ?? [];
    const next = found.find(
      (l) =>
        l.online && !account.trusts(l.hostId) && !hidden.includes(accountId(l.hostId)) && !compared.current.has(l.hostId),
    );
    if (!next || asking.current) return;
    asking.current = true;
    compared.current.add(next.hostId);
    const id = accountId(next.hostId);
    const choices = latest.current.machines.find((m) => m.id === id)?.account ?? { routes: [] };
    await account
      .compare(
        next.hostId,
        choices,
        (code) => {
          gate(id, { kind: "waiting", code });
          return askToAllow(next.name, code);
        },
        () => showConfirm(next.name),
      )
      .then(
        () => {
          const m = latest.current.machines.find((x) => x.id === id);
          if (m) connect(m);
        },
        () => gate(id, { kind: "setup" }),
      );
    asking.current = false;
  }

  /**
   * A computer this phone uses that wasn't ready for it, as before another device copied its key,
   * gets a couple of tries, then waits for the app to come to the front: each try can start a
   * request there, and a computer takes 5 an hour. A phone with no session anywhere, as after
   * starting over, leaves this to `askOnItsOwn`, which asks one computer.
   */
  function retryGated() {
    if (!accounts?.usesAny) return;
    for (const m of latest.current.machines) {
      if (!m.account || !accounts?.trusts(m.account.hostId)) continue;
      if (gatesNow.current[m.id]?.kind !== "setup") continue;
      const tries = retries.current.get(m.id) ?? 0;
      if (tries >= 2) continue;
      retries.current.set(m.id, tries + 1);
      connect(m);
    }
  }

  /** Lists the account's computers on the relay, adds new ones, and drops those marked removed. */
  async function discover() {
    const bearer = accounts && (await token());
    const list = bearer && (await listHosts(bearer));
    if (!list) return;
    const { hosts: found, removed } = list;
    // Only the mark drops a computer (0091). This comes first, so nothing below connects it again,
    // and runs on each read, as a sign-in in flight can still save a session.
    await accounts.forget(removed);
    for (const hostId of removed) {
      fleet.remove(accountId(hostId));
      gate(accountId(hostId), undefined);
    }
    setListed(found);
    void askOnItsOwn(found);
    retryGated();
    // A computer added since: the ones this phone uses may vouch for it now.
    if (found.some((l) => !accounts.trusts(l.hostId))) void share();
    update((s) => {
      const machines = withListed(s.machines, found, s.hidden, removed);
      return machines === s.machines ? s : { ...s, machines, defaultId: defaultOf(machines, s.defaultId) };
    });
  }

  /**
   * Copies who's approved between the connected computers that keep it (0091), each getting only
   * what its own list accepts, and trusts the computers they list.
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
      "error" in answer ? [] : keeper(latest.current.machines, id, answer.result),
    );
    if (!lists.length) return;
    const absorbed = await accounts.absorb(lists);
    setKeyStanding(accounts.standing);
    for (const { connection, lists: theirs, union } of absorbed)
      if (lacks(theirs, union)) void fleet.hosts.get(connection)?.request("access/merge", union);
    // A computer one of them lists connects now.
    for (const m of latest.current.machines)
      if (m.account && accounts.mayConnect(m.account.hostId) && !fleet.hosts.has(m.id)) {
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
            if ("error" in done) showAlert(t("Couldn't answer the request"), done.error.message);
            // Approved here, it's approved on the computers that accept this one's lists.
            else if (method === "access/approve") void share();
          });
        confirmDevice(pending.name, pending.code, () => decide("access/approve"), () => decide("access/deny"));
      }
    })();
  }

  useEffect(() => {
    const listener = window.parallax.onConnectionState((id, state) => {
      if (state.status !== "connected") return;
      void outboxes.get(id)?.drain();
      if (id.startsWith("account:")) gate(id, undefined);
      if ("relayPushKey" in state.capabilities) {
        void savePushKey((method, params) => fleet.hosts.get(id)!.request(method, params));
      }
      if ("accountAccess" in state.capabilities) {
        watchAccess(id);
        void share();
      }
    });
    // A phone that slept may have lost its sockets: check them, or try again now. Coming to the
    // front, or a network that changed, also lists the account's computers again.
    const again = () => {
      fleet.wake();
      retries.current.clear();
      void discover();
    };
    const awake = AppState.addEventListener("change", (s) => {
      // So a drop the background caused can be told from the rest.
      logAppEvent("app", { state: s });
      if (s === "active") again();
    });
    const network = onNetwork(() => {
      logAppEvent("network", { event: "changed" });
      again();
    });
    void discover();
    // A computer set up elsewhere changes nothing here. iOS suspends this in the background.
    const look = setInterval(() => void discover(), LOOK_MS);
    return () => {
      listener();
      awake.remove();
      network();
      clearInterval(look);
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

  const real = useRealConnections(setup.machines.map((m) => m.id));
  const list: Computer[] = setup.machines.map((machine, i) => {
    const state = states[machine.id] ?? { status: "connecting" };
    return {
      machine,
      state,
      shownConnected: state.status === "connected",
      connectedNow: real[i]?.status === "connected",
      view: views[machine.id] ?? idleThreads,
      outbox: outbox(machine.id),
      // Asking stopped: a computer waiting to be set up says why.
      gate: gates[machine.id]?.kind === "setup" && stopped ? { kind: "refused", message: stopped } : gates[machine.id],
      cap: relayCap(machine.name, listed.find((l) => accountId(l.hostId) === machine.id)?.usage),
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
    const { hostId } = m.account;
    void accounts.resumeAsking();
    setStopped(undefined);
    // With no session anywhere, as after starting over, it asks one computer again, once more.
    if (accounts.mayConnect(hostId) && !accounts.usesAny && !accounts.standing) {
      gate(id, { kind: "setup" });
      return void discover();
    }
    // A refusal may have passed, such as a clock set right: a computer this phone uses tries again.
    if (accounts.mayConnect(hostId)) return connect(m);
    setUpComputer(accounts, { hostId, name: m.name, choices: m.account }, {
      onWaiting: (code) => gate(id, { kind: "waiting", code }),
      done: () => connect(m),
      failed: () => gate(id, { kind: "setup" }),
    });
  }

  /**
   * Starts over with a new key (0091). The account's computers drop their connections, which hold
   * the old key, and stay down until `askOnItsOwn`, from the list read here, gets this phone allowed.
   */
  async function startOver(): Promise<string | undefined> {
    // No mark to act on, as on a second tap: nothing changes.
    if (!accounts?.standing) return undefined;
    const computers = latest.current.machines.filter((m) => m.account);
    for (const m of computers) {
      fleet.remove(m.id);
      gate(m.id, { kind: "setup" });
    }
    const failed = await accounts.startOver().then(
      () => undefined,
      (e: Error) => e.message,
    );
    // Anything failed: the old key stays, as do its connections.
    if (failed) {
      for (const m of computers) connect(m);
      return failed;
    }
    setKeyStanding(undefined);
    setStopped(undefined);
    shownCode.current = undefined;
    retries.current.clear();
    void discover();
    return undefined;
  }

  const value: FleetValue = {
    deviceKey: accounts?.thumbprint,
    keyStanding,
    startOver,
    computers: list,
    defaultId: defaultOf(setup.machines, setup.defaultId),
    setDefault: (id) => update((s) => ({ ...s, defaultId: id })),
    // A computer added with none set as the default becomes it. Pairing again replaces it.
    add: (paired) =>
      update((s) => {
        const machines = [...s.machines.filter((m) => m.id !== paired.id), paired];
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
    editRoutes: (id, edit) => {
      const account = setup.machines.find((m) => m.id === id)?.account;
      if (!account) return t("That computer isn't on this phone anymore.");
      const next = editOnPhone(account.hostId, account, edit);
      if ("error" in next) return next.error;
      const edited = { ...account, ...next };
      update((s) => ({
        ...s,
        machines: s.machines.map((m) => (m.id === id ? { ...m, account: edited } : m)),
      }));
      fleet.routesEdited(id, edited);
      return undefined;
    },
    routeOf: (id) => fleet.route(id),
    async revoke(id, session) {
      const answer = await fleet.hosts.get(id)?.request("remote/revoke", { id: session });
      if (!answer) return { error: t("That computer isn't connected.") };
      if ("error" in answer) return { error: answer.error.message };
      void share();
      return answer.result as RemoteSessionsResult;
    },
    async updateHost(id, version, now) {
      const answer = await fleet.hosts.get(id)?.request("host/update", { version, ...(now && { now }) });
      if (!answer) return { error: { code: -32602, message: t("That computer isn't in Parallax anymore.") } };
      return answer as RpcResponse<HostUpdateResult>;
    },
    async makeReadOnly(id, session) {
      const answer = await fleet.hosts.get(id)?.request("access/setReadOnly", { id: session });
      if (!answer) return { error: t("That computer isn't connected.") };
      if ("error" in answer) return { error: answer.error.message };
      void share();
      return answer.result as RemoteSessionsResult;
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
