import {
  ArrowLeft,
  CircleCheck,
  CircleX,
  Download,
  KeyRound,
  Network,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { iconFor, type DeviceHost } from "../preload/bridge";
import type { ConnectDevicesResult, TailnetDevice } from "../protocol/generated/protocol";
import { DeviceIcon } from "./DeviceIcon";
import { localId } from "./hosts";
import { primaryButton, quietButton, rowField } from "./settings/parts";
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
 * Add another computer and Done. A device that already runs Connect but isn't in `devices`, such
 * as one removed here, gets Add instead of Set up.
 */
export function ConnectWizard({
  channel,
  devices,
  onClose,
}: {
  /** The channel it installs, this app's own. */
  channel: "stable" | "nightly";
  /** The devices this app lists. */
  devices: DeviceHost[];
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
  const back = () => setStep({ kind: "list" });
  const device = step.kind === "list" ? undefined : step.device;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[36rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          {(step.kind === "confirm" || step.kind === "failed") && (
            <IconButton label="Back" onClick={back}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          {device && step.kind !== "done" && (
            <DeviceIcon
              icon={iconFor(device.hostName)}
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            />
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-semibold">
              {!device
                ? "Add a computer"
                : step.kind === "done"
                  ? `${device.hostName} is set up`
                  : `Set up ${device.hostName}`}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {device
                ? `${osName(device.os)} · ${device.ip}`
                : "Your computers on Tailscale. Pick one to set up Parallax there."}
            </p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X aria-hidden />
          </IconButton>
        </header>

        {step.kind === "list" && (
          <DeviceList
            found={found}
            devices={devices}
            onRefresh={() => void look()}
            onPick={(d) => setStep({ kind: "confirm", device: d })}
            onAdd={(d) => void window.parallax.setDeviceEnabled(`tailnet:${d.id}`, true)}
          />
        )}

        {step.kind === "confirm" && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              start(step.device);
            }}
          >
            <div className="flex flex-col gap-3 px-5 pb-4">
              <ul className="rounded-lg border border-border">
                <Plan icon={<KeyRound aria-hidden />} title="Signs in over SSH">
                  To {step.device.ip}. If it asks for a password, type it in the terminal. It goes
                  only to {step.device.hostName}.
                </Plan>
                <Plan icon={<Download aria-hidden />} title={`Installs ${app} and plxd`}>
                  The newest {channel} build for its OS, and plx-connect when npm is there.
                </Plan>
                <Plan icon={<Network aria-hidden />} title="Turns on Parallax Connect">
                  So every computer sees its threads, and it sees theirs.
                </Plan>
              </ul>
              <label className="flex items-center justify-between gap-4 text-[13px]">
                <span>
                  <span className="block font-medium">SSH user</span>
                  <span className="block text-[12.5px] text-muted-foreground">
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
                Install
              </button>
            </Footer>
          </form>
        )}

        {(step.kind === "install" || step.kind === "failed") && (
          <>
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
            </div>
            <Footer>
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
            </Footer>
          </>
        )}

        {step.kind === "done" && (
          <>
            <div className="flex flex-col gap-3 px-5 pb-4">
              <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
                <DeviceIcon
                  icon={iconFor(step.device.hostName)}
                  className="size-5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium">{step.device.hostName}</p>
                  <p className="truncate text-[12.5px] text-muted-foreground">
                    {app} · plxd · Parallax Connect on
                  </p>
                </div>
                <span className="flex items-center gap-1 text-[12.5px] text-added [&_svg]:size-3.5">
                  <CircleCheck aria-hidden />
                  Connected
                </span>
              </div>
              <p className="text-[12.5px] text-muted-foreground">
                Its threads show up in your sidebar, and this computer's show up there.
              </p>
            </div>
            <Footer>
              <button
                type="button"
                className={quietButton}
                onClick={() => {
                  back();
                  void look();
                }}
              >
                Add another computer
              </button>
              <button type="button" className={primaryButton} onClick={close}>
                Done
              </button>
            </Footer>
          </>
        )}
      </div>
    </dialog>
  );
}

/** The wizard's footer: `start` on the left, its buttons on the right, under a rule. */
function Footer({ children, start }: { children: ReactNode; start?: ReactNode }) {
  return (
    <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
      <div className="flex-1">{start}</div>
      {children}
    </footer>
  );
}

/** One thing `plx-connect add` does, in Set up's list. */
function Plan({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-border px-3 py-2.5 not-last:border-b [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <span>
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[12.5px] text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/**
 * The tailnet's devices: online ones Parallax can run on first, each with Set up, or Connected
 * when this app lists it, or Add when it runs Connect but isn't listed here.
 */
function DeviceList({
  found,
  devices,
  onRefresh,
  onPick,
  onAdd,
}: {
  found?: ConnectDevicesResult | string;
  devices: DeviceHost[];
  onRefresh: () => void;
  onPick: (device: TailnetDevice) => void;
  onAdd: (device: TailnetDevice) => void;
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
  const sorted = [...found.devices].sort((a, b) => rank(a) - rank(b));
  const listed = (d: TailnetDevice) => devices.some((h) => h.id === `tailnet:${d.id}`);
  return (
    <>
      <ul
        aria-label="Your computers"
        className="mx-5 mb-4 min-h-0 overflow-y-auto rounded-lg border border-border"
      >
        {sorted.map((device) => {
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
              {device.parallax && listed(device) ? (
                <span className="flex items-center gap-1 text-[12.5px] text-added [&_svg]:size-3.5">
                  <CircleCheck aria-hidden />
                  Connected
                </span>
              ) : device.parallax ? (
                <button type="button" className={primaryButton} onClick={() => onAdd(device)}>
                  Add
                </button>
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
        {!sorted.length && (
          <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">
            No other computers on your tailnet yet.
          </li>
        )}
      </ul>
      <Footer
        start={
          <button
            type="button"
            onClick={onRefresh}
            className={`${quietButton} -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <RefreshCw aria-hidden />
            Refresh
          </button>
        }
      >
        <span className="text-[12px] text-faint-foreground">
          {found.self ? `This computer: ${found.self.hostName}` : ""}
        </span>
      </Footer>
    </>
  );
}
