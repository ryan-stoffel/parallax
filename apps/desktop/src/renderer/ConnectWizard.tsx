import { t } from "i18next";
import { Check, CircleCheck, Copy, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";

import type { DeviceHost, SetupCode } from "../preload/bridge";
import {
  asksForCode,
  CompareCode,
  Modal,
  SetupCodeField,
  skipCodePrompt,
  spacedCode,
  useHoldCodePrompts,
  useSetupCode,
} from "./AccountPrompts";
import { statusLabel, useShownConnection } from "./ConnectionStatus";
import { DeviceIcon } from "./DeviceIcon";
import { useProfile } from "./profile";
import { primaryButton, quietButton } from "./settings/parts";
import { IconButton, Segmented } from "./ui";

/** Tailscale's OS name for people. */
export const osName = (os: string) =>
  ({ macOS: "macOS", windows: "Windows", linux: "Linux", iOS: "iOS", android: "Android" })[os] ??
  os;

/** Where Add computer's commands get their setup script (PLX-1307). */
const SCRIPTS = "https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts";

/**
 * The command that adds a computer to the account (0091), for this app's channel. Each needs nothing
 * installed: its script brings Node.js when the computer has none, and runs `plx connect`. Windows
 * reads its script as text, which the execution policy doesn't stop, from cmd or PowerShell. Keep
 * that form: Defender blocks `[scriptblock]::Create((irm ...))` as malicious. `device` is this
 * device's key, which reaches the new computer only through the user, never the relay, so that
 * computer can take this device's Allow alone. A key can start with `-`, so it's one `--device=`.
 */
export const connectCommand = (
  channel: "stable" | "nightly",
  os: "unix" | "windows",
  device?: string,
) => {
  const flags = `--channel ${channel}${device ? ` --device=${device}` : ""}`;
  return os === "windows"
    ? `powershell -c "irm ${SCRIPTS}/connect.ps1 | iex; Connect-Parallax ${flags}"`
    : `curl -fsSL ${SCRIPTS}/connect.sh | sh -s -- ${flags}`;
};

/**
 * Where this channel's app is downloaded. GitHub's `latest` only means stable, and its release list
 * starts with the newest nightly.
 */
export const downloadUrl = (channel: "stable" | "nightly") =>
  `https://github.com/ryan-stoffel/parallax/releases${channel === "stable" ? "/latest" : ""}`;

/** How often Add a computer asks the account for its computers while it's open (0091). */
const LOOK_MS = 5_000;

/**
 * Add a computer (0091), a modal dialog open while it's mounted. It says how to set the other
 * computer up, with the app or in a terminal, and asks the account for its computers every
 * `LOOK_MS`. A computer that shows a code to allow, or wants one typed, asks here, and the dialog
 * ends by showing the computers that joined.
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
  useHoldCodePrompts();
  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    void window.parallax.discoverAccount();
    const timer = setInterval(() => void window.parallax.discoverAccount(), LOOK_MS);
    return () => clearInterval(timer);
  }, []);
  const computers = devices.filter((d) => d.id.startsWith("account:"));
  // The computers this dialog isn't about: those on the account already when it opened, less any
  // still joining. Add another adds the ones it showed.
  const [known, setKnown] = useState(
    () => new Set(computers.filter((d) => !isNew(d.access)).map((d) => d.id)),
  );
  // Those whose code the user chose not to type now.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // A computer listed before it refused this app only turns out to be new once it does.
  const turnedNew = computers.filter((d) => known.has(d.id) && isNew(d.access));
  if (turnedNew.length) {
    const left = new Set(known);
    for (const d of turnedNew) left.delete(d.id);
    setKnown(left);
  }
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  // An offline computer's Enter code, for one whose code the dialog wouldn't ask for on its own.
  const [chosen, setChosen] = useState<string>();
  const found = computers.filter((d) => !known.has(d.id) && !dismissed.has(d.id));
  const asking =
    computers.find((d) => d.id === chosen && d.access) ?? found.find((d) => asksForCode(d));
  const finished = !asking && found.some((d) => connected.has(d.id));
  const close = () => {
    // Its prompt stays shut: the user just closed the screen that was asking.
    if (asking) skipCodePrompt(asking.id);
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={() => asking && skipCodePrompt(asking.id)}
      className="m-auto w-[32rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex items-center gap-3 px-5 pt-4 pb-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-reading font-semibold">
            {t("Add a computer")}
          </h2>
          <IconButton label={t("Close")} onClick={close}>
            <X aria-hidden />
          </IconButton>
        </header>
        {asking ? (
          <CodeStep
            key={asking.id}
            computer={asking}
            onCancel={() => {
              skipCodePrompt(asking.id);
              setChosen(undefined);
              setDismissed((old) => new Set(old).add(asking.id));
            }}
            onPaired={() => setChosen(undefined)}
          />
        ) : (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
            {finished ? <Finished /> : <Setup channel={channel} />}
            {found.length > 0 && (
              <ul aria-label={t("New computers")} className="rounded-lg border border-border">
                {found.map((d) => (
                  <ComputerRow
                    key={d.id}
                    device={d}
                    onEnterCode={() => setChosen(d.id)}
                    onConnected={() => setConnected((old) => new Set(old).add(d.id))}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
        {!asking && (
          <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
            {finished ? (
              <>
                <button
                  type="button"
                  className={`${quietButton} -ml-2.5 mr-auto`}
                  onClick={() => {
                    setKnown((old) => new Set([...old, ...found.map((d) => d.id)]));
                    setConnected(new Set());
                  }}
                >
                  {t("Add another")}
                </button>
                <button type="button" className={primaryButton} onClick={close}>
                  {t("Done")}
                </button>
              </>
            ) : (
              <>
                <span
                  role="status"
                  className="mr-auto flex items-center gap-2 text-body text-muted-foreground [&_svg]:size-3.5"
                >
                  <LoaderCircle aria-hidden className="animate-spin" />
                  {t("Looking for your computer…")}
                </span>
                <button type="button" className={quietButton} onClick={close}>
                  {t("Close")}
                </button>
              </>
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
}

/** Whether an account computer's `access` says it hasn't joined yet, so the dialog is about it. */
const isNew = (access: DeviceHost["access"]) =>
  access?.step === "needsCode" ||
  access?.step === "pairing" ||
  access?.step === "compare" ||
  access?.step === "confirm";

/** How to set the other computer up, with the app or in a terminal. */
function Setup({ channel }: { channel: "stable" | "nightly" }) {
  const [path, setPath] = useState<"app" | "terminal">("app");
  const email = useProfile()?.email;
  const [device, setDevice] = useState<string>();
  useEffect(() => void window.parallax.deviceKey().then(setDevice), []);
  return (
    <>
      <p className="text-body text-muted-foreground">
        {t(
          "Run agents on your other computers from here. Do this on the computer you want to add.",
        )}
      </p>
      <div className="flex">
        <Segmented
          label={t("How to add it")}
          value={path}
          onChange={setPath}
          options={[
            { value: "app", name: t("With the app") },
            { value: "terminal", name: t("In a terminal") },
          ]}
        />
      </div>
      {path === "app" ? (
        <ol className="rounded-lg border border-border">
          <Step n={1} title={t("Install Parallax")}>
            <Trans>
              <a href={downloadUrl(channel)} target="_blank" rel="noreferrer" className="underline">
                Download it
              </a>{" "}
              for macOS, Windows, or Linux.
            </Trans>
          </Step>
          <Step n={2} title={t("Sign in")}>
            {email ? t("Use the same account, {{email}}.", { email }) : t("Use the same account.")}
          </Step>
          <Step n={3} title={t("Choose Show setup code")}>
            {t(
              "It's in Settings › Connections there. Then allow the code it shows on both, or type it here.",
            )}
          </Step>
        </ol>
      ) : (
        <ol className="rounded-lg border border-border">
          <Step n={1} title={t("Run this there")}>
            <Command
              label={t("macOS or Linux")}
              command={connectCommand(channel, "unix", device)}
            />
            <Command label="Windows" command={connectCommand(channel, "windows", device)} />
            {t("Setup needs nothing installed, and works on a server or over SSH.")}
          </Step>
          <Step n={2} title={t("Sign in")}>
            {t("In a browser there, or with a link it prints that opens on any device.")}
          </Step>
          <Step n={3} title={t("Allow its code here")}>
            {t(
              "Parallax shows a code as soon as that computer is ready. Allow it if that computer shows the same.",
            )}
          </Step>
        </ol>
      )}
    </>
  );
}

/** What the dialog says once a new computer has connected. */
function Finished() {
  return (
    <div className="flex gap-3 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-added">
      <CircleCheck aria-hidden />
      <p className="text-body text-muted-foreground">
        <span className="block font-medium text-foreground">{t("You're connected")}</span>
        {t("Pick it under Runs on when you start a thread. Its threads show up in your sidebar.")}
      </p>
    </div>
  );
}

/** A new computer's code in the dialog, to allow or to type. */
function CodeStep({
  computer,
  onCancel,
  onPaired,
}: {
  computer: DeviceHost;
  onCancel: () => void;
  onPaired: () => void;
}) {
  const form = useSetupCode(computer, onPaired);
  const [typing, setTyping] = useState(false);
  const step = computer.access?.step;
  if (!typing && (step === "compare" || step === "confirm"))
    return (
      <div className="px-5 pb-4">
        <h3 className="flex items-center gap-2 text-body font-medium">
          <DeviceIcon icon={computer.icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{t("Found {{name}}", { name: computer.name })}</span>
        </h3>
        <CompareCode
          computer={computer}
          onDone={onPaired}
          onClosed={onCancel}
          onType={() => setTyping(true)}
        />
      </div>
    );
  return (
    <form onSubmit={(e) => void form.submit(e)} className="px-5 pb-4">
      <h3 className="flex items-center gap-2 text-body font-medium">
        <DeviceIcon icon={computer.icon} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{t("Found {{name}}", { name: computer.name })}</span>
      </h3>
      <SetupCodeField id={computer.id} name={computer.name} form={form} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onCancel}>
          {t("Not now")}
        </button>
        <button type="submit" className={primaryButton} disabled={!form.ready}>
          {form.busy ? t("Connecting…") : t("Connect")}
        </button>
      </div>
    </form>
  );
}

/** The command to run on `label`'s OS, with its Copy. */
function Command({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="my-1.5 block">
      <span className="block text-meta text-faint-foreground">{label}</span>
      <span className="mt-0.5 flex items-center gap-2 rounded-lg border border-border bg-background py-1 pr-1 pl-3">
        <code
          aria-label={t("Command for {{os}}", { os: label })}
          className="min-w-0 flex-1 font-mono text-body break-all"
        >
          {command}
        </code>
        <IconButton
          label={copied ? t("Copied") : t("Copy command for {{os}}", { os: label })}
          onClick={() => {
            void navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
      </span>
    </span>
  );
}

/** One new computer in Add a computer: its name and where it stands. */
function ComputerRow({
  device,
  onEnterCode,
  onConnected,
}: {
  device: DeviceHost;
  onEnterCode: () => void;
  onConnected: () => void;
}) {
  const state = useShownConnection(device.id);
  const { access } = device;
  const up = !access && state?.status === "connected";
  useEffect(() => {
    if (up) onConnected();
    // `onConnected` is new each render; only the connection coming up counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [up]);
  const status = accessLabel(device) ?? (state ? statusLabel(state) : t("Connecting…"));
  return (
    <li className="flex items-center gap-3 border-border px-3 py-2.5 not-last:border-b">
      <DeviceIcon icon={device.icon} className="size-5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-body font-medium">{device.name}</p>
      {up ? (
        <span className="flex items-center gap-1 text-body text-added [&_svg]:size-3.5">
          <CircleCheck aria-hidden />
          {t("Connected")}
        </span>
      ) : (
        <span className="text-body text-muted-foreground">{status}</span>
      )}
      {access?.step === "needsCode" && (
        <button type="button" className={quietButton} onClick={onEnterCode}>
          {t("Enter code")}
        </button>
      )}
      {access?.step === "ask" && (
        <button
          type="button"
          onClick={() => void window.parallax.askAgain(device.id)}
          className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <RefreshCw aria-hidden />
          {t("Ask again")}
        </button>
      )}
    </li>
  );
}

/** What an account computer's sign-in says while it isn't connected, or undefined. */
export function accessLabel({ access }: Pick<DeviceHost, "access">): string | undefined {
  switch (access?.step) {
    case "needsCode":
      return access.offline ? t("Waiting for it to come online") : t("Needs its setup code");
    case "pairing":
    case "signingIn":
      return t("Connecting…");
    case "compare":
      return t("Allow it if it shows {{code}}", { code: spacedCode(access.code) });
    case "confirm":
      return t("Confirm it there · {{code}}", { code: spacedCode(access.code) });
    case "pending":
      return t("Allow this computer on another device · {{code}}", {
        code: spacedCode(access.code),
      });
    case "ask":
      return access.why;
    case "offline":
      return t("Offline");
    default:
      return undefined;
  }
}

/** One numbered thing to do, in a list of them. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-border px-3 py-2.5 not-last:border-b">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-meta text-muted-foreground tabular-nums"
      >
        {n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-body text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/**
 * Show setup code (0091), a modal dialog open while it's mounted: readies this computer for
 * another to add it and shows the code to type there, a new one each time one lapses, until that
 * computer uses it.
 */
export function SetupCodeDialog({
  name,
  onReady,
  onClose,
}: {
  /** This computer's name. */
  name: string;
  /** Runs after each ask, which may change this computer's settings, so a page reads them again. */
  onReady: () => void;
  onClose: () => void;
}) {
  useHoldCodePrompts();
  const [shown, setShown] = useState<SetupCode | string>();
  const [approved, setApproved] = useState<string>();
  // Only the latest ask's answer shows: an older code stopped working when a newer one was made.
  const latest = useRef(0);
  const ask = async () => {
    const n = ++latest.current;
    setShown(undefined);
    const answer = await window.parallax.showSetupCode();
    if (n !== latest.current) return;
    setShown(answer);
    onReady();
  };
  useEffect(() => void ask(), []);
  useEffect(() => window.parallax.onSetupApproved(setApproved), []);
  const lapses = typeof shown === "object" ? Date.parse(shown.expiresAt) - Date.now() : undefined;
  useEffect(() => {
    if (lapses === undefined || approved) return;
    const timer = setTimeout(() => void ask(), Math.max(lapses, 1_000));
    return () => clearTimeout(timer);
  }, [lapses, approved]);

  return (
    <Modal
      title={approved ? t("{{name}} is connected", { name }) : t("Show setup code")}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {approved ? (
        <p className="mt-1.5 text-body text-muted-foreground">
          {t("{{computer}} can reach {{name}} now, and so can your other signed-in computers.", {
            computer: approved,
            name,
          })}
        </p>
      ) : typeof shown === "string" ? (
        <p role="alert" className="mt-2 text-body text-danger">
          {shown}
        </p>
      ) : shown ? (
        <>
          <p className="mt-1.5 text-body text-muted-foreground">
            {t(
              "Type this in Parallax on your other computer. It asks when it finds {{name}}, or choose Enter code beside {{name}} in Settings › Connections there.",
              { name },
            )}
          </p>
          <p
            aria-label={t("Code", { context: "pairing code" })}
            className="mt-3 rounded-md border border-border py-2 text-center font-mono text-xl tracking-[0.3em] tabular-nums"
          >
            {spacedCode(shown.code)}
          </p>
          <p className="mt-2 text-meta text-faint-foreground">
            {t(
              "Works once, for 10 minutes. This keeps Reach from anywhere and pairing on, so your signed-in computers can reach {{name}}.",
              { name },
            )}
          </p>
        </>
      ) : (
        <p
          role="status"
          className="mt-1.5 flex items-center gap-2 text-body text-muted-foreground [&_svg]:size-3.5"
        >
          <LoaderCircle aria-hidden className="animate-spin" />
          {t("Getting {{name}} ready…", { name })}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {!approved && shown !== undefined && (
          <button type="button" className={quietButton} onClick={() => void ask()}>
            {typeof shown === "string" ? t("Try again") : t("New code")}
          </button>
        )}
        <button type="submit" className={primaryButton}>
          {t("Done")}
        </button>
      </div>
    </Modal>
  );
}
