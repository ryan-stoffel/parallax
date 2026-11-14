import { t } from "i18next";
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
  // The computer whose code just worked, until the user closes the confirmation.
  const [added, setAdded] = useState<string>();
  const close = (id: string) => setClosed((old) => new Set(old).add(id));
  const held = useSyncExternalStore(watchHolds, () => holds);

  if (added) return <AddedDialog name={added} onClose={() => setAdded(undefined)} />;
  const request = requests.find((r) => !closed.has(r.id));
  if (request)
    return <AllowDialog key={request.id} request={request} onClose={() => close(request.id)} />;
  const computer = held.open
    ? undefined
    : devices.find((d) => asksForCode(d) && !closed.has(d.id) && !held.asked.has(d.id));
  if (computer)
    return (
      <NewComputerDialog
        key={computer.id}
        computer={computer}
        onClose={() => close(computer.id)}
        onAdded={() => setAdded(computer.name)}
      />
    );
  return null;
}

/** Whether computer `d` is waiting on its code now and answers, so a screen can ask for it. */
export const asksForCode = (d: Pick<DeviceHost, "access">) =>
  (d.access?.step === "needsCode" && !d.access.offline && !d.access.quiet) ||
  d.access?.step === "pairing" ||
  d.access?.step === "compare" ||
  d.access?.step === "confirm";

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
  const [typedError, setError] = useState<string>();
  // Why a comparison ended, which can happen while this form is already mounted.
  const error =
    typedError ?? (computer.access?.step === "needsCode" ? computer.access.error : undefined);
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

/**
 * A new computer's code to compare (0091), with Allow. The computer shows the same code, so a
 * different one, or none, means something else is answering. Enter does nothing here, so a stray
 * key press can't allow it. `onDone` runs once this device is in, and `onClosed` once it's denied.
 */
export function CompareCode({
  computer,
  onDone,
  onClosed,
  onType,
}: {
  computer: Pick<DeviceHost, "id" | "name" | "access">;
  onDone: () => void;
  onClosed: () => void;
  /** Shows the typed setup code instead. */
  onType: () => void;
}) {
  const [busy, setBusy] = useState<"allow" | "deny">();
  const [error, setError] = useState<string>();
  const access = computer.access;
  if (access?.step !== "compare" && access?.step !== "confirm") return null;
  const answer = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    setError(undefined);
    const failed = await window.parallax.answerCompare(computer.id, allow);
    setBusy(undefined);
    if (failed) setError(failed);
    else if (allow) onDone();
    else onClosed();
  };
  return (
    <>
      <p className="mt-1.5 text-body text-muted-foreground">
        {access.step === "confirm"
          ? t("Press Enter in {{name}}'s terminal, or Allow in its Parallax, to finish.", {
              name: computer.name,
            })
          : t(
              "Allow it only if {{name}} shows this code, in its terminal or its Parallax. Another code, or none, means something else is answering.",
              { name: computer.name },
            )}
      </p>
      <p
        aria-label={t("Code", { context: "pairing code" })}
        className="mt-3 rounded-md border border-border py-2 text-center font-mono text-xl tracking-[0.3em] tabular-nums"
      >
        {spacedCode(access.code)}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-body text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" className={`${quietButton} -ml-2.5 mr-auto`} onClick={onType}>
          {t("Type a code instead")}
        </button>
        <button
          type="button"
          className={quietButton}
          disabled={busy === "deny"}
          onClick={() => void answer(false)}
        >
          {busy === "deny" ? t("Denying…") : t("Deny")}
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={!!busy || access.step === "confirm"}
          onClick={() => void answer(true)}
        >
          {busy === "allow" || access.step === "confirm" ? t("Waiting…") : t("Allow")}
        </button>
      </div>
    </>
  );
}

/** The field for a setup code, what to type there, and where to find the code. */
export function SetupCodeField({
  id,
  name,
  form: { code, setCode, busy, error },
}: {
  id: string;
  name: string;
  form: ReturnType<typeof useSetupCode>;
}) {
  return (
    <>
      <p className="mt-1.5 text-body text-muted-foreground">
        {t("Type the 6-digit code showing on {{name}}, in its terminal or its Parallax.", { name })}
      </p>
      <input
        aria-label={t("Code", { context: "pairing code" })}
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
        {t(
          "No code there? Run the setup command on {{name}} again, or in Parallax there, choose Show setup code in Settings › Connections.",
          { name },
        )}{" "}
        <button
          type="button"
          className="underline"
          disabled={busy}
          onClick={() => void window.parallax.askAgain(id)}
        >
          {t("Compare codes instead")}
        </button>
      </p>
    </>
  );
}

/** A new computer on the account shows a code to allow, or asks for one typed (0091). */
export function NewComputerDialog({
  computer,
  onClose,
  onAdded = onClose,
}: {
  computer: Pick<DeviceHost, "id" | "name" | "icon" | "access">;
  onClose: () => void;
  /** Runs once its code works. */
  onAdded?: () => void;
}) {
  const form = useSetupCode(computer, onAdded);
  const [typing, setTyping] = useState(false);
  const step = computer.access?.step;
  const icon = (
    <DeviceIcon icon={computer.icon} className="size-4 shrink-0 text-muted-foreground" />
  );
  if (!typing && (step === "compare" || step === "confirm"))
    return (
      <Modal
        title={t("Add {{name}}?", { name: computer.name })}
        icon={icon}
        onClose={onClose}
        onSubmit={(e) => e.preventDefault()}
      >
        <CompareCode
          computer={computer}
          onDone={onAdded}
          onClosed={onClose}
          onType={() => setTyping(true)}
        />
      </Modal>
    );
  return (
    <Modal
      title={t("Add {{name}}", { name: computer.name })}
      icon={icon}
      onClose={onClose}
      onSubmit={(e) => void form.submit(e)}
    >
      <SetupCodeField id={computer.id} name={computer.name} form={form} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>
          {t("Cancel")}
        </button>
        <button type="submit" className={primaryButton} disabled={!form.ready}>
          {form.busy ? t("Connecting…") : t("Connect")}
        </button>
      </div>
    </Modal>
  );
}

/** Says a new computer's code worked, the end of adding it. */
function AddedDialog({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <Modal
      title={t("{{name}} is added", { name })}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <p className="mt-1.5 text-body text-muted-foreground">
        {t("Pick it under Runs on when you start a thread. Its threads show up in your sidebar.")}
      </p>
      <div className="mt-4 flex justify-end">
        <button type="submit" className={primaryButton} autoFocus>
          {t("Done")}
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
      title={t("Allow {{name}}?", { name: request.name })}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        void answer(true);
      }}
    >
      <p className="mt-1.5 text-body text-muted-foreground">
        {request.host
          ? t(
              "It's asking to use your computers, starting with {{host}}. Allow it only if {{name}} shows this code.",
              { host: request.host, name: request.name },
            )
          : t("It's asking to use your computers. Allow it only if {{name}} shows this code.", {
              name: request.name,
            })}
      </p>
      <p
        aria-label={t("Code", { context: "pairing code" })}
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
          {busy === "deny" ? t("Denying…") : t("Deny")}
        </button>
        <button type="submit" className={primaryButton} disabled={!!busy}>
          {busy === "allow" ? t("Allowing…") : t("Allow")}
        </button>
      </div>
    </Modal>
  );
}
