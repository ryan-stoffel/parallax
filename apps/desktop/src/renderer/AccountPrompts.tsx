import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";

import type { AccessPrompt, DeviceHost } from "../preload/bridge";
import { DeviceIcon } from "./DeviceIcon";
import { primaryButton, quietButton } from "./settings/parts";

/** 6 digits as both ends show them: "123 456". */
export const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** How many setup screens are open, and the computers they've already asked about. */
let holds = { open: 0, asked: new Set<string>() };
const holdWatchers = new Set<() => void>();
const setHolds = (next: typeof holds) => {
  holds = next;
  for (const watcher of holdWatchers) watcher();
};
const watchHolds = (watcher: () => void) => {
  holdWatchers.add(watcher);
  return () => holdWatchers.delete(watcher);
};

/**
 * Holds back the prompt for a new computer's code while the calling screen is mounted, since that
 * screen handles codes itself, as Add a computer does, or shows this computer's own.
 */
export function useHoldCodePrompts() {
  useEffect(() => {
    setHolds({ ...holds, open: holds.open + 1 });
    return () => setHolds({ ...holds, open: holds.open - 1 });
  }, []);
}

/** Keeps the prompt for computer `id` shut after a setup screen already asked for its code. */
export const skipCodePrompt = (id: string) =>
  setHolds({ ...holds, asked: new Set(holds.asked).add(id) });

/**
 * The prompts account sign-in raises anywhere in the app (0091): a new computer's code, asked
 * for when one shows up on the account and answers (an offline one waits in Settings >
 * Connections), and "Allow <device>?" when one of the user's devices
 * asks to sign in. One at a time, a device's request first. Closing one leaves it for Settings >
 * Connections, which shows the computer's state and asks for its code again.
 */
export function AccountPrompts() {
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  const [requests, setRequests] = useState<AccessPrompt[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => window.parallax.onDevices(setDevices), []);
  useEffect(() => window.parallax.onAccessRequests(setRequests), []);
  const close = (id: string) => setClosed((old) => new Set(old).add(id));
  const held = useSyncExternalStore(watchHolds, () => holds);

  const request = requests.find((r) => !closed.has(r.id));
  if (request)
    return <AllowDialog key={request.id} request={request} onClose={() => close(request.id)} />;
  const computer = held.open
    ? undefined
    : devices.find((d) => asksForCode(d) && !closed.has(d.id) && !held.asked.has(d.id));
  if (computer)
    return (
      <NewComputerDialog key={computer.id} computer={computer} onClose={() => close(computer.id)} />
    );
  return null;
}

/** Whether computer `d` is waiting on its code now and answers, so a screen can ask for it. */
export const asksForCode = (d: Pick<DeviceHost, "access">) =>
  (d.access?.step === "needsCode" && !d.access.offline) || d.access?.step === "pairing";

/** A small modal, as the app's confirmations are, shown while it's mounted. */
export function Modal({
  title,
  icon,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[24rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form onSubmit={onSubmit} className="px-5 pt-4 pb-4">
        <h2 id={titleId} className="flex items-center gap-2 text-reading font-semibold">
          {icon}
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        {children}
      </form>
    </dialog>
  );
}

/**
 * Typing a new computer's 6-digit code (0091): what the field holds, and pairing with it. Typing
 * proves the user saw that computer's screen. Each code is good for one try, so a wrong one is
 * cleared. `onPaired` runs once it pairs.
 */
export function useSetupCode(computer: Pick<DeviceHost, "id" | "access">, onPaired: () => void) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    computer.access?.step === "needsCode" ? computer.access.error : undefined,
  );
  const digits = code.replace(/\D/g, "");
  const ready = digits.length === 6 && !busy;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    const failed = await window.parallax.enterSetupCode(computer.id, digits);
    setBusy(false);
    if (!failed) return onPaired();
    setError(failed);
    setCode("");
  };
  return { code, setCode, busy, error, ready, submit };
}

/** The field for a setup code, what to type there, and where to find the code. */
export function SetupCodeField({
  name,
  form: { code, setCode, busy, error },
}: {
  name: string;
  form: ReturnType<typeof useSetupCode>;
}) {
  return (
    <>
      <p className="mt-1.5 text-body text-muted-foreground">Type the 6-digit code {name} shows.</p>
      <input
        aria-label="Code"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000 000"
        spellCheck={false}
        disabled={busy}
        className="mt-3 block w-full rounded-md border border-border bg-background px-3 py-2 text-center font-mono text-xl tracking-[0.3em] tabular-nums placeholder:text-faint-foreground"
      />
      {error && (
        <p role="alert" className="mt-2 text-body text-danger">
          {error}
        </p>
      )}
      <p className="mt-2 text-meta text-faint-foreground">
        No code there? In Parallax on {name}, choose Show setup code in Settings › Connections.
        Without the app, run <code className="font-mono">npx plx-cli connect approve</code>.
      </p>
    </>
  );
}

/** A new computer on the account asks for its code (0091), in a dialog of its own. */
export function NewComputerDialog({
  computer,
  onClose,
}: {
  computer: Pick<DeviceHost, "id" | "name" | "icon" | "access">;
  onClose: () => void;
}) {
  const form = useSetupCode(computer, onClose);
  return (
    <Modal
      title={`Connect ${computer.name}`}
      icon={<DeviceIcon icon={computer.icon} className="size-4 shrink-0 text-muted-foreground" />}
      onClose={onClose}
      onSubmit={(e) => void form.submit(e)}
    >
      <SetupCodeField name={computer.name} form={form} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={primaryButton} disabled={!form.ready}>
          {form.busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * One of the user's devices asks to sign in to their computers (0091). Allow only if that device
 * shows the same code: a request the user didn't start, or another code, is someone else's.
 */
export function AllowDialog({ request, onClose }: { request: AccessPrompt; onClose: () => void }) {
  const [busy, setBusy] = useState<"allow" | "deny">();
  const [error, setError] = useState<string>();
  const answer = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    const failed = await window.parallax.answerAccess(request.id, allow);
    setBusy(undefined);
    if (failed) setError(failed);
    else onClose();
  };
  return (
    <Modal
      title={`Allow ${request.name}?`}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        void answer(true);
      }}
    >
      <p className="mt-1.5 text-body text-muted-foreground">
        It's asking to use your computers{request.host && `, starting with ${request.host}`}. Allow
        it only if {request.name} shows this code.
      </p>
      <p
        aria-label="Code"
        className="mt-3 rounded-md border border-border py-2 text-center font-mono text-xl tracking-[0.3em] tabular-nums"
      >
        {spacedCode(request.code)}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-body text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className={quietButton}
          disabled={!!busy}
          onClick={() => void answer(false)}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
        <button type="submit" className={primaryButton} disabled={!!busy}>
          {busy === "allow" ? "Allowing…" : "Allow"}
        </button>
      </div>
    </Modal>
  );
}
