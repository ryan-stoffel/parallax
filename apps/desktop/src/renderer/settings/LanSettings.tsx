import { ChevronRight, Plus, Wifi } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  RelayHost,
  RemotePairResult,
  RemoteSessionsResult,
} from "../../protocol/generated/protocol";
import { statusLabel, useConnectedNow, useConnection } from "../ConnectionStatus";
import { localId, useConnect, useHosts, type Host } from "../hosts";
import { dismiss, notify } from "../notifications";
import {
  ConfirmRemove,
  primaryButton,
  quietButton,
  Row,
  rowField,
  Section,
  settingRow,
  StatusDot,
  Switch,
} from "./parts";

/** A SHA-256 fingerprint in hex as browsers show it: `AB CD …`. */
const fingerprint = (hex: string) => hex.toUpperCase().match(/../g)!.join(" ");

/** What a paired computer can do, said before anyone pairs one. */
const GRANTS =
  "A paired computer has full control of this one: it can run agents and commands with full access, open terminals, change settings, and pair other computers. Pair only your own computers.";

/**
 * Settings > Connections' sections on how computers reach this one. Reach from anywhere, the local
 * plxd's `relay`, registers it with Parallax Relay and keeps it connected there, for phone
 * notifications and, with pairing on, reach from anywhere, and lists the account's computers on the
 * relay, each with Remove (PLX-652). Shown with pairing off too, since signing in turns it on
 * (PLX-1146). Beside it, Tailscale also finds the tailnet's devices (0056), until Tailscale is only
 * a route. Same network (PLX-641, 0065): its switch, `remote`, has plxd listen for paired computers
 * over HTTPS with its own pinned certificate, and Open in a browser, its `remoteWeb`, also serves
 * the app there for a browser to pair with (PLX-651). Pair a device shows a short one-time code
 * while this computer advertises itself by name over mDNS, and the computers paired with this one
 * can be revoked, even with the switch off. Below, the computers this app paired with, each with
 * its connection and Remove, and Pair computer, which finds the computers showing a code, or takes
 * an address, then the code.
 */
