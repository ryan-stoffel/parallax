import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleX,
  Cloud,
  Download,
  Image,
  ImageOff,
  KeyRound,
  Network,
  Octagon,
  RefreshCw,
  ShieldQuestion,
  SquareTerminal,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { iconFor } from "../preload/bridge";
import type {
  ImportableSession,
  RemoteControlOrigin,
  TailnetDevice,
} from "../protocol/generated/protocol";
import { useConnections } from "./ConnectionStatus";
import { osName, Plan } from "./ConnectWizard";
import { DeviceIcon } from "./DeviceIcon";
import { describeError } from "./errors";
import { localId, useConnect, useHosts } from "./hosts";
import { ClaudeLogo } from "./logos";
import { primaryButton, quietButton, rowField } from "./settings/parts";
import { stored } from "./stored";
import { IconButton } from "./ui";

const TerminalView = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalView })));

/** Tailscale's name for each platform Claude Code reports, as Node names them. */
const tailscaleOs: Record<string, string> = { darwin: "macOS", win32: "windows", linux: "linux" };

/** How long a computer just set up has to connect and answer. */
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
  | { kind: "pick"; os: string; devices: TailnetDevice[] }
  | { kind: "confirm"; device: TailnetDevice }
  | { kind: "install"; device: TailnetDevice; user?: string; run: number }
  | { kind: "connecting"; device: TailnetDevice }
  | { kind: "missing"; device: TailnetDevice; os: string; devices: TailnetDevice[] }
  | { kind: "moving"; where: string }
  | { kind: "noTailnet"; installed: boolean }
  | { kind: "noComputer"; os: string }
  | { kind: "done"; hostId: string; threadId: string; where: string }
  | { kind: "failed"; why: string };

/**
 * A Claude Remote Control thread's choice (PLX-1143), a modal dialog open while it's mounted: keep
 * it, sending through `claude.ai`, or move it to the computer its session runs on, through Parallax
 * Connect. Moving reads where the session runs from `claude.ai`, which doesn't name the computer,
 * then looks for the session on each connected computer. When none has it, it turns Connect on and
 * lists the tailnet's computers of the session's OS, to set one up as Add computer does or add one
 * that runs Connect. Once that computer answers with the session, it imports it there, brings it
 * out of the archive, and archives the Remote Control thread.
 */
