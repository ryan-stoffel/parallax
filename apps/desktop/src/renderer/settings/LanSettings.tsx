import { t } from "i18next";
import { Activity, KeyRound, Plus, Terminal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Trans } from "react-i18next";

import { msg } from "../../i18n";

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
import { ParallaxMark } from "../logos";
import { Dialog } from "../ui";
import { AccessRow, badge, card, CollapsibleCard } from "./connectionParts";
import {
  ConfirmRemove,
  outlineButton,
  primaryButton,
  quietButton,
  rowField,
  StatusDot,
  Switch,
} from "./parts";

/** A SHA-256 fingerprint in hex as browsers show it: `AB CD …`. */
const fingerprint = (hex: string) => hex.toUpperCase().match(/../g)!.join(" ");

/** What a paired computer can do, said where a pairing code is shown. Shown with `t`. */
const GRANTS = msg(
  "A paired computer has full control of this one: it can run agents and commands with full access, open terminals, change settings, and pair other computers, until you make it read-only. Share the code only with your own computers.",
);

/**
 * Why read-only is for good: it belongs to the device's key, and only a new key has full access
 * (0091). Shown with `t`.
 */
const READ_ONLY_FOR_GOOD = msg(
  "This can't be undone. To give it full access, revoke it, then pair it again, or choose Start over with a new key in that device's Settings.",
);

/** How the connection check names a part. Shown with `t`. */
const CHECK_PARTS: Record<RelayCheckPart, string> = {
  signIn: msg("Sign-in"),
  relay: "Parallax Connect",
  listener: msg("Listener"),
  stream: msg("Stream"),
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
    if (failed) notify({ tone: "error", title: t("Couldn't sign in"), body: failed });
  };
  return {
    signedIn: !!profile,
    signedOut: profile === null,
    signingIn,
    onSignIn: () => void signIn(),
  };
}

/**
 * How computers reach this one, read from the local plxd, with what changes it: Parallax Connect,
 * its `relay`, which registers it with Parallax Relay (PLX-652); pairing on the same
 * network, its `remote` (PLX-641, 0065), and Open in a browser, its `remoteWeb` (PLX-651); and
 * `agentWork` (0101), which it and pairing change in each other. With them, the devices paired with
 * or signed in to this computer, which can be revoked or made read-only (PLX-1364), a pairing code
 * while one is on show, and the account's computers on the relay while Parallax Connect is on.
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
        return failed(
          next ? t("Couldn't turn pairing on") : t("Couldn't turn pairing off"),
          answer.error.message,
        );
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
        return failed(
          next ? t("Couldn't turn agent work on") : t("Couldn't turn agent work off"),
          answer.error.message,
        );
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
          next ? t("Couldn't turn Open in a browser on") : t("Couldn't turn Open in a browser off"),
          answer.error.message,
        );
      setWeb(answer.result.remoteWeb);
    },
    // On, it registers this computer under the signed-in account first: main sends the token to plxd.
    toggleRelay: async (next: boolean) => {
      retry();
      const title = next
        ? t("Couldn't turn Parallax Connect on")
        : t("Couldn't turn Parallax Connect off");
      const registered = next ? await window.parallax.registerRelay() : undefined;
      if (registered) return failed(title, registered);
      const answer = await window.parallax.request(localId, "host/settings/set", { relay: next });
      if ("error" in answer) return failed(title, answer.error.message);
      setRelay(answer.result.relay);
      void readSessions();
    },
    toggleTailscale: async (next: boolean) => {
      const answer = await window.parallax.setConnect(next);
      if (answer)
        failed(next ? t("Couldn't turn Tailscale on") : t("Couldn't turn Tailscale off"), answer);
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
      if ("error" in answer) return failed(t("Couldn't make a pairing code"), answer.error.message);
      setCode({ ...answer.result, before: sessions.length });
      void readSessions();
    },
    // A device signed in with the account loses its key on every computer this app reaches (0091).
    revoke: async (id: string) => {
      retry();
      const answer = await window.parallax.revokeDevice(id);
      if (typeof answer === "string") return failed(t("Couldn't revoke the computer"), answer);
      setStatus(answer);
    },
    // It reaches every computer this app reaches, closes the device's connections, and can't be undone.
    makeReadOnly: async (id: string) => {
      retry();
      const answer = await window.parallax.makeDeviceReadOnly(id);
      if (typeof answer === "string")
        return failed(t("Couldn't make the computer read-only"), answer);
      setStatus(answer);
    },
  };
}

export type LocalAccess = ReturnType<typeof useLocalAccess>;

/** A line under a setting's description saying what it's doing now. */
const statusLine = "mt-1 block text-meta text-foreground";

