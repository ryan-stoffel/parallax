import { KeyRound, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { ConnectState } from "../../preload/bridge";
import type {
  RelayCheckPart,
  RelayCheckResult,
  RelayHost,
  RemotePairResult,
  RemoteSessionsResult,
} from "../../protocol/generated/protocol";
import { useCopy } from "../AgentChat";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { localId } from "../hosts";
import { dismiss, notify } from "../notifications";
import { useProfile } from "../profile";
import { Dialog } from "../ui";
import { AccessRow, badge, CollapsibleCard } from "./connectionParts";
import {
  ConfirmRemove,
  outlineButton,
  primaryButton,
  quietButton,
  rowField,
  Switch,
} from "./parts";

/** A SHA-256 fingerprint in hex as browsers show it: `AB CD …`. */
const fingerprint = (hex: string) => hex.toUpperCase().match(/../g)!.join(" ");

/** What a paired computer can do, said where a pairing code is shown. */
const GRANTS =
  "A paired computer has full control of this one: it can run agents and commands with full access, open terminals, change settings, and pair other computers, until you make it read-only. Share the code only with your own computers.";

/** Why read-only is for good: it belongs to the device's key, and only a new key has full access (0091). */
const READ_ONLY_FOR_GOOD =
  "This can't be undone. To give it full access, revoke it, then pair it again, or choose Start over with a new key in that device's Settings.";

/** How the connection check names a part. */
const CHECK_PARTS: Record<RelayCheckPart, string> = {
  signIn: "Sign-in",
  relay: "Relay",
  listener: "Listener",
  stream: "Stream",
};

/** How many computers an account's relay holds. */
const ACCOUNT_COMPUTERS = 10;

/** How long after a sign-in plxd may still be turning `relay` on. */
const SETTLE_MS = 30_000;
/** When a sign-in was last seen, by either Connections page, so one opened just after it waits too. */
let signedInAt = -SETTLE_MS;

/** The account as Settings' Connections pages use it: whether it's signed out, and Sign in. */
export function useAccountSignIn() {
  const profile = useProfile();
  const [signingIn, setSigningIn] = useState(false);
  const signIn = async () => {
    setSigningIn(true);
    const failed = await window.parallax.signIn(false);
    setSigningIn(false);
    if (failed) notify({ tone: "error", title: "Couldn't sign in", body: failed });
  };
  return {
    signedIn: !!profile,
    signedOut: profile === null,
    signingIn,
    onSignIn: () => void signIn(),
  };
}

/**
 * How computers reach this one, read from the local plxd, with what changes it: Reach from
 * anywhere, its `relay`, which registers it with Parallax Relay (PLX-652); pairing on the same
 * network, its `remote` (PLX-641, 0065), and Open in a browser, its `remoteWeb` (PLX-651); and
 * `agentWork` (0101), which it and pairing change in each other. With them, the devices paired with
 * or signed in to this computer, which can be revoked or made read-only (PLX-1364), a pairing code
 * while one is on show, and the account's computers on the relay while Reach from anywhere is on.
 *
 * Signing in registers this computer, and plxd then turns `relay` on, which nothing tells the app
 * (PLX-1146). So after a sign-in, seen here or by the page open just before, it reads the settings
 * again until that shows, half a minute passes, or the user signs out.
 */
export function useLocalAccess() {
  const profile = useProfile();
  const local = useShownConnection(localId);
  const connected = local?.status === "connected";
  const connectedNow = useConnectedNow(localId);
  const [on, setOn] = useState<boolean>();
  const [web, setWeb] = useState<boolean>();
  const [relay, setRelay] = useState<boolean>();
  // This computer's `agentWork`, on a plxd that has it.
  const [agentWork, setAgentWork] = useState<boolean>();
  const [relayHosts, setRelayHosts] = useState<RelayHost[]>();
  // The code on show, and how many devices were paired when it was made.
  const [code, setCode] = useState<RemotePairResult & { before: number }>();
  const [status, setStatus] = useState<RemoteSessionsResult>();
  // Bumped to read this computer's settings again, after something else changed them.
  const [read, setRead] = useState(0);
  // Bumped to read the account's computers again, after one joined or left.
  const [listRead, setListRead] = useState(0);
  // A sign-in is turning `relay` on, some seconds after it's done: read until it shows.
  const [settling, setSettling] = useState(() => performance.now() - signedInAt < SETTLE_MS);
  const signedOut = useRef(false);
  useEffect(() => {
    if (profile === null) {
      signedOut.current = true;
      setSettling(false);
    } else if (profile && signedOut.current) {
      signedOut.current = false;
      signedInAt = performance.now();
      setRead((n) => n + 1);
      setSettling(true);
    }
  }, [profile]);
  // What a switch or button here couldn't do. One replaces the last, and trying again closes it.
  const failed = (title: string, body: string) =>
    notify({ key: "same-network", tone: "error", title, body });
  const retry = () => dismiss("same-network");
  const sessions = status?.sessions ?? [];

  const readSessions = async () => {
    const answer = await window.parallax.request(localId, "remote/sessions", {});
    if ("result" in answer) setStatus(answer.result);
  };
  useEffect(() => {
    if (!connectedNow) return;
    void window.parallax.request(localId, "host/settings/get", {}).then((answer) => {
      if (!("result" in answer)) return;
      setOn(answer.result.remote);
      setWeb(answer.result.remoteWeb);
      setRelay(answer.result.relay);
      setAgentWork(answer.result.agentWork);
    });
    void readSessions();
  }, [connectedNow, read]);
  useEffect(() => {
    if (!connected || !relay) return setRelayHosts(undefined);
    if (!connectedNow) return;
    void window.parallax.relayHosts().then((hosts) => {
      if (typeof hosts !== "string") setRelayHosts(hosts);
    });
  }, [connected, connectedNow, relay, listRead]);
  useEffect(() => {
    if (!settling) return;
    if (relay) return setSettling(false);
    const timer = setInterval(() => setRead((n) => n + 1), 1500);
    const giveUp = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [settling, relay]);
  // While a code is up, a device that pairs shows up here, and the code goes, as it does once plxd
  // ends the pairing: used, locked, or expired. A bind that failed shows up too.
  const showing =
    code && sessions.length <= code.before && status?.pairing !== false ? code : undefined;
  const polling = !!showing || (on && !status?.listening) || (relay && !status?.relay?.connected);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void readSessions(), 2000);
    return () => clearInterval(timer);
  }, [polling]);

  return {
    /** Whether `agentWork` can be set here: a connected plxd that has it, and has answered. */
    canAgentWork: connected && "agentWork" in local.capabilities && agentWork !== undefined,
    canMakeReadOnly: connected && "readOnlyDevices" in local.capabilities,
    on,
    web,
    relay,
    agentWork,
    status,
    sessions,
    relayHosts,
    showing,
    reload: () => setRead((n) => n + 1),
    /** Reads the account's computers again. */
    refreshRelayHosts: () => setListRead((n) => n + 1),
    /** Drops a computer being removed from the list held here, ahead of the next read. */
    forgetRelayHost: (hostId: string) =>
      setRelayHosts((hosts) => hosts?.filter((h) => h.hostId !== hostId)),
    toggle: async (next: boolean) => {
      retry();
      const answer = await window.parallax.request(localId, "host/settings/set", { remote: next });
      if ("error" in answer)
        return failed(`Couldn't turn pairing ${next ? "on" : "off"}`, answer.error.message);
      setOn(answer.result.remote);
      setAgentWork(answer.result.agentWork);
      setCode(undefined);
      void readSessions();
    },
    toggleAgentWork: async (next: boolean) => {
      retry();
      const answer = await window.parallax.request(localId, "host/settings/set", {
        agentWork: next,
      });
      if ("error" in answer)
        return failed(`Couldn't turn agent work ${next ? "on" : "off"}`, answer.error.message);
      setAgentWork(answer.result.agentWork);
      setOn(answer.result.remote);
      void readSessions();
    },
    toggleWeb: async (next: boolean) => {
      retry();
      const answer = await window.parallax.request(localId, "host/settings/set", {
        remoteWeb: next,
      });
      if ("error" in answer)
        return failed(
          `Couldn't turn Open in a browser ${next ? "on" : "off"}`,
          answer.error.message,
        );
      setWeb(answer.result.remoteWeb);
    },
    // On, it registers this computer under the signed-in account first: main sends the token to plxd.
    toggleRelay: async (next: boolean) => {
      retry();
      const title = `Couldn't turn Reach from anywhere ${next ? "on" : "off"}`;
      const registered = next ? await window.parallax.registerRelay() : undefined;
      if (registered) return failed(title, registered);
      const answer = await window.parallax.request(localId, "host/settings/set", { relay: next });
      if ("error" in answer) return failed(title, answer.error.message);
      setRelay(answer.result.relay);
      void readSessions();
    },
    toggleTailscale: async (next: boolean) => {
      const answer = await window.parallax.setConnect(next);
      if (answer) failed(`Couldn't turn Tailscale ${next ? "on" : "off"}`, answer);
    },
    /** Takes a computer the app can't list off the account. Resolves to why not. */
    removeRelayHost: async (hostId: string) => {
      const hosts = await window.parallax.removeRelayHost(hostId);
      if (typeof hosts === "string") return hosts;
      setRelayHosts(hosts);
      return undefined;
    },
    pair: async () => {
      retry();
      const answer = await window.parallax.request(localId, "remote/pair", {});
      if ("error" in answer) return failed("Couldn't make a pairing code", answer.error.message);
      setCode({ ...answer.result, before: sessions.length });
      void readSessions();
    },
    // A device signed in with the account loses its key on every computer this app reaches (0091).
    revoke: async (id: string) => {
      retry();
      const answer = await window.parallax.revokeDevice(id);
      if (typeof answer === "string") return failed("Couldn't revoke the computer", answer);
      setStatus(answer);
    },
    // It reaches every computer this app reaches, closes the device's connections, and can't be undone.
    makeReadOnly: async (id: string) => {
      retry();
      const answer = await window.parallax.makeDeviceReadOnly(id);
      if (typeof answer === "string") return failed("Couldn't make the computer read-only", answer);
      setStatus(answer);
    },
  };
}