export function MoveRemoteControl({
  hostId,
  runId,
  title,
  onKeep,
  onClose,
  onOpen,
  onAddWithSsh,
}: {
  /** The Remote Control thread's host and run. */
  hostId: string;
  runId: string;
  title: string;
  onKeep: () => void;
  onClose: () => void;
  /** Opens the moved thread. */
  onOpen: (hostId: string, threadId: string) => void;
  /** Opens Settings > Connections, to add the computer as an SSH host. */
  onAddWithSsh: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [user, setUser] = useState("");
  const origin = useRef<RemoteControlOrigin>(undefined);
  const live = useRef(true);
  const connect = useConnect();
  const hosts = useHosts();
  const states = useConnections(hosts.map((h) => h.id));
  // The latest hosts and states, for steps that run across renders.
  const now = useRef({ hosts, states, connect });
  now.current = { hosts, states, connect };

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

  /** Lists the tailnet's computers of the session's OS, turning Connect on first. */
  const lookOnTailnet = async () => {
    if (!now.current.connect?.on) {
      show({ kind: "finding", what: "Turning on Parallax Connect" });
      const failed = await window.parallax.setConnect(true);
      if (failed) return fail(failed);
    }
    show({ kind: "finding", what: "Asking Tailscale for your computers" });
    const answer = await window.parallax.request(localId, "connect/devices", {});
    if ("error" in answer) return fail(describeError(answer.error));
    const { tailscale, self, devices } = answer.result;
    if (tailscale !== "running")
      return show({ kind: "noTailnet", installed: tailscale !== "missing" });
    const os = tailscaleOs[origin.current?.platform ?? ""];
    const matching = devices
      .filter((d) => d.id !== self?.id && (os ? d.os === os : d.os in parallaxOs))
      .sort((a, b) => Number(b.online) - Number(a.online));
    if (!matching.length) return show({ kind: "noComputer", os: os ? osName(os) : "" });
    show({ kind: "pick", os: os ? osName(os) : "", devices: matching });
  };

  /** Reads where the session runs, then looks for it on the connected computers, then the tailnet. */
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
    await lookOnTailnet();
  };

  /** Waits for `device` to connect, then moves the session there if it has it. */
  const reach = async (device: TailnetDevice, devices: TailnetDevice[], os: string) => {
    show({ kind: "connecting", device });
    const id = `tailnet:${device.id}`;
    await window.parallax.setDeviceEnabled(id, true);
    const until = Date.now() + CONNECT_WAIT_MS;
    while (live.current && Date.now() < until) {
      const state = await window.parallax.connectionState(id).catch(() => undefined);
      if (state?.status === "connected") {
        const session = await sessionOn(id);
        // Its name in Parallax, once it's listed, else its Tailscale host name.
        const name = now.current.hosts.find((h) => h.id === id)?.name ?? device.hostName;
        if (session) return move(id, name, session);
        return show({ kind: "missing", device, os, devices });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail(`${device.hostName} didn't connect within two minutes. Check that it's on and try again.`);
  };

  const picking = useRef<{ os: string; devices: TailnetDevice[] }>({ os: "", devices: [] });
  const back = () => show({ kind: "pick", ...picking.current });
  const where = origin.current?.cwd?.split(/[\\/]/).filter(Boolean).pop();
  const heading: Record<Step["kind"], [string, string]> = {
    choose: ["Claude Remote Control thread", `${title} runs on another computer.`],
    finding: ["Finding its computer", "Where this session runs."],
    pick: [
      "Which computer runs it?",
      `claude.ai doesn't name it. Your ${step.kind === "pick" && step.os ? `${step.os} ` : ""}computers on Tailscale:`,
    ],
    confirm: [
      step.kind === "confirm" ? `Set up ${step.device.hostName}` : "",
      step.kind === "confirm" ? `${osName(step.device.os)} · ${step.device.ip}` : "",
    ],
    install: [
      step.kind === "install" ? `Setting up ${step.device.hostName}` : "",
      "Type its password in the terminal if it asks.",
    ],
    connecting: [
      step.kind === "connecting" ? `Connecting to ${step.device.hostName}` : "",
      "Then Parallax looks for this session there.",
    ],
    missing: [
      step.kind === "missing" ? `${step.device.hostName} doesn't have it` : "",
      "Pick the computer that runs claude remote-control.",
    ],
    moving: [
      step.kind === "moving" ? `Moving to ${step.where}` : "",
      "It continues there as a Parallax thread.",
    ],
    noTailnet: [
      "Tailscale isn't running here",
      "Parallax Connect reaches your computers over Tailscale.",
    ],
    noComputer: [
      "Its computer isn't on your tailnet",
      `No ${step.kind === "noComputer" && step.os ? `${step.os} ` : ""}computer on Tailscale but this one.`,
    ],
    done: [step.kind === "done" ? `Moved to ${step.where}` : "", "It's a Parallax thread now."],
    failed: ["Couldn't move it", "Nothing changed. The thread is still here."],
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
          {(step.kind === "confirm" || step.kind === "missing") && (
            <IconButton label="Back" onClick={back}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
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
              Parallax sets up its computer over Tailscale, then continues the session there as a
              normal thread, in the same folder.
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
                ? `Waiting for ${step.device.hostName} to answer`
                : "Importing the session and archiving this thread"}
          </Working>
        )}

        {(step.kind === "pick" || step.kind === "missing") && (
          <>
            {step.kind === "missing" && (
              <p className="mx-6 mb-3 flex items-start gap-2 text-body text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0">
                <CircleX aria-hidden className="text-danger" />
                Claude Code on {step.device.hostName} has no transcript of this session.
              </p>
            )}
            <ul
              aria-label="Your computers"
              className="mx-6 mb-5 min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-1"
            >
              {step.devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  onPick={() => {
                    picking.current = { os: step.os, devices: step.devices };
                    if (device.parallax) void reach(device, step.devices, step.os);
                    else show({ kind: "confirm", device });
                  }}
                />
              ))}
            </ul>
          </>
        )}

        {step.kind === "confirm" && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              show({
                kind: "install",
                device: step.device,
                ...(user.trim() && { user: user.trim() }),
                run: 0,
              });
            }}
          >
            <div className="flex flex-col gap-3 px-6 pb-5">
              <ul className="rounded-xl border border-border bg-surface">
                <Plan icon={<KeyRound aria-hidden />} title="Signs in over SSH">
                  To {step.device.ip}. If it asks for a password, type it in the terminal. It goes
                  only to {step.device.hostName}.
                </Plan>
                <Plan icon={<Download aria-hidden />} title="Installs Parallax">
                  {step.device.os === "linux" ? "plxd" : "The app and plxd"}, then turns on Parallax
                  Connect there.
                </Plan>
                <Plan icon={<ArrowRight aria-hidden />} title="Moves this thread">
                  It continues there{where ? ` in ${where}` : ""}, and this one is archived.
                </Plan>
              </ul>
              <label className="flex items-center justify-between gap-4 text-body">
                <span>
                  <span className="block font-medium">SSH user</span>
                  <span className="block text-body text-muted-foreground">
                    Empty uses your ssh config's, or your name here.
                  </span>
                </span>
                <input
                  name="user"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="Optional"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className={rowField}
                />
              </label>
            </div>
            <Footer>
              <button type="button" className={quietButton} onClick={back}>
                Back
              </button>
              <button type="submit" className={primaryButton}>
                Set up and move
              </button>
            </Footer>
          </form>
        )}

        {step.kind === "install" && (
          <>
            <div className="px-6 pb-5">
              {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
              <div className="h-72 rounded-xl border border-border bg-surface p-2">
                <Suspense>
                  <TerminalView
                    key={`${step.device.id}-${step.run}`}
                    id="connect-add"
                    target={{
                      hostId: localId,
                      connect: {
                        device: step.device.ip,
                        ...(step.user && { user: step.user }),
                        ...(step.device.os === "linux" && { headless: true }),
                      },
                    }}
                    label={`Setting up ${step.device.hostName}`}
                    onEnd={(why, exitCode) => {
                      if (!why && exitCode === 0)
                        return void reach(step.device, picking.current.devices, picking.current.os);
                      fail(why ?? `${step.device.hostName} wasn't set up. The terminal said why.`);
                    }}
                  />
                </Suspense>
              </div>
            </div>
          </>
        )}

        {(step.kind === "noTailnet" || step.kind === "noComputer") && (
          <>
            <div className="flex flex-col gap-2 px-6 pb-5">
              <ul className="rounded-xl border border-border bg-surface">
                <Plan icon={<Network aria-hidden />} title="Add it to your tailnet">
                  {step.kind === "noComputer"
                    ? "Install Tailscale on that computer and sign in with the same account"
                    : step.installed
                      ? "Open Tailscale here and sign in"
                      : "Install Tailscale here and on that computer, and sign in to both"}
                  , then try again.
                </Plan>
                <Plan icon={<KeyRound aria-hidden />} title="Or add it with SSH">
                  Add that computer as an SSH host in Settings, then move the thread from Thread
                  details.
                </Plan>
              </ul>
            </div>
            <Footer
              start={
                <a
                  href="https://tailscale.com/download"
                  target="_blank"
                  rel="noreferrer"
                  className={`${quietButton} -ml-2.5`}
                >
                  Get Tailscale
                </a>
              }
            >
              <button
                type="button"
                className={quietButton}
                onClick={() => {
                  close();
                  onAddWithSsh();
                }}
              >
                Add with SSH
              </button>
              <button
                type="button"
                className={`${primaryButton} flex items-center gap-1.5 [&_svg]:size-3.5`}
                onClick={() => void lookOnTailnet()}
              >
                <RefreshCw aria-hidden />
                Try again
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
    </dialog>
  );
}

/** Tailscale's OS names Parallax runs on. */
const parallaxOs = { macOS: 1, windows: 1, linux: 1 };

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
  if (step.kind === "confirm" || step.kind === "install" || step.kind === "connecting")
    return (
      <span className={`${box} text-muted-foreground`}>
        <DeviceIcon icon={iconFor(step.device.hostName)} />
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

/** A tailnet computer to move to: Set up, or Move when it already runs Parallax Connect. */
function DeviceRow({ device, onPick }: { device: TailnetDevice; onPick: () => void }) {
  const tone = device.online ? "text-muted-foreground" : "text-faint-foreground";
  return (
    <li className="flex items-center gap-3 rounded-lg px-2.5 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
        <DeviceIcon icon={iconFor(device.hostName)} className={`size-4 ${tone}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-body font-medium ${device.online ? "" : "text-muted-foreground"}`}
        >
          {device.hostName}
        </span>
        <span className="block truncate text-meta text-faint-foreground">
          {osName(device.os)} · {device.ip}
          {!device.online ? " · Offline" : device.parallax ? " · Runs Parallax" : ""}
        </span>
      </span>
      <button type="button" disabled={!device.online} className={primaryButton} onClick={onPick}>
        {device.parallax ? "Move here" : "Set up"}
      </button>
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
