import { Check, CircleCheck, Copy, Download, Hash, KeyRound, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { DeviceHost } from "../preload/bridge";
import { spacedCode } from "./AccountPrompts";
import { statusLabel, useConnection } from "./ConnectionStatus";
import { DeviceIcon } from "./DeviceIcon";
import { primaryButton, quietButton } from "./settings/parts";
import { IconButton } from "./ui";

/** Tailscale's OS name for people. */
export const osName = (os: string) =>
  ({ macOS: "macOS", windows: "Windows", linux: "Linux", iOS: "iOS", android: "Android" })[os] ??
  os;

/** The command that adds a computer to the account (0091), for this app's channel. */
export const connectCommand = (channel: "stable" | "nightly") =>
  `npx plx-cli connect${channel === "nightly" ? " --channel nightly" : ""}`;

/**
 * Add computer (0091), a modal dialog open while it's mounted: the command to run on the computer
 * to add, which signs it in to the account and shows a code, then this account's computers as
 * they show up, each connected, waiting for its code, or waiting for approval. Opening it asks the
 * account for its computers.
 */
export function ConnectWizard({
  channel,
  devices,
  onClose,
  onEnterCode,
}: {
  /** The channel it installs, this app's own. */
  channel: "stable" | "nightly";
  /** The devices this app lists. */
  devices: DeviceHost[];
  onClose: () => void;
  /** Opens the code dialog for a new computer. */
  onEnterCode: (device: DeviceHost) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => void window.parallax.discoverAccount(), []);
  const command = connectCommand(channel);
  const computers = devices.filter((d) => d.id.startsWith("account:"));

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[32rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-reading font-semibold">
              Add a computer
            </h2>
            <p className="mt-0.5 text-body text-muted-foreground">
              Run this in a terminal on the computer you want to add.
            </p>
          </div>
          <IconButton label="Close" onClick={() => dialog.current?.close()}>
            <X aria-hidden />
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background py-1.5 pr-1.5 pl-3">
            <code aria-label="Command" className="min-w-0 flex-1 truncate font-mono text-body">
              {command}
            </code>
            <IconButton
              label={copied ? "Copied" : "Copy command"}
              onClick={() => {
                void navigator.clipboard.writeText(command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              }}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </IconButton>
          </div>
          <ul className="rounded-lg border border-border">
            <Plan icon={<KeyRound aria-hidden />} title="Signs in to your Parallax account">
              In a browser there, or with a link you open on any device.
            </Plan>
            <Plan icon={<Download aria-hidden />} title="Installs plxd">
              Parallax's service, which starts at login, so your other computers reach it.
            </Plan>
            <Plan icon={<Hash aria-hidden />} title="Shows a 6-digit code">
              Type it here when Parallax asks, to let this computer in.
            </Plan>
          </ul>
          <section aria-label="Your computers">
            <h3 className="mb-1.5 text-body font-medium">Your computers</h3>
            {computers.length ? (
              <ul className="rounded-lg border border-border">
                {computers.map((d) => (
                  <ComputerRow key={d.id} device={d} onEnterCode={() => onEnterCode(d)} />
                ))}
              </ul>
            ) : (
              <p className="text-body text-muted-foreground">
                A computer shows up here once it's signed in.
              </p>
            )}
          </section>
        </div>
        <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
          <div className="flex-1">
            <button
              type="button"
              onClick={() => void window.parallax.discoverAccount()}
              className={`${quietButton} -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
            >
              <RefreshCw aria-hidden />
              Refresh
            </button>
          </div>
          <button type="button" className={primaryButton} onClick={() => dialog.current?.close()}>
            Done
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/** One account computer in Add computer: its name and where it stands. */
function ComputerRow({ device, onEnterCode }: { device: DeviceHost; onEnterCode: () => void }) {
  const state = useConnection(device.id);
  const { access } = device;
  const status = accessLabel(device) ?? (state ? statusLabel(state) : "Connecting…");
  return (
    <li className="flex items-center gap-3 border-border px-3 py-2.5 not-last:border-b">
      <DeviceIcon icon={device.icon} className="size-5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-body font-medium">{device.name}</p>
      {access?.step === "needsCode" ? (
        <button type="button" className={primaryButton} onClick={onEnterCode}>
          Enter code
        </button>
      ) : state?.status === "connected" ? (
        <span className="flex items-center gap-1 text-body text-added [&_svg]:size-3.5">
          <CircleCheck aria-hidden />
          Connected
        </span>
      ) : (
        <span className="text-body text-muted-foreground">{status}</span>
      )}
    </li>
  );
}

/** What an account computer's sign-in says while it isn't connected, or undefined. */
export function accessLabel({ access }: Pick<DeviceHost, "access">): string | undefined {
  switch (access?.step) {
    case "needsCode":
      return access.offline ? "Offline · needs the code it shows" : "Needs the code it shows";
    case "pairing":
    case "signingIn":
      return "Connecting…";
    case "pending":
      return `Allow this computer on another device · ${spacedCode(access.code)}`;
    case "ask":
      return access.why;
    default:
      return undefined;
  }
}

/** One thing a setup does, in a list of what it will do. */
export function Plan({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-border px-3 py-2.5 not-last:border-b [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      {icon}
      <span>
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-body text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}
