import { ArrowLeft, CircleCheck, CircleX, RefreshCw, Smartphone, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";

import { iconFor } from "../preload/bridge";
import type { ConnectDevicesResult, TailnetDevice } from "../protocol/generated/protocol";
import { DeviceIcon } from "./DeviceIcon";
import { localId } from "./hosts";
import { field, primaryButton, quietButton } from "./settings/parts";
import { IconButton } from "./ui";

const TerminalView = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalView })));

/** The OSes Parallax runs on, as Tailscale names them. */
const installable = new Set(["macOS", "windows", "linux"]);

/** Tailscale's OS name for people. */
export const osName = (os: string) =>
  ({ macOS: "macOS", windows: "Windows", linux: "Linux", iOS: "iOS", android: "Android" })[os] ??
  os;

type Step =
  | { kind: "list" }
  | { kind: "confirm"; device: TailnetDevice }
  | { kind: "install"; device: TailnetDevice; user?: string; run: number }
  | { kind: "done"; device: TailnetDevice }
  | { kind: "failed"; device: TailnetDevice; user?: string; run: number; why?: string };

/**
 * Add computer (0056), a modal dialog open while it's mounted: the user's devices on the tailnet,
 * from the local plxd's `connect/devices`; then, for one, what `plx-connect add` will do there;
 * then that command in a terminal, where ssh can ask for a password; then whether it worked, with
 * Add another and Done.
 */
