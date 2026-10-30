import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Cloud,
  Image,
  ImageOff,
  KeyRound,
  Network,
  Octagon,
  Plus,
  RefreshCw,
  ShieldQuestion,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { DeviceHost } from "../preload/bridge";
import type { ImportableSession, RemoteControlOrigin } from "../protocol/generated/protocol";
import { NewComputerDialog } from "./AccountPrompts";
import { statusLabel, useConnection, useConnections } from "./ConnectionStatus";
import { accessLabel, ConnectWizard } from "./ConnectWizard";
import { DeviceIcon } from "./DeviceIcon";
import { describeError } from "./errors";
import { useConnect, useHosts } from "./hosts";
import { ClaudeLogo } from "./logos";
import { useProfile } from "./profile";
import { primaryButton, quietButton } from "./settings/parts";
import { stored } from "./stored";
import { IconButton } from "./ui";

/** The kind of computer each platform Claude Code reports is, as Node names them. */
const computerOf: Record<string, string> = {
  darwin: "a Mac",
  win32: "a Windows computer",
  linux: "a Linux computer",
};

/** How long a computer has to connect and answer once it's picked. */
const CONNECT_WAIT_MS = 120_000;

/**
 * The Remote Control threads kept as they are, as `<host>:<run>`, so their first open asks once.
 */
export const keptRemoteControl = stored<string[]>(
  "parallax:remoteControlKept",
  [],
  (raw, fallback) =>
    Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : fallback,
);

type Step =
  | { kind: "choose" }
  | { kind: "finding"; what: string }
  | { kind: "signIn"; error?: string }
  /** The account's computers, with the name of the one just found without the session. */
  | { kind: "pick"; missing?: string }
  | { kind: "connecting"; device: DeviceHost }
  | { kind: "moving"; where: string }
  | { kind: "done"; hostId: string; threadId: string; where: string }
  | { kind: "failed"; why: string };

/**
 * A Claude Remote Control thread's choice (PLX-1143), a modal dialog open while it's mounted: keep
 * it, sending through `claude.ai`, or move it to the computer its session runs on, through Parallax
 * Connect. Moving reads where the session runs from `claude.ai`, which doesn't name the computer,
 * then looks for the session on each connected computer. When none has it, it lists the Parallax
 * account's computers (0091), reached through Parallax Relay with no inbound port, so a computer
 * whose user can't open its firewall works too (PLX-1178). Add a computer shows the command that
 * adds one. Once the picked computer answers with the session, it imports it there, brings it out
 * of the archive, and archives the Remote Control thread.
 */