export type LocalAccess = ReturnType<typeof useLocalAccess>;

/** A line under a setting's description saying what it's doing now. */
const statusLine = "mt-1 block text-meta text-foreground";

/**
 * Reach from anywhere, this computer's `relay`: its switch, whether it's connected, and how many of
 * the account's computers are on the relay. While it's on, Check connection (PLX-1356) opens a real
 * stream through the relay back to this computer, shows which part failed and what to do, and
 * copies a report with no secret in it. It runs only when asked, since each run counts against the
 * relay's streams a minute. Signed out, it can't turn on, so Sign in is in its switch's place.
 */
function ReachRow({
  access,
  signedOut,
  signingIn,
  onSignIn,
}: {
  access: LocalAccess;
  signedOut: boolean;
  signingIn: boolean;
  onSignIn: () => void;
}) {
  const { relay, status, relayHosts } = access;
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<RelayCheckResult | string>();
  const [copied, copy] = useCopy();
  const check = async () => {
    setChecking(true);
    setResult(await window.parallax.checkRelay());
    setChecking(false);
  };
  const report = typeof result === "object" ? result : undefined;
  return (
    <AccessRow
      title="Reach from anywhere"
      description="Your phone and signed-in devices reach this computer through Parallax Relay, which can't read your threads."
      status={
        relay && (
          <>
            <span role="status" className={statusLine}>
              {status?.relay?.connected
                ? "Connected to the relay."
                : (status?.relay?.problem ?? "Connecting to the relay…")}
              {!!relayHosts?.length && (
                <span className="text-muted-foreground">
                  {" "}
                  {relayHosts.length} of {ACCOUNT_COMPUTERS} computers on your account.
                </span>
              )}
            </span>
            {(checking || result !== undefined) && (
              <span role="status" className={statusLine}>
                {checking
                  ? "Checking…"
                  : typeof result === "string"
                    ? result
                    : report?.failed
                      ? `${CHECK_PARTS[report.failed]} failed. ${report.problem} ${report.fix}`
                      : `Working. The connection took ${report?.roundTripMs} ms.`}
              </span>
            )}
          </>
        )
      }
    >
      {relay && report && !checking && (
        <button type="button" className={quietButton} onClick={() => copy(report.diagnostics)}>
          {copied ? "Copied" : "Copy diagnostics"}
        </button>
      )}
      {relay && (
        <button
          type="button"
          className={quietButton}
          disabled={checking}
          title="Opens a real connection through the relay back to this computer."
          onClick={() => void check()}
        >
          Check connection
        </button>
      )}
      {signedOut && !relay ? (
        <button type="button" disabled={signingIn} onClick={onSignIn} className={primaryButton}>
          {signingIn ? "Waiting for your browser…" : "Sign in"}
        </button>
      ) : (
        <Switch
          label="Reach from anywhere"
          checked={!!relay}
          onChange={(next) => void access.toggleRelay(next)}
        />
      )}
    </AccessRow>
  );
}