/** Where SSH is turned on, on this computer's OS, for people. Shown with `t`. */
const SSH_SETTING: Record<string, string> = {
  darwin: msg("Remote Login in System Settings › General › Sharing"),
  win32: msg("OpenSSH Server in Windows' optional features"),
  linux: msg("the OpenSSH server (sshd)"),
};

/**
 * Sharing & access' first card, Parallax Connect: this computer's `relay`, which registers it with
 * Parallax Relay so the phone and the account's computers reach it from anywhere (PLX-652, 0091).
 * Its switch, or Sign in while signed out, since it can't turn on without the account; while it's
 * on, whether it's connected and how many of the account's computers there are, and Check connection
 * (PLX-1356), which opens a real stream back to this computer, says which part failed and what to
 * do, and copies a report with no secret in it. It runs only when asked, since each run counts
 * against the relay's streams a minute. Under it, the setup code another computer adds this one with.
 */
export function ConnectCard({
  access,
  signedOut,
  signingIn,
  onSignIn,
  onShowCode,
}: {
  access: LocalAccess;
  signedOut: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  /** Opens Show setup code. Absent while signed out, when there's no account to add it to. */
  onShowCode?: () => void;
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
  const linked = status?.relay?.connected;
  return (
    <section aria-label="Parallax Connect" className={`${card} mb-6`}>
      <div
        data-setting="parallax-connect"
        className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4"
      >
        <div className="flex min-w-[min(16rem,100%)] flex-1 items-start gap-3.5">
          <ParallaxMark className="mt-0.5 size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-reading font-semibold">Parallax Connect</h2>
            <p className="mt-0.5 text-meta text-muted-foreground">
              {t(
                "Reach this computer from your phone and your other computers, wherever they are. Parallax Connect can't read your threads.",
              )}
            </p>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {access.relay === undefined ? null : signedOut && !relay ? (
            <button type="button" disabled={signingIn} onClick={onSignIn} className={primaryButton}>
              {signingIn ? t("Waiting for your browser…") : t("Sign in")}
            </button>
          ) : (
            <Switch
              label="Parallax Connect"
              checked={!!relay}
              onChange={(next) => void access.toggleRelay(next)}
            />
          )}
        </div>
      </div>
      {relay && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/40 px-4 py-3">
          <div className="min-w-[min(14rem,100%)] flex-1">
            <span role="status" className="flex items-center gap-2 text-body">
              <StatusDot tone={linked ? "on" : status?.relay?.problem ? "error" : "off"} />
              <span>
                {linked ? t("Connected") : (status?.relay?.problem ?? t("Connecting…"))}
                {!!relayHosts?.length && (
                  <span className="text-muted-foreground">
                    {" "}
                    ·{" "}
                    {t("{{used}} of {{count}} computers on your account", {
                      used: relayHosts.length,
                      count: ACCOUNT_COMPUTERS,
                    })}
                  </span>
                )}
              </span>
            </span>
            {(checking || result !== undefined) && (
              <span role="status" className={statusLine}>
                {checking
                  ? t("Checking…")
                  : typeof result === "string"
                    ? result
                    : report?.failed
                      ? t("{{part}} failed. {{problem}} {{fix}}", {
                          part: t(CHECK_PARTS[report.failed]),
                          problem: report.problem,
                          fix: report.fix,
                        })
                      : t("Working. The connection took {{ms}} ms.", { ms: report?.roundTripMs })}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {report && !checking && (
              <button
                type="button"
                className={quietButton}
                onClick={() => copy(report.diagnostics)}
              >
                {copied ? t("Copied") : t("Copy diagnostics")}
              </button>
            )}
            <button
              type="button"
              className={outlineButton}
              disabled={checking}
              title={t("Opens a real connection through Parallax Connect back to this computer.")}
              onClick={() => void check()}
            >
              <Activity aria-hidden />
              {t("Check connection")}
            </button>
          </div>
        </div>
      )}
      <div className="border-t border-border/40">
        <AccessRow
          title={t("Setup code")}
          description={
            onShowCode
              ? t("Adding this computer from another one? Show this code there.")
              : t("Sign in first, then show this code on the computer adding this one.")
          }
        >
          <button
            type="button"
            disabled={!onShowCode}
            onClick={onShowCode}
            className={outlineButton}
          >
            <KeyRound aria-hidden />
            {t("Show setup code")}
          </button>
        </AccessRow>
      </div>
    </section>
  );
}

/**
 * Sharing & access' SSH card: how another computer adds this one over SSH. Parallax can't see or
 * change whether SSH is on here, so it says where that is, and what Add computer does.
 */
export function SshCard() {
  const setting = SSH_SETTING[window.parallax.platform];
  const where = setting ? t(setting) : t("an SSH server");
  return (
    <section aria-label="SSH" data-setting="ssh" className={`${card} mb-10`}>
      <div className="flex items-start gap-3.5 px-4 py-4">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center text-muted-foreground [&_svg]:size-5">
          <Terminal aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-reading font-semibold">SSH</h2>
          <p className="mt-0.5 text-meta text-muted-foreground">
            {t(
              "Add this computer from another one: there, choose Add computer, then Over SSH, and enter your user and this computer's address. Parallax installs plxd here if it's missing.",
            )}
          </p>
          <p className="mt-1 text-meta text-muted-foreground">
            {t("Turn on {{where}} first.", { where })}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Sharing & access' less common ways in, under their own quiet heading: pairing on the same network
 * (PLX-641, 0065), Open in a browser, which serves the app from this computer's listener for a
 * browser to pair with and so needs pairing on (PLX-651), whether agents on the user's other
 * computers can work here (0101), and Tailscale (0056), only while it's on, so it can be turned off.
 * Each says what it's for, so a new user can tell them apart.
 */
export function MoreWaysIn({
  access,
  connect,
}: {
  access: LocalAccess;
  connect: ConnectState | undefined;
}) {
  const { web, on, status, showing } = access;
  const addresses = (showing?.addresses ?? [t("this computer's address")])
    .map((a) => `https://${a.includes(":") ? a : `${a}:7341`}`)
    .join(", ");
  return (
    <section aria-label={t("More ways in")} className="mb-10">
      <h2 className="mb-3 text-body font-medium text-muted-foreground">{t("More ways in")}</h2>
      <div className={card}>
        <AccessRow
          title={t("Pair on this network")}
          description={t(
            "Let a computer, phone or browser on the same network pair with a one-time code. Use it without a Parallax account.",
          )}
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
            label={t("Pair on this network")}
            checked={!!on}
            disabled={on === undefined}
            onChange={(next) => void access.toggle(next)}
          />
        </AccessRow>
        {web !== undefined && (
          <AccessRow
            title={t("Open in a browser")}
            description={
              !on || !web ? (
                t(
                  "Use Parallax from a web browser on another device on this network. It pairs like a computer, so it needs Pair on this network.",
                )
              ) : (
                <Trans values={{ addresses }}>
                  Open <span className="font-mono text-foreground">{"{{addresses}}"}</span> and pair
                  with a code from Pair a device. Use the Tailscale address where you can. On this
                  network the browser warns about this computer's certificate: continue only if it
                  shows this SHA-256 fingerprint, or trust the certificate in your OS first.
                  Otherwise someone on the network could pose as this computer. Turning this off
                  disconnects paired browsers.
                </Trans>
              )
            }
            status={
              on &&
              web &&
              status?.fingerprint && (
                <span
                  aria-label={t("Certificate fingerprint")}
                  className="mt-1 block font-mono text-meta break-all text-foreground"
                >
                  {fingerprint(status.fingerprint)}
                </span>
              )
            }
          >
            <Switch
              label={t("Open in a browser")}
              checked={!!on && web}
              disabled={!on}
              onChange={(next) => void access.toggleWeb(next)}
            />
          </AccessRow>
        )}
        {access.canAgentWork && (
          <AccessRow
            title={t("Agents can work here")}
            description={t(
              "Let agents on your other computers run commands on this one, as you. Use it to hand work to this computer. Needs Parallax Connect, and turns on pairing.",
            )}
            status={
              access.agentWork &&
              !access.relay && (
                <span className="mt-1 block text-meta text-warning">
                  {t("Needs Parallax Connect")}
                </span>
              )
            }
          >
            <Switch
              label={t("Let agents on my other computers work here")}
              checked={!!access.agentWork}
              onChange={(next) => void access.toggleAgentWork(next)}
            />
          </AccessRow>
        )}
        {connect?.on && (
          <AccessRow
            title="Tailscale"
            description={t(
              "On from an older setup. Parallax Connect and SSH reach this computer without it. Turn it off unless you use Tailscale devices in Parallax.",
            )}
          >
            <Switch
              label="Tailscale"
              checked
              onChange={(next) => void access.toggleTailscale(next)}
            />
          </AccessRow>
        )}
      </div>
    </section>
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
      title={t("Devices with access")}
      summary={
        sessions.length > 0 &&
        t("{{count}} devices", { count: sessions.length, defaultValue_one: "{{count}} device" })
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
            {t("Pair a device")}
          </button>
        )
      }
    >
      {/* Where a search for Pair a device lands while its button isn't there. */}
      <div data-setting={canPair || showing ? undefined : "pair-a-device"}>
        {showing && (
          <AccessRow
            title={t("Pair a device")}
            description={
              <Trans values={{ name: showing.name, grants: t(GRANTS) }}>
                On the other computer, choose Add computer, then On this network, pick{" "}
                <span className="text-foreground">{"{{name}}"}</span>, and enter this code. It works
                once, for 5 minutes. {"{{grants}}"}
              </Trans>
            }
          >
            <span
              aria-label={t("Pairing code")}
              className="font-mono text-heading font-semibold tracking-widest"
            >
              {showing.code}
            </span>
            <button type="button" className={quietButton} onClick={() => void access.pair()}>
              {t("New code")}
            </button>
          </AccessRow>
        )}
        {sessions.map((s) => {
          const paired = t("Paired {{date}}", { date: new Date(s.createdAt).toLocaleDateString() });
          return (
            <div
              key={s.id}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-border/40 px-4 py-3 not-last:border-b"
            >
              <div className="min-w-[min(14rem,100%)] flex-1">
                <span className="flex items-center gap-2 text-body font-medium">
                  <span className="truncate">{s.name || t("Unnamed computer")}</span>
                  {s.readOnly && (
                    <span className={`${badge} text-muted-foreground`}>{t("Read-only")}</span>
                  )}
                </span>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  {confirming === s.id
                    ? `${t("Make this computer read-only on all your computers? It can read threads but not change anything.")} ${t(READ_ONLY_FOR_GOOD)}`
                    : s.readOnly
                      ? t(
                          "{{paired}}. It reads threads and can't change anything. For full access, revoke it, then pair it again or choose Start over with a new key on that device.",
                          { paired },
                        )
                      : paired}
                </span>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {confirming === s.id ? (
                  <ConfirmRemove
                    label={t("Make read-only")}
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
                        {t("Make read-only")}
                      </button>
                    )}
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => void access.revoke(s.id)}
                    >
                      {t("Revoke")}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {!sessions.length && !showing && (
          <p className="px-4 py-3 text-body text-muted-foreground">
            {t("Nothing has access yet.")}
            {!canPair && ` ${t("Turn on Pair on this network to pair a device.")}`}
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
            {t("Add a computer on this network")}
          </h2>
          <p className="mt-1.5 text-body text-muted-foreground">
            {t(
              "On the other computer, turn on Pair on this network in Settings › Sharing & access and choose Pair a device. Then enter the code it shows. Pair only your own computers.",
            )}
          </p>
        </div>
        {typing ? (
          <input
            aria-label={t("Address")}
            placeholder="192.168.1.20"
            className={`${rowField} font-mono`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoFocus
          />
        ) : (
          <div
            role="radiogroup"
            aria-label={t("Computers showing a code")}
            className="flex flex-wrap gap-1.5"
          >
            {found === undefined && (
              <span className="text-body text-muted-foreground">{t("Looking for computers…")}</span>
            )}
            {typeof found === "string" && <span className="text-body text-danger">{found}</span>}
            {Array.isArray(found) && !found.length && (
              <span className="text-body text-muted-foreground">
                {t("No computer on this network is showing a code.")}{" "}
                <button type="button" className="underline" onClick={() => void look()}>
                  {t("Look again")}
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
            aria-label={t("Code", { context: "pairing code" })}
            placeholder="7KQ-4M2"
            className={`${rowField.replace("w-56", "w-32")} font-mono uppercase`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="button" className={quietButton} onClick={() => setTyping((was) => !was)}>
            {typing ? t("Find computers instead") : t("Enter an address instead")}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={quietButton} onClick={() => dialog.current?.close()}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className={primaryButton}
            disabled={pairing || !target || !code.trim()}
          >
            {pairing ? t("Pairing…") : t("Pair")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