export function LanSettings() {
  const local = useConnection(localId);
  const connected = local?.status === "connected";
  const connectedNow = useConnectedNow(localId);
  const connect = useConnect();
  const computers = useHosts().filter((h) => h.routes);
  const [on, setOn] = useState<boolean>();
  const [web, setWeb] = useState<boolean>();
  const [relay, setRelay] = useState<boolean>();
  // The account's computers on the relay, while Reach from anywhere is on.
  const [relayHosts, setRelayHosts] = useState<RelayHost[]>();
  // The relay host whose Remove is waiting for a second click.
  const [confirmingRelay, setConfirmingRelay] = useState<string>();
  // The code on show, and how many computers were paired when it was made.
  const [code, setCode] = useState<RemotePairResult & { before: number }>();
  const [status, setStatus] = useState<RemoteSessionsResult>();
  const [adding, setAdding] = useState(false);
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
    });
    void readSessions();
  }, [connectedNow]);
  useEffect(() => {
    if (!connected || !relay) return setRelayHosts(undefined);
    if (!connectedNow) return;
    void window.parallax.relayHosts().then((hosts) => {
      if (typeof hosts !== "string") setRelayHosts(hosts);
    });
  }, [connected, connectedNow, relay]);
  // While a code is up, a computer that pairs shows up here, and the code goes, as it does once
  // plxd ends the pairing: used, locked, or expired. A bind that failed shows up too.
  const showing =
    code && sessions.length <= code.before && status?.pairing !== false ? code : undefined;
  const polling = !!showing || (on && !status?.listening) || (relay && !status?.relay?.connected);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void readSessions(), 2000);
    return () => clearInterval(timer);
  }, [polling]);

  const toggle = async (next: boolean) => {
    retry();
    const answer = await window.parallax.request(localId, "host/settings/set", { remote: next });
    if ("error" in answer)
      return failed(`Couldn't turn pairing ${next ? "on" : "off"}`, answer.error.message);
    setOn(answer.result.remote);
    setCode(undefined);
    void readSessions();
  };
  const toggleWeb = async (next: boolean) => {
    retry();
    const answer = await window.parallax.request(localId, "host/settings/set", { remoteWeb: next });
    if ("error" in answer)
      return failed(`Couldn't turn Open in a browser ${next ? "on" : "off"}`, answer.error.message);
    setWeb(answer.result.remoteWeb);
  };
  // On, it registers this computer under the signed-in account first: main sends the token to plxd.
  const toggleRelay = async (next: boolean) => {
    retry();
    const title = `Couldn't turn Reach from anywhere ${next ? "on" : "off"}`;
    const registered = next ? await window.parallax.registerRelay() : undefined;
    if (registered) return failed(title, registered);
    const answer = await window.parallax.request(localId, "host/settings/set", { relay: next });
    if ("error" in answer) return failed(title, answer.error.message);
    setRelay(answer.result.relay);
    void readSessions();
  };
  const toggleTailscale = async (next: boolean) => {
    const answer = await window.parallax.setConnect(next);
    if (answer) failed(`Couldn't turn Tailscale ${next ? "on" : "off"}`, answer);
  };
  const removeRelayHost = async (hostId: string) => {
    retry();
    setConfirmingRelay(undefined);
    const hosts = await window.parallax.removeRelayHost(hostId);
    if (typeof hosts === "string") return failed("Couldn't remove the computer", hosts);
    setRelayHosts(hosts);
  };
  const pair = async () => {
    retry();
    const answer = await window.parallax.request(localId, "remote/pair", {});
    if ("error" in answer) return failed("Couldn't make a pairing code", answer.error.message);
    setCode({ ...answer.result, before: sessions.length });
    void readSessions();
  };
  // A device signed in with the account loses its key on every computer this app reaches (0091).
  const revoke = async (id: string) => {
    retry();
    const answer = await window.parallax.revokeDevice(id);
    if (typeof answer === "string") return failed("Couldn't revoke the computer", answer);
    setStatus(answer);
  };

  return (
    <>
      <Section title="Reach from anywhere">
        {relay !== undefined && (
          <Row
            title="Reach from anywhere"
            description={
              <>
                Your phone hears when a thread here finishes, needs you, or fails, and webhooks get
                a public address. With pairing on, your signed-in computers and devices reach this
                one too. It all goes through Parallax Relay, which passes only encrypted traffic, so
                it can't read your threads. Signing in turns this on.
                {relay && (
                  <span role="status" className="mt-1 block text-foreground">
                    {status?.relay?.connected
                      ? "Connected to the relay."
                      : (status?.relay?.problem ?? "Connecting to the relay…")}
                  </span>
                )}
              </>
            }
          >
            <Switch
              label="Reach from anywhere"
              checked={relay}
              onChange={(next) => void toggleRelay(next)}
            />
          </Row>
        )}
        <Row
          title="Tailscale"
          description="Also find the computers on your Tailscale network that run Parallax Connect."
        >
          {connect ? (
            <Switch
              label="Tailscale"
              checked={!!connect.on}
              disabled={connect.on === undefined}
              onChange={(next) => void toggleTailscale(next)}
            />
          ) : (
            <span className="text-body text-muted-foreground">Checking…</span>
          )}
        </Row>
        {relay && !!relayHosts?.length && (
          <details className="border-border not-last:border-b [&[open]>summary_svg]:rotate-90">
            <summary className="flex cursor-default list-none items-center gap-1.5 px-4 py-3 text-body font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden />
              Computers on your account ({relayHosts.length} of 10)
            </summary>
            <div className="border-t border-border">
              {relayHosts.map((h) => (
                <Row
                  key={h.hostId}
                  title={h.name || "Unnamed computer"}
                  description={
                    confirmingRelay === h.hostId
                      ? "Remove this computer from your account? None of your computers or devices reach it anymore."
                      : `On the relay${h.thisComputer ? ", this computer" : ""}. ${h.online ? "Connected." : "Not connected."}`
                  }
                >
                  {h.thisComputer ? null : confirmingRelay === h.hostId ? (
                    <ConfirmRemove
                      onRemove={() => void removeRelayHost(h.hostId)}
                      onCancel={() => setConfirmingRelay(undefined)}
                    />
                  ) : (
                    <button
                      type="button"
                      className={quietButton}
                      aria-label={`Remove ${h.name || "Unnamed computer"} from your account`}
                      onClick={() => setConfirmingRelay(h.hostId)}
                    >
                      Remove
                    </button>
                  )}
                </Row>
              ))}
            </div>
          </details>
        )}
      </Section>
      <Section title="Same network">
        <Row title="Pair computers on this network" description={GRANTS}>
          <Switch
            label="Pair computers on this network"
            checked={!!on}
            disabled={on === undefined}
            onChange={(next) => void toggle(next)}
          />
        </Row>
        {on && status?.problem && (
          <p role="alert" className={`${settingRow} text-body text-danger`}>
            {status.problem}
          </p>
        )}
        {on && web !== undefined && (
          <Row
            title="Open in a browser"
            description={
              <>
                Serves Parallax at{" "}
                <span className="font-mono text-foreground">
                  {(showing?.addresses ?? ["this computer's address"])
                    .map((a) => `https://${a.includes(":") ? a : `${a}:7341`}`)
                    .join(", ")}
                </span>{" "}
                for a browser, which pairs with a code from Pair a device. Use the tailnet address
                where you can: Tailscale vouches for this computer. On this network the browser
                warns about this computer's certificate. Continue only if the SHA-256 fingerprint it
                shows is the one below, or trust the certificate in your OS first. Otherwise someone
                on the network could pose as this computer and take the code. Turning this off
                disconnects paired browsers until it's on again.
                {status?.fingerprint && (
                  <span
                    aria-label="Certificate fingerprint"
                    className="mt-1 block font-mono text-meta break-all text-foreground"
                  >
                    {fingerprint(status.fingerprint)}
                  </span>
                )}
              </>
            }
          >
            <Switch
              label="Open in a browser"
              checked={web}
              onChange={(next) => void toggleWeb(next)}
            />
          </Row>
        )}
        {on && status?.listening && (
          <Row
            title="Pair a device"
            description={
              showing ? (
                <>
                  On the other computer, choose Pair computer, pick{" "}
                  <span className="text-foreground">{showing.name}</span>, and enter this code. It
                  works once, for 5 minutes. Share it only with your own computer.
                </>
              ) : (
                "Shows a short one-time code for another computer to pair with."
              )
            }
          >
            {showing && (
              <span
                aria-label="Pairing code"
                className="font-mono text-heading font-semibold tracking-widest"
              >
                {showing.code}
              </span>
            )}
            <button type="button" className={quietButton} onClick={() => void pair()}>
              {showing ? "New code" : "Pair a device"}
            </button>
          </Row>
        )}
        {sessions.map((s) => (
          <Row
            key={s.id}
            title={s.name || "Unnamed computer"}
            description={`Paired ${new Date(s.createdAt).toLocaleDateString()}`}
          >
            <button type="button" className={quietButton} onClick={() => void revoke(s.id)}>
              Revoke
            </button>
          </Row>
        ))}
      </Section>

      <Section
        title="Computers on this network"
        action={
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Pair computer
          </button>
        }
      >
        {adding && <PairForm onDone={() => setAdding(false)} />}
        {computers.map((c) => (
          <LanComputer key={c.id} computer={c} />
        ))}
        {!computers.length && !adding && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Wifi aria-hidden className="size-6 text-faint-foreground" />
            <p className="text-body font-medium">No paired computers yet</p>
            <p className="max-w-sm text-body text-muted-foreground">
              Turn on pairing on your other computer and choose Pair a device there, then add it
              here with the code it shows.
            </p>
          </div>
        )}
      </Section>
    </>
  );
}