/**
 * This computer's rows on Sharing & access, under its version: pairing on the same network;
 * Tailscale, which also finds the tailnet's devices (0056) until Tailscale is only a route; Reach
 * from anywhere; Open in a browser, which serves the app from this computer's listener for a browser
 * to pair with (PLX-651) and so needs pairing on; whether agents on the user's other computers can
 * work here; and, signed in, the setup code another computer adds this one with (0091).
 */
export function SharingRows({
  access,
  connect,
  onShowCode,
  ...account
}: {
  access: LocalAccess;
  connect: ConnectState | undefined;
  signedOut: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  /** Opens Show setup code. Absent while signed out, when there's no account to add it to. */
  onShowCode?: () => void;
}) {
  const { web, on, status, showing } = access;
  const addresses = (showing?.addresses ?? ["this computer's address"])
    .map((a) => `https://${a.includes(":") ? a : `${a}:7341`}`)
    .join(", ");
  return (
    <>
      <AccessRow
        title="Pair computers on this network"
        description="Computers and browsers on your network pair with this one using a one-time code."
        status={
          on &&
          status?.problem && (
            <span role="alert" className="mt-1 block text-meta text-danger">
              {status.problem}
            </span>
          )
        }
      >
        <Switch
          label="Pair computers on this network"
          checked={!!on}
          disabled={on === undefined}
          onChange={(next) => void access.toggle(next)}
        />
      </AccessRow>
      <AccessRow
        title="Tailscale"
        description="Also find the computers on your Tailscale network that run Parallax Connect."
      >
        {connect ? (
          <Switch
            label="Tailscale"
            checked={!!connect.on}
            disabled={connect.on === undefined}
            onChange={(next) => void access.toggleTailscale(next)}
          />
        ) : (
          <span className="text-body text-muted-foreground">Checking…</span>
        )}
      </AccessRow>
      {access.relay !== undefined && <ReachRow access={access} {...account} />}
      {web !== undefined && (
        <AccessRow
          title="Open in a browser"
          description={
            !on ? (
              "Use Parallax from a browser on this network. Needs pairing on."
            ) : !web ? (
              "Use Parallax from a browser on this network."
            ) : (
              <>
                Open <span className="font-mono text-foreground">{addresses}</span> and pair with a
                code from Pair a device. Use the Tailscale address where you can. On this network
                the browser warns about this computer's certificate: continue only if it shows this
                SHA-256 fingerprint, or trust the certificate in your OS first. Otherwise someone on
                the network could pose as this computer. Turning this off disconnects paired
                browsers.
              </>
            )
          }
          status={
            on &&
            web &&
            status?.fingerprint && (
              <span
                aria-label="Certificate fingerprint"
                className="mt-1 block font-mono text-meta break-all text-foreground"
              >
                {fingerprint(status.fingerprint)}
              </span>
            )
          }
        >
          <Switch
            label="Open in a browser"
            checked={!!on && web}
            disabled={!on}
            onChange={(next) => void access.toggleWeb(next)}
          />
        </AccessRow>
      )}
      {access.canAgentWork && (
        <AccessRow
          title="Agents can work here"
          description="Agents on your other computers can run commands here as you. Turning this on also turns on pairing."
          status={
            access.agentWork &&
            !access.relay && (
              <span className="mt-1 block text-meta text-warning">Needs Reach from anywhere</span>
            )
          }
        >
          <Switch
            label="Let agents on my other computers work here"
            checked={!!access.agentWork}
            onChange={(next) => void access.toggleAgentWork(next)}
          />
        </AccessRow>
      )}
      <AccessRow
        title="Setup code"
        description={
          onShowCode
            ? "A one-time code to type on another computer that's adding this one to your account."
            : "A one-time code for another computer that's adding this one to your account. Sign in first."
        }
      >
        <button type="button" disabled={!onShowCode} onClick={onShowCode} className={outlineButton}>
          <KeyRound aria-hidden />
          Show setup code
        </button>
      </AccessRow>
    </>
  );
}

