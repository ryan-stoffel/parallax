import { Plus, Wifi } from "lucide-react";
import { useEffect, useState } from "react";

import type { RemotePairResult, RemoteSessionsResult } from "../../protocol/generated/protocol";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { localId, useHosts, type Host } from "../hosts";
import {
  primaryButton,
  quietButton,
  Row,
  rowField,
  Section,
  settingRow,
  StatusDot,
  Switch,
} from "./parts";

/** What a paired computer can do, said before anyone pairs one. */
const GRANTS =
  "A paired computer has full control of this one: it can run agents and commands with full access, open terminals, change settings, and pair other computers. Pair only your own computers.";

/**
 * Settings > Connections' Same network section (PLX-641, 0065). Its switch, the local plxd's
 * `remote`, has it listen for paired computers over HTTPS with its own pinned certificate. Pair a
 * device shows a short one-time code while this computer advertises itself by name over mDNS, and
 * the computers paired with this one can be revoked, even with the switch off. Below, the
 * computers this app paired with, each with its connection and Remove, and Add computer, which
 * finds the computers showing a code, or takes an address, then the code.
 */
export function LanSettings() {
  const local = useConnection(localId);
  const connected = local?.status === "connected";
  const computers = useHosts().filter((h) => h.routes);
  const [on, setOn] = useState<boolean>();
  // The code on show, and how many computers were paired when it was made.
  const [code, setCode] = useState<RemotePairResult & { before: number }>();
  const [status, setStatus] = useState<RemoteSessionsResult>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const sessions = status?.sessions ?? [];

  const readSessions = async () => {
    const answer = await window.parallax.request(localId, "remote/sessions", {});
    if ("result" in answer) setStatus(answer.result);
  };
  useEffect(() => {
    if (!connected) return;
    void window.parallax.request(localId, "host/settings/get", {}).then((answer) => {
      if ("result" in answer) setOn(answer.result.remote);
    });
    void readSessions();
  }, [connected]);
  // While a code is up, a computer that pairs shows up here, and the code goes. A bind that
  // failed shows up too.
  const showing = code && sessions.length <= code.before ? code : undefined;
  const polling = !!showing || (on && !status?.listening);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void readSessions(), 2000);
    return () => clearInterval(timer);
  }, [polling]);

  const toggle = async (next: boolean) => {
    const answer = await window.parallax.request(localId, "host/settings/set", { remote: next });
    if ("error" in answer) return setError(answer.error.message);
    setError(undefined);
    setOn(answer.result.remote);
    setCode(undefined);
    void readSessions();
  };
  const pair = async () => {
    const answer = await window.parallax.request(localId, "remote/pair", {});
    if ("error" in answer) return setError(answer.error.message);
    setError(undefined);
    setCode({ ...answer.result, before: sessions.length });
  };
  const revoke = async (id: string) => {
    const answer = await window.parallax.request(localId, "remote/revoke", { id });
    if ("error" in answer) return setError(answer.error.message);
    setStatus(answer.result);
  };

  return (
    <>
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
          <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
            {status.problem}
          </p>
        )}
        {on && status?.listening && (
          <Row
            title="Pair a device"
            description={
              showing ? (
                <>
                  On the other computer, choose Add computer, pick{" "}
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
                className="font-mono text-[17px] font-semibold tracking-widest"
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
        {error && (
          <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
            {error}
          </p>
        )}
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
            Add computer
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
            <p className="text-[13px] font-medium">No paired computers yet</p>
            <p className="max-w-sm text-[12.5px] text-muted-foreground">
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
 * Add computer: the computers showing a code on this network, by name, or an address typed in
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
      <p className="text-[12.5px] text-muted-foreground">{GRANTS}</p>
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
            <span className="text-[12.5px] text-muted-foreground">Looking for computers…</span>
          )}
          {typeof found === "string" && <span className="text-[12.5px] text-danger">{found}</span>}
          {Array.isArray(found) && !found.length && (
            <span className="text-[12.5px] text-muted-foreground">
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
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/** A computer this app paired with: its connection, its routes in order, and Remove. */
function LanComputer({ computer }: { computer: Host }) {
  const state = useConnection(computer.id);
  const [error, setError] = useState<string>();
  const tone = state?.status === "connected" ? "on" : state?.status === "failed" ? "warn" : "off";
  return (
    <div className={settingRow}>
      <div className="min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <StatusDot tone={tone} />
          <span className="truncate">{computer.name}</span>
        </span>
        <span className="block truncate text-[12.5px] text-muted-foreground">
          <span className="font-mono">{computer.routes?.join(", ")}</span>
          {state && ` · ${statusLabel(state)}`}
          {state?.status === "connected" && ` · plxd ${state.plxd}`}
        </span>
        {state?.status === "failed" && (
          <span className="block text-[12.5px] text-muted-foreground">{state.error.message}</span>
        )}
        {error && (
          <span role="alert" className="block text-[12.5px] text-danger">
            {error}
          </span>
        )}
      </div>
      <button
        type="button"
        className={quietButton}
        onClick={() => void window.parallax.removeHost(computer.id).then(setError)}
      >
        Remove
      </button>
    </div>
  );
}