export function ConnectWizard({
  channel,
  onClose,
}: {
  /** The channel it installs, this app's own. */
  channel: "stable" | "nightly";
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [found, setFound] = useState<ConnectDevicesResult | string>();
  const [user, setUser] = useState("");

  const look = useCallback(async () => {
    setFound(undefined);
    const answer = await window.parallax.request(localId, "connect/devices", {});
    setFound("error" in answer ? answer.error.message : answer.result);
  }, []);
  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => void look(), [look]);

  const close = () => dialog.current?.close();
  const app = channel === "nightly" ? "Parallax (Nightly)" : "Parallax";
  const start = (device: TailnetDevice, run = 0) =>
    setStep({ kind: "install", device, ...(user.trim() && { user: user.trim() }), run });

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[40rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          {(step.kind === "confirm" || step.kind === "failed") && (
            <IconButton label="Back" onClick={() => setStep({ kind: "list" })}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          <div className="flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {step.kind === "list" ? "Add a computer" : `Set up ${step.device.hostName}`}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {step.kind === "list"
                ? "Your computers on Tailscale. Pick one to set up Parallax there."
                : `${osName(step.device.os)} · ${step.device.ip}`}
            </p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X aria-hidden />
          </IconButton>
        </div>

        {step.kind === "list" && (
          <DeviceList
            found={found}
            onRefresh={() => void look()}
            onPick={(device) => setStep({ kind: "confirm", device })}
          />
        )}

        {step.kind === "confirm" && (
          <form
            className="flex flex-col gap-3 px-5 pb-4"
            onSubmit={(e) => {
              e.preventDefault();
              start(step.device);
            }}
          >
            <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-3">
              <DeviceIcon
                icon={iconFor(step.device.hostName)}
                className="size-6 text-muted-foreground"
              />
              <div className="text-[13px]">
                <p className="font-medium">{step.device.hostName} needs plx-connect</p>
                <p className="text-muted-foreground">
                  Parallax signs in to it over SSH at {step.device.ip}, checks its OS, and installs{" "}
                  {app}, plxd, and plx-connect. Then it turns on Parallax Connect there, so every
                  computer sees its threads.
                </p>
              </div>
            </div>
            <label className="text-[12.5px] text-muted-foreground">
              SSH user
              <input
                name="user"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="Same as here, or your ssh config's"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className={field}
              />
              <span className="mt-1 block text-faint-foreground">
                If it asks for a password, type it in the terminal. It's only sent to that computer.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={quietButton}
                onClick={() => setStep({ kind: "list" })}
              >
                Back
              </button>
              <button type="submit" className={primaryButton}>
                Install
              </button>
            </div>
          </form>
        )}

        {(step.kind === "install" || step.kind === "failed") && (
          <div className="flex flex-col gap-3 px-5 pb-4">
            {step.kind === "failed" && (
              <p
                role="alert"
                className="flex items-center gap-2 text-[13px] text-danger [&_svg]:size-4"
              >
                <CircleX aria-hidden />
                {step.why ?? `${step.device.hostName} wasn't set up. The terminal says why.`}
              </p>
            )}
            {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
            <div className="h-72 rounded-md border border-border bg-surface p-2">
              <Suspense>
                <TerminalView
                  key={`${step.device.id}-${step.run}`}
                  id="connect-add"
                  target={{
                    hostId: localId,
                    connect: { device: step.device.ip, ...(step.user && { user: step.user }) },
                  }}
                  label={`Setting up ${step.device.hostName}`}
                  onEnd={(why, exitCode) => {
                    if (step.kind !== "install") return;
                    if (!why && exitCode === 0)
                      return setStep({ kind: "done", device: step.device });
                    setStep({ ...step, kind: "failed", ...(why && { why }) });
                  }}
                />
              </Suspense>
            </div>
            <div className="flex justify-end gap-2">
              {step.kind === "failed" ? (
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => start(step.device, step.run + 1)}
                >
                  Try again
                </button>
              ) : (
                <span className="text-[12.5px] text-muted-foreground">Setting up…</span>
              )}
            </div>
          </div>
        )}

        {step.kind === "done" && (
          <div className="flex flex-col items-center gap-2 px-5 pt-4 pb-5 text-center">
            <CircleCheck aria-hidden className="size-9 text-added" />
            <p className="text-[14px] font-medium">{step.device.hostName} is connected</p>
            <p className="max-w-sm text-[12.5px] text-muted-foreground">
              {app} and plxd are installed, and Parallax Connect is on. Its threads show up here,
              and this computer's show up there.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={quietButton}
                onClick={() => {
                  setStep({ kind: "list" });
                  void look();
                }}
              >
                Add another computer
              </button>
              <button type="button" className={primaryButton} onClick={close}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

/** The tailnet's devices: online ones Parallax can run on first, each with Set up or where it is. */
function DeviceList({
  found,
  onRefresh,
  onPick,
}: {
  found?: ConnectDevicesResult | string;
  onRefresh: () => void;
  onPick: (device: TailnetDevice) => void;
}) {
  const note = (text: string) => (
    <p className="px-5 pb-5 text-[13px] text-muted-foreground">{text}</p>
  );
  if (found === undefined) return note("Looking for your computers…");
  if (typeof found === "string") return note(`Parallax couldn't ask Tailscale: ${found}`);
  if (found.tailscale === "missing")
    return note(
      "Tailscale isn't installed on this computer. Install it from tailscale.com, sign in, then come back.",
    );
  if (found.tailscale !== "running")
    return note("Tailscale isn't running on this computer. Open it and sign in, then come back.");
  const rank = (d: TailnetDevice) => (d.online && installable.has(d.os) ? 0 : d.online ? 1 : 2);
  const devices = [...found.devices].sort((a, b) => rank(a) - rank(b));
  return (
    <div className="flex min-h-0 flex-col">
      <ul
        aria-label="Your computers"
        className="mx-5 min-h-0 overflow-y-auto rounded-lg border border-border"
      >
        {devices.map((device) => {
          const canRun = installable.has(device.os);
          const tone = device.online ? "text-muted-foreground" : "text-faint-foreground";
          return (
            <li
              key={device.id}
              className="flex items-center gap-3 border-border px-3 py-2.5 not-last:border-b"
            >
              {/* A phone or tablet gets a phone; Parallax only runs on the others. */}
              {canRun ? (
                <DeviceIcon icon={iconFor(device.hostName)} className={`size-5 shrink-0 ${tone}`} />
              ) : (
                <Smartphone aria-hidden className={`size-5 shrink-0 ${tone}`} />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-[13px] font-medium ${device.online ? "" : "text-muted-foreground"}`}
                >
                  {device.hostName}
                </p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {osName(device.os)} · {device.ip}
                  {!device.online && " · Offline"}
                </p>
              </div>
              {device.parallax ? (
                <span className="flex items-center gap-1 text-[12.5px] text-added [&_svg]:size-3.5">
                  <CircleCheck aria-hidden />
                  Connected
                </span>
              ) : !canRun ? (
                <span className="text-[12.5px] text-faint-foreground">Can't run Parallax</span>
              ) : (
                <button
                  type="button"
                  disabled={!device.online}
                  className={primaryButton}
                  onClick={() => onPick(device)}
                >
                  Set up
                </button>
              )}
            </li>
          );
        })}
        {!devices.length && (
          <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">
            No other computers on your tailnet yet.
          </li>
        )}
      </ul>
      <div className="flex items-center justify-between px-5 pt-3 pb-4">
        <button
          type="button"
          onClick={onRefresh}
          className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <RefreshCw aria-hidden />
          Refresh
        </button>
        <span className="text-[12px] text-faint-foreground">
          {found.self ? `This computer: ${found.self.hostName}` : ""}
        </span>
      </div>
    </div>
  );
}