export function MoveRemoteControl({
  hostId,
  runId,
  title,
  onKeep,
  onClose,
  onOpen,
}: {
  /** The Remote Control thread's host and run. */
  hostId: string;
  runId: string;
  title: string;
  onKeep: () => void;
  onClose: () => void;
  /** Opens the moved thread. */
  onOpen: (hostId: string, threadId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  const [adding, setAdding] = useState(false);
  const [entering, setEntering] = useState<DeviceHost>();
  const origin = useRef<RemoteControlOrigin>(undefined);
  const live = useRef(true);
  const connect = useConnect();
  const profile = useProfile();
  const hosts = useHosts();
  const states = useConnections(hosts.map((h) => h.id));
  // The latest hosts, states, and sign-in, for steps that run across renders.
  const now = useRef({ hosts, states, profile });
  now.current = { hosts, states, profile };
  useEffect(() => window.parallax.onDevices(setDevices), []);
  const computers = devices.filter((d) => d.id.startsWith("account:"));

  useEffect(() => {
    live.current = true;
    dialog.current?.showModal();
    return () => {
      live.current = false;
    };
  }, []);

  const close = () => dialog.current?.close();
  const show = (next: Step) => {
    if (live.current) setStep(next);
  };
  const fail = (why: string) => show({ kind: "failed", why });

  /** The session on host `id`, as its Claude sessions to import list it. */
  const sessionOn = async (id: string): Promise<ImportableSession | undefined> => {
    const answer = await window.parallax.request(id, "thread/importable", {});
    if ("error" in answer) return undefined;
    const wanted = origin.current?.sessionId;
    return answer.result.sessions.find(
      (s) => s.source === "claude" && !s.remote && (s.id === wanted || s.claudeSession === wanted),
    );
  };

  /** Makes `session` on host `target` a normal thread there, and archives this one. */
  const move = async (target: string, where: string, session: ImportableSession) => {
    // Closed while it looked: nothing moves.
    if (!live.current) return;
    show({ kind: "moving", where });
    let thread = session.thread;
    if (!thread) {
      const imported = await window.parallax.request(target, "thread/import", {
        source: "claude",
        id: session.id,
      });
      if ("error" in imported) return fail(describeError(imported.error));
      thread = imported.result.thread.id;
    }
    const out = await window.parallax.request(target, "thread/archive", {
      runId: thread,
      archived: false,
    });
    if ("error" in out) return fail(describeError(out.error));
    const archived = await window.parallax.request(hostId, "thread/archive", {
      runId,
      archived: true,
    });
    if ("error" in archived) return fail(describeError(archived.error));
    show({ kind: "done", hostId: target, threadId: thread, where });
  };

  /** Lists the account's computers, asking the account for them. */
  const listComputers = () => {
    // Closed while it looked: the account isn't asked.
    if (!live.current) return;
    show({ kind: "pick" });
    void window.parallax.discoverAccount();
  };

  /** Reads where the session runs, then looks for it on the connected computers, then the account's. */
  const find = async () => {
    show({ kind: "finding", what: "Reading the session on claude.ai" });
    const answer = await window.parallax.request(hostId, "thread/remoteControlOrigin", { runId });
    if ("error" in answer) return fail(describeError(answer.error));
    if (!answer.result.origin?.sessionId)
      return fail(
        "claude.ai doesn't say which Claude Code session this is, so its computer can't be found.",
      );
    origin.current = answer.result.origin;
    show({ kind: "finding", what: "Looking for it on your computers" });
    const { hosts, states } = now.current;
    for (const [i, host] of hosts.entries()) {
      const state = states[i];
      if (state?.status !== "connected" || !("threadImport" in state.capabilities)) continue;
      const session = await sessionOn(host.id);
      if (session) return move(host.id, host.name, session);
    }
    if (now.current.profile === null) return show({ kind: "signIn" });
    listComputers();
  };

  /** Signs in in the browser, then lists the account's computers, before the profile catches up. */
  const signIn = async () => {
    show({ kind: "finding", what: "Signing in to Parallax in your browser" });
    const failed = await window.parallax.signIn(false);
    if (failed) return show({ kind: "signIn", error: failed });
    listComputers();
  };

  /** Waits for `device` to connect, then moves the session there if it has it. */
  const reach = async (device: DeviceHost) => {
    show({ kind: "connecting", device });
    await window.parallax.setDeviceEnabled(device.id, true);
    const until = Date.now() + CONNECT_WAIT_MS;
    while (live.current && Date.now() < until) {
      const state = await window.parallax.connectionState(device.id).catch(() => undefined);
      if (state?.status === "connected") {
        const session = await sessionOn(device.id);
        if (session) return move(device.id, device.name, session);
        return show({ kind: "pick", missing: device.name });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail(`${device.name} didn't connect within two minutes. Check that it's on and try again.`);
  };

  const where = origin.current?.cwd?.split(/[\\/]/).filter(Boolean).pop();
  const computer = computerOf[origin.current?.platform ?? ""];
  const heading: Record<Step["kind"], [string, string]> = {
    choose: ["Claude Remote Control thread", `${title} runs on another computer.`],
    finding: ["Finding its computer", "Where this session runs."],
    signIn: [
      "Sign in to reach its computer",
      "Parallax Connect finds your computers through your Parallax account.",
    ],
    pick: [
      "Which computer runs it?",
      `claude.ai doesn't name it${computer ? `, but it's ${computer}` : ""}. Your computers:`,
    ],
    connecting: [
      step.kind === "connecting" ? `Connecting to ${step.device.name}` : "",
      "Then Parallax looks for this session there.",
    ],
    moving: [
      step.kind === "moving" ? `Moving to ${step.where}` : "",
      "It continues there as a Parallax thread.",
    ],
    done: [step.kind === "done" ? `Moved to ${step.where}` : "", "It's a Parallax thread now."],
    failed: ["Couldn't move it", "Try again picks up where it stopped."],
  };
  const [heading1, line] = heading[step.kind];

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={(e) => {
        // Keep a nested dialog's close from closing this one too.
        if (e.target === dialog.current) onClose();
      }}
      className="m-auto max-h-[90vh] w-[38rem] max-w-[94vw] rounded-xl border border-border bg-background text-foreground shadow-composer backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[90vh] flex-col">
        <header className="flex items-start gap-3 px-6 pt-5 pb-4">
          <Mark step={step} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-heading font-semibold tracking-tight">
              {heading1}
            </h2>
            <p className="mt-0.5 truncate text-body text-muted-foreground">{line}</p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X aria-hidden />
          </IconButton>
        </header>

        {step.kind === "choose" && (
          <div className="flex flex-col gap-2 px-6 pb-6">
            <Choice
              icon={<Network aria-hidden />}
              title="Move it to Parallax Connect"
              badge="Recommended"
              onClick={() => void find()}
              points={[
                [<Image key="i" aria-hidden />, "Images, Stop, and permission prompts work"],
                [<SquareTerminal key="t" aria-hidden />, "Its terminal, files, and Git are here"],
              ]}
            >
              Parallax finds its computer on your Parallax account, then continues the session there
              as a normal thread, in the same folder.
            </Choice>
            <Choice
              icon={<Cloud aria-hidden />}
              title="Keep it on Remote Control"
              onClick={() => {
                onKeep();
                close();
              }}
              points={[
                [<ImageOff key="i" aria-hidden />, "Text and text files only, no images"],
                [<Octagon key="o" aria-hidden />, "Stop and permission prompts stay in Claude"],
                [
                  <ShieldQuestion key="s" aria-hidden />,
                  "Messages sent from Claude between turns don't show",
                ],
              ]}
            >
              Messages go to the session through claude.ai, and its replies stream back.
            </Choice>
          </div>
        )}

        {(step.kind === "finding" || step.kind === "connecting" || step.kind === "moving") && (
          <Working>
            {step.kind === "finding"
              ? step.what
              : step.kind === "connecting"
                ? `Waiting for ${step.device.name} to answer`
                : "Importing the session and archiving this thread"}
          </Working>
        )}

        {step.kind === "signIn" && (
          <>
            {step.error && (
              <p
                role="alert"
                className="mx-6 mb-5 flex items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-body [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
              >
                <CircleX aria-hidden className="text-danger" />
                {step.error}
              </p>
            )}
            <Footer>
              <button type="button" className={quietButton} onClick={close}>
                Close
              </button>
              <button
                type="button"
                className={`${primaryButton} flex items-center gap-1.5 [&_svg]:size-3.5`}
                onClick={() => void signIn()}
              >
                <KeyRound aria-hidden />
                Sign in
              </button>
            </Footer>
          </>
        )}

        {step.kind === "pick" && (
          <>
            {step.missing && (
              <p className="mx-6 mb-3 flex items-start gap-2 text-body text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
                <CircleX aria-hidden className="text-danger" />
                Claude Code on {step.missing} has no transcript of this session.
              </p>
            )}
            {computers.length ? (
              <ul
                aria-label="Your computers"
                className="mx-6 mb-5 min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-1"
              >
                {computers.map((device) => (
                  <ComputerRow
                    key={device.id}
                    device={device}
                    onMove={() => void reach(device)}
                    onEnterCode={() => setEntering(device)}
                  />
                ))}
              </ul>
            ) : (
              <p className="mx-6 mb-5 rounded-xl border border-border bg-surface px-4 py-3 text-body text-muted-foreground">
                No other computers on your Parallax account yet. Add the one that runs this session.
              </p>
            )}
            <Footer
              start={
                <button
                  type="button"
                  onClick={() => void window.parallax.discoverAccount()}
                  className={`${quietButton} -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
                >
                  <RefreshCw aria-hidden />
                  Refresh
                </button>
              }
            >
              <button
                type="button"
                disabled={!connect}
                className={`${primaryButton} flex items-center gap-1.5 [&_svg]:size-3.5`}
                onClick={() => setAdding(true)}
              >
                <Plus aria-hidden />
                Add a computer
              </button>
            </Footer>
          </>
        )}

        {step.kind === "done" && (
          <>
            <div className="px-6 pb-5">
              <p className="rounded-xl border border-border bg-surface px-4 py-3 text-body text-muted-foreground">
                It continues on {step.where}
                {where ? ` in ${where}` : ""}, where messages run Claude Code directly. The Remote
                Control thread is archived here.
              </p>
            </div>
            <Footer>
              <button
                type="button"
                className={primaryButton}
                onClick={() => {
                  onOpen(step.hostId, step.threadId);
                  close();
                }}
              >
                Open thread
              </button>
            </Footer>
          </>
        )}

        {step.kind === "failed" && (
          <>
            <p
              role="alert"
              className="mx-6 mb-5 flex items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-body [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
            >
              <CircleX aria-hidden className="text-danger" />
              {step.why}
            </p>
            <Footer>
              <button type="button" className={quietButton} onClick={close}>
                Close
              </button>
              <button type="button" className={primaryButton} onClick={() => void find()}>
                Try again
              </button>
            </Footer>
          </>
        )}
      </div>
      {adding && connect && (
        <ConnectWizard
          channel={connect.channel}
          devices={devices}
          onClose={() => setAdding(false)}
          onEnterCode={setEntering}
        />
      )}
      {entering && (
        <NewComputerDialog
          key={entering.id}
          computer={entering}
          onClose={() => setEntering(undefined)}
        />
      )}
    </dialog>
  );
}

/** The dialog's mark: Claude with a cloud while it's a Remote Control thread, then a check. */
function Mark({ step }: { step: Step }) {
  const box =
    "relative grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-surface [&_svg]:size-4.5";
  if (step.kind === "done")
    return (
      <span className={`${box} text-added`}>
        <CircleCheck aria-hidden />
      </span>
    );
  if (step.kind === "connecting")
    return (
      <span className={`${box} text-muted-foreground`}>
        <DeviceIcon icon={step.device.icon} />
      </span>
    );
  return (
    <span className={box}>
      <ClaudeLogo aria-hidden />
      <span className="absolute -right-1.5 -bottom-1.5 grid size-4 place-items-center rounded-full border border-border bg-background text-muted-foreground">
        <Cloud aria-hidden className="!size-2.5" strokeWidth={2.5} />
      </span>
    </span>
  );
}

/** One way to go on, as a card that takes it when clicked. */
function Choice({
  icon,
  title,
  badge,
  points,
  onClick,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  points: [ReactNode, string][];
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-foreground/20 hover:bg-hover"
    >
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-body font-semibold">{title}</span>
          {badge && (
            <span className="rounded-full bg-accent/10 px-2 py-px text-meta font-medium text-accent">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-body text-muted-foreground">{children}</span>
        <ul className="mt-2 flex flex-col gap-1">
          {points.map(([mark, text]) => (
            <li
              key={text}
              className="flex items-center gap-2 text-meta text-faint-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              {mark}
              {text}
            </li>
          ))}
        </ul>
      </span>
      <ChevronRight
        aria-hidden
        className="mt-2 size-4 shrink-0 text-faint-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </button>
  );
}

/**
 * An account computer to move to: Move here, or Enter code while it's new here. While this device
 * waits to be allowed, it says so instead.
 */
function ComputerRow({
  device,
  onMove,
  onEnterCode,
}: {
  device: DeviceHost;
  onMove: () => void;
  onEnterCode: () => void;
}) {
  const state = useConnection(device.id);
  const connected = state?.status === "connected";
  const status = connected
    ? "Connected"
    : (accessLabel(device) ?? (state ? statusLabel(state) : "Connecting…"));
  return (
    <li className="flex items-center gap-3 rounded-lg px-2.5 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
        <DeviceIcon icon={device.icon} className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">{device.name}</span>
        <span className="block truncate text-meta text-faint-foreground">{status}</span>
      </span>
      {device.access?.step === "needsCode" ? (
        <button type="button" className={primaryButton} onClick={onEnterCode}>
          Enter code
        </button>
      ) : (
        <button type="button" disabled={!!device.access} className={primaryButton} onClick={onMove}>
          Move here
        </button>
      )}
    </li>
  );
}

/** A step in progress: what it's doing, shimmering. */
function Working({ children }: { children: ReactNode }) {
  return (
    <div className="mx-6 mb-6 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-faint-foreground">
        <Network aria-hidden className="size-4 animate-pulse" />
      </span>
      <span role="status" className="shimmer-text min-w-0 flex-1 truncate text-body font-medium">
        {children}
      </span>
    </div>
  );
}

/** The dialog's footer: `start` on the left, its buttons on the right, under a rule. */
function Footer({ children, start }: { children: ReactNode; start?: ReactNode }) {
  return (
    <footer className="flex items-center gap-2 border-t border-border px-6 py-3">
      <div className="flex-1">{start}</div>
      {children}
    </footer>
  );
}