/**
 * Pair computer: the computers showing a code on this network, by name, or an address typed in
 * when mDNS can't find them; then the code, and Pair.
 */
function PairForm({ onDone }: { onDone: () => void }) {
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
  useEffect(() => void look(), []);
  const target = typing
    ? address.trim() && { address: address.trim() }
    : picked !== undefined && { found: picked };
  const submit = async () => {
    if (!target) return;
    setPairing(true);
    const failed = await window.parallax.pairLan(target, code);
    setPairing(false);
    setError(failed);
    if (!failed) onDone();
  };
  return (
    <form
      className={`${settingRow} flex-col items-stretch`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-body text-muted-foreground">{GRANTS}</p>
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
        <button
          type="button"
          className={`${quietButton} mr-auto`}
          onClick={() => setTyping((t) => !t)}
        >
          {typing ? "Find computers instead" : "Enter an address instead"}
        </button>
        <button type="button" className={quietButton} onClick={onDone}>
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
      {error && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/** A computer this app paired with: its connection, its routes in order, and Remove. */
function LanComputer({ computer }: { computer: Host }) {
  const state = useConnection(computer.id);
  const remove = async () => {
    const failed = await window.parallax.removeHost(computer.id);
    if (failed) notify({ tone: "error", title: `Couldn't remove ${computer.name}`, body: failed });
  };
  const tone = state?.status === "connected" ? "on" : state?.status === "failed" ? "warn" : "off";
  return (
    <div className={settingRow}>
      <div className="min-w-0">
        <span className="flex items-center gap-2 text-body font-medium">
          <StatusDot tone={tone} />
          <span className="truncate">{computer.name}</span>
        </span>
        <span className="block truncate text-body text-muted-foreground">
          <span className="font-mono">{computer.routes?.join(", ")}</span>
          {state && ` · ${statusLabel(state)}`}
          {state?.status === "connected" && ` · plxd ${state.plxd}`}
        </span>
        {state?.status === "failed" && (
          <span className="block text-body text-muted-foreground">{state.error.message}</span>
        )}
      </div>
      <button type="button" className={quietButton} onClick={() => void remove()}>
        Remove
      </button>
    </div>
  );
}