/**
 * Sharing & access' Devices with access, a card that opens and closes: the phones, browsers, and
 * computers paired with or signed in to this computer, counted in its heading, each with Revoke and
 * Make read-only (PLX-1364), shown with pairing off too. Pair a device, in its heading, shows a
 * short one-time code while this computer advertises itself by name over mDNS, with what a paired
 * computer can do beside it. With pairing off, the card says how to pair one, and is where a search
 * for Pair a device lands.
 */
export function DevicesWithAccess({ access }: { access: LocalAccess }) {
  const { sessions, showing } = access;
  // The session whose Make read-only is waiting for a second click.
  const [confirming, setConfirming] = useState<string>();
  const canPair = !!access.on && !!access.status?.listening;
  return (
    <CollapsibleCard
      title="Devices with access"
      summary={
        sessions.length > 0 && (sessions.length === 1 ? "1 device" : `${sessions.length} devices`)
      }
      // A code on show is never hidden.
      open={!!showing}
      action={
        canPair &&
        !showing && (
          <button
            type="button"
            data-setting="pair-a-device"
            onClick={() => void access.pair()}
            className={outlineButton}
          >
            <Plus aria-hidden />
            Pair a device
          </button>
        )
      }
    >
      {/* Where a search for Pair a device lands while its button isn't there. */}
      <div data-setting={canPair || showing ? undefined : "pair-a-device"}>
        {showing && (
          <AccessRow
            title="Pair a device"
            description={
              <>
                On the other computer, choose Add computer, then On this network, pick{" "}
                <span className="text-foreground">{showing.name}</span>, and enter this code. It
                works once, for 5 minutes. {GRANTS}
              </>
            }
          >
            <span
              aria-label="Pairing code"
              className="font-mono text-heading font-semibold tracking-widest"
            >
              {showing.code}
            </span>
            <button type="button" className={quietButton} onClick={() => void access.pair()}>
              New code
            </button>
          </AccessRow>
        )}
        {sessions.map((s) => {
          const paired = `Paired ${new Date(s.createdAt).toLocaleDateString()}`;
          return (
            <div
              key={s.id}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-border/40 px-4 py-3 not-last:border-b"
            >
              <div className="min-w-[min(14rem,100%)] flex-1">
                <span className="flex items-center gap-2 text-body font-medium">
                  <span className="truncate">{s.name || "Unnamed computer"}</span>
                  {s.readOnly && (
                    <span className={`${badge} text-muted-foreground`}>Read-only</span>
                  )}
                </span>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  {confirming === s.id
                    ? `Make this computer read-only on all your computers? It can read threads but not change anything. ${READ_ONLY_FOR_GOOD}`
                    : s.readOnly
                      ? `${paired}. It reads threads and can't change anything. For full access, revoke it, then pair it again or choose Start over with a new key on that device.`
                      : paired}
                </span>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {confirming === s.id ? (
                  <ConfirmRemove
                    label="Make read-only"
                    onRemove={() => {
                      setConfirming(undefined);
                      void access.makeReadOnly(s.id);
                    }}
                    onCancel={() => setConfirming(undefined)}
                  />
                ) : (
                  <>
                    {access.canMakeReadOnly && !s.readOnly && (
                      <button
                        type="button"
                        className={quietButton}
                        onClick={() => setConfirming(s.id)}
                      >
                        Make read-only
                      </button>
                    )}
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => void access.revoke(s.id)}
                    >
                      Revoke
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {!sessions.length && !showing && (
          <p className="px-4 py-3 text-body text-muted-foreground">
            Nothing has access yet.
            {!canPair && " Turn on Pair computers on this network to pair a device."}
          </p>
        )}
      </div>
    </CollapsibleCard>
  );
}

/**
 * Add a computer on this network, a modal dialog open while it's mounted: the computers showing a
 * code, by name, or an address typed in when mDNS can't find them; then the code, and Pair.
 */
export function PairDialog({ onDone }: { onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [found, setFound] = useState<{ id: string; name: string }[] | string>();
  const [picked, setPicked] = useState<string>();
  const [typing, setTyping] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const look = async () => {
    setFound(undefined);
    const answer = await window.parallax.discoverLan();
    setFound(answer);
    if (typeof answer !== "string" && answer.length === 1) setPicked(answer[0]!.id);
  };
  useEffect(() => {
    dialog.current?.showModal();
    void look();
  }, []);
  const target = typing
    ? address.trim() && { address: address.trim() }
    : picked !== undefined && { found: picked };
  const submit = async () => {
    if (!target) return;
    setPairing(true);
    const failed = await window.parallax.pairLan(target, code);
    setPairing(false);
    setError(failed);
    if (!failed) dialog.current?.close();
  };
  return (
    <Dialog ref={dialog} aria-labelledby={titleId} onClose={onDone}>
      <form
        className="flex flex-col gap-3 px-5 pt-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <h2 id={titleId} className="text-reading font-semibold">
            Add a computer on this network
          </h2>
          <p className="mt-1.5 text-body text-muted-foreground">
            On the other computer, turn on pairing in Settings › Sharing & access and choose Pair a
            device. Then enter the code it shows. Pair only your own computers.
          </p>
        </div>
        {typing ? (
          <input
            aria-label="Address"
            placeholder="192.168.1.20"
            className={`${rowField} font-mono`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoFocus
          />
        ) : (
          <div
            role="radiogroup"
            aria-label="Computers showing a code"
            className="flex flex-wrap gap-1.5"
          >
            {found === undefined && (
              <span className="text-body text-muted-foreground">Looking for computers…</span>
            )}
            {typeof found === "string" && <span className="text-body text-danger">{found}</span>}
            {Array.isArray(found) && !found.length && (
              <span className="text-body text-muted-foreground">
                No computer on this network is showing a code.{" "}
                <button type="button" className="underline" onClick={() => void look()}>
                  Look again
                </button>
              </span>
            )}
            {Array.isArray(found) &&
              found.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={picked === f.id}
                  className={`${quietButton} border border-border aria-checked:border-accent aria-checked:text-foreground`}
                  onClick={() => setPicked(f.id)}
                >
                  {f.name}
                </button>
              ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Code"
            placeholder="7KQ-4M2"
            className={`${rowField.replace("w-56", "w-32")} font-mono uppercase`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="button" className={quietButton} onClick={() => setTyping((t) => !t)}>
            {typing ? "Find computers instead" : "Enter an address instead"}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={quietButton} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            type="submit"
            className={primaryButton}
            disabled={pairing || !target || !code.trim()}
          >
            {pairing ? "Pairing…" : "Pair"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
